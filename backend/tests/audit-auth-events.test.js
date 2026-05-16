/**
 * @module tests/audit-auth-events
 * @description SEC-007 — per-event capture tests for the 8 password-path
 * `auth.*` activity emissions added under SEC-007.
 *
 * Every audited auth event MUST persist:
 *   - the correct `type` literal
 *   - the acting `userId` (or null for failed-login probes against unknown emails)
 *   - the client `ipAddress` (from `req.ip`)
 *   - the client `userAgent` (from `req.get("user-agent")`)
 *
 * Without IP + UA, a SOC 2 reviewer cannot reconstruct a session from the
 * audit trail. This file is the automated evidence that those columns
 * are populated for every event.
 *
 * Companion to `tests/audit-log-routes.test.js`, which covers the route
 * surface (hash chain, retention, DLQ, exports, meta-audit).
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import workspacesRouter from "../src/routes/workspaces.js";
import settingsRouter from "../src/routes/settings.js";
import { createTestContext, parseCookies, buildCookieHeader } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;

// Fixed User-Agent so we can assert exact-match on the captured column.
// SOC 2 evidence requires the UA captured at emission time, verbatim.
const TEST_UA = "audit-test-agent/1.0";

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1", requireAuth, workspaceScope, settingsRouter);
  app.use("/api/v1/workspaces", requireAuth, workspaceScope, workspacesRouter);
  mounted = true;
}

/** Find the latest activity row of a given type for a userId. */
function latestRow(db, userId, type) {
  return db.prepare(
    "SELECT * FROM activities WHERE userId = ? AND type = ? ORDER BY createdAt DESC, id DESC LIMIT 1",
  ).get(userId, type);
}

/** Assert that a row captured both IP and User-Agent. */
function assertCaptured(row, expectedType) {
  assert.ok(row, `expected an activity row for type=${expectedType}`);
  assert.equal(row.type, expectedType);
  // SOC 2 session-reconstruction requirement: both ipAddress and userAgent
  // must be present and non-empty.
  assert.ok(row.ipAddress, "ipAddress must be captured");
  assert.equal(row.userAgent, TEST_UA, "userAgent must be the verbatim header");
}

async function setupUser(baseUrl, suffix) {
  const email = `auth-evt-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const password = "Password123!";
  let res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": TEST_UA },
    body: JSON.stringify({ name: "Audit Evt User", email, password }),
  });
  assert.equal(res.status, 201, "register failed");
  res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": TEST_UA },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, "login failed");
  const cookies = parseCookies(res);
  return {
    email, password,
    csrf: cookies._csrf.value,
    cookieHeader: buildCookieHeader(cookies),
    user: (await res.json()).user,
  };
}

async function main() {
  mountRoutesOnce();
  t.resetDb();

  const env = t.setupEnv({
    SKIP_EMAIL_VERIFICATION: "true",
    RATE_LIMIT_TEST_MODE: "true",
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const runner = t.createTestRunner();
  const { test, summary } = runner;

  try {
    // ── auth.login ───────────────────────────────────────────────────────
    console.log("\n🔑 auth.login — successful sign-in captures IP + UA");

    await test("auth.login row is created on successful password login", async () => {
      const u = await setupUser(baseUrl, "login-ok");
      // setupUser already performed one login; assert that row exists.
      const row = latestRow(t.getDatabase(), u.user.id, "auth.login");
      assertCaptured(row, "auth.login");
      assert.equal(row.userId, u.user.id);
    });

    // ── auth.login.failed ────────────────────────────────────────────────
    console.log("\n🚫 auth.login.failed — bad-credentials probes are audited");

    await test("auth.login.failed row created with userId for wrong password on known user", async () => {
      const u = await setupUser(baseUrl, "login-bad-pw");
      const db = t.getDatabase();
      const before = db.prepare(
        "SELECT COUNT(*) AS cnt FROM activities WHERE type = 'auth.login.failed' AND userId = ?",
      ).get(u.user.id).cnt;
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": TEST_UA },
        body: JSON.stringify({ email: u.email, password: "WrongPassword!" }),
      });
      assert.equal(res.status, 401);
      const after = db.prepare(
        "SELECT COUNT(*) AS cnt FROM activities WHERE type = 'auth.login.failed' AND userId = ?",
      ).get(u.user.id).cnt;
      assert.equal(after, before + 1, "exactly one auth.login.failed row should fire");

      const row = latestRow(db, u.user.id, "auth.login.failed");
      assertCaptured(row, "auth.login.failed");
    });

    // ── auth.logout ──────────────────────────────────────────────────────
    console.log("\n👋 auth.logout — explicit sign-out is audited");

    await test("auth.logout row is created with IP+UA on POST /logout", async () => {
      const u = await setupUser(baseUrl, "logout");
      const res = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": TEST_UA,
          Cookie: u.cookieHeader,
          "X-CSRF-Token": u.csrf,
        },
      });
      assert.equal(res.status, 200);
      const row = latestRow(t.getDatabase(), u.user.id, "auth.logout");
      assertCaptured(row, "auth.logout");
    });

    // ── auth.password.reset ──────────────────────────────────────────────
    console.log("\n🔐 auth.password.reset — password-change is audited");

    await test("auth.password.reset row created on /reset-password success", async () => {
      const u = await setupUser(baseUrl, "pw-reset");
      const db = t.getDatabase();
      // Generate a reset token directly via the repo so we don't depend on
      // a working email pipeline in the test environment.
      const resetTokenRepo = await import("../src/database/repositories/passwordResetTokenRepo.js");
      const crypto = await import("node:crypto");
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      resetTokenRepo.create(token, u.user.id, expiresAt);

      const res = await fetch(`${baseUrl}/api/v1/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": TEST_UA },
        body: JSON.stringify({ token, newPassword: "NewPassword456!" }),
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);

      const row = latestRow(db, u.user.id, "auth.password.reset");
      assertCaptured(row, "auth.password.reset");
    });

    // ── auth.role.change ─────────────────────────────────────────────────
    console.log("\n👥 auth.role.change — workspace role mutation is audited");

    await test("auth.role.change row created with from/to meta on member role update", async () => {
      const admin = await setupUser(baseUrl, "role-admin");
      // Add a second member as 'viewer' so the admin can promote them.
      // workspace owner (admin) does the promotion; target ends up as qa_lead.
      const target = await setupUser(baseUrl, "role-target");
      const db = t.getDatabase();
      // Manually add target to admin's workspace as a viewer. This skips the
      // invite flow which isn't the subject of this test.
      const workspaceRepo = await import("../src/database/repositories/workspaceRepo.js");
      workspaceRepo.addMember(admin.user.workspaceId, target.user.id, "viewer");

      const res = await fetch(
        `${baseUrl}/api/v1/workspaces/current/members/${target.user.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": TEST_UA,
            Cookie: admin.cookieHeader,
            "X-CSRF-Token": admin.csrf,
          },
          body: JSON.stringify({ role: "qa_lead" }),
        },
      );
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);

      const row = latestRow(db, target.user.id, "auth.role.change");
      assertCaptured(row, "auth.role.change");
      assert.equal(row.workspaceId, admin.user.workspaceId);

      // Verify the meta captures from/to + actor for SOC 2 "what changed?".
      const meta = JSON.parse(row.meta || "{}");
      assert.equal(meta.from, "viewer", "previous role must be in meta.from");
      assert.equal(meta.to, "qa_lead", "new role must be in meta.to");
      assert.equal(meta.changedBy, admin.user.id, "actor must be in meta.changedBy");
    });

    // ── auth.api_key.create / auth.api_key.revoke ────────────────────────
    console.log("\n🔑 auth.api_key.create + auth.api_key.revoke — provider key lifecycle");

    await test("auth.api_key.create row created on POST /settings (provider key save)", async () => {
      const admin = await setupUser(baseUrl, "apikey-create");
      const db = t.getDatabase();

      // Save a fake Anthropic key via the settings endpoint. The route
      // calls setRuntimeKey + setActiveProvider then emits both
      // settings.update (legacy) and auth.api_key.create (SEC-007).
      const res = await fetch(`${baseUrl}/api/v1/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": TEST_UA,
          Cookie: admin.cookieHeader,
          "X-CSRF-Token": admin.csrf,
        },
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-test-1234567890abcdef" }),
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`);

      const row = latestRow(db, admin.user.id, "auth.api_key.create");
      assertCaptured(row, "auth.api_key.create");

      // meta.provider must be present but the raw key MUST NEVER be logged.
      const meta = JSON.parse(row.meta || "{}");
      assert.equal(meta.provider, "anthropic");
      const rowJson = JSON.stringify(row);
      assert.ok(!rowJson.includes("sk-test-1234567890abcdef"),
        "raw API key must NEVER appear in the audit row");
    });

    await test("auth.api_key.revoke row created on DELETE /settings/:provider", async () => {
      const admin = await setupUser(baseUrl, "apikey-revoke");
      const db = t.getDatabase();
      // Seed a key first so the revoke path has something to clear.
      await fetch(`${baseUrl}/api/v1/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": TEST_UA,
          Cookie: admin.cookieHeader,
          "X-CSRF-Token": admin.csrf,
        },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-revoke-test-key" }),
      });

      const res = await fetch(`${baseUrl}/api/v1/settings/openai`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": TEST_UA,
          Cookie: admin.cookieHeader,
          "X-CSRF-Token": admin.csrf,
        },
      });
      assert.equal(res.status, 200);

      const row = latestRow(db, admin.user.id, "auth.api_key.revoke");
      assertCaptured(row, "auth.api_key.revoke");
      const meta = JSON.parse(row.meta || "{}");
      assert.equal(meta.provider, "openai");
    });

    // ── auth.session.revoke ──────────────────────────────────────────────
    console.log("\n🛑 auth.session.revoke — server-initiated session termination");

    await test("auth.session.revoke row created when the current session is revoked", async () => {
      // The cleanest trigger for _internalRevokeCurrentSession in a test
      // is /mfa/disable AFTER enabling MFA — that path runs the helper with
      // reason="mfa.disabled". We use the test-base TOTP helper to drive
      // the enroll/enable flow without a real authenticator.
      const u = await setupUser(baseUrl, "session-revoke");
      const db = t.getDatabase();

      // Enroll TOTP
      let res = await fetch(`${baseUrl}/api/v1/auth/mfa/enroll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": TEST_UA,
          Cookie: u.cookieHeader,
          "X-CSRF-Token": u.csrf,
        },
      });
      assert.equal(res.status, 200, "enroll should succeed");
      const { secret } = await res.json();
      const code = t.generateTotpCode(secret);

      // Enable MFA (this finalises enrollment but does NOT revoke the session)
      res = await fetch(`${baseUrl}/api/v1/auth/mfa/enable`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": TEST_UA,
          Cookie: u.cookieHeader,
          "X-CSRF-Token": u.csrf,
        },
        body: JSON.stringify({ token: code }),
      });
      assert.equal(res.status, 200, "enable should succeed");

      // NOW disable MFA — this triggers _internalRevokeCurrentSession which
      // emits the auth.session.revoke row we want to verify.
      res = await fetch(`${baseUrl}/api/v1/auth/mfa/disable`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": TEST_UA,
          Cookie: u.cookieHeader,
          "X-CSRF-Token": u.csrf,
        },
        body: JSON.stringify({ password: u.password }),
      });
      assert.equal(res.status, 200, `disable should succeed: ${await res.text()}`);

      const row = latestRow(db, u.user.id, "auth.session.revoke");
      assertCaptured(row, "auth.session.revoke");
      // The disable path tags the revoke with reason="mfa.disabled" so
      // SOC 2 reviewers can distinguish posture-change revokes from
      // explicit logouts.
      const meta = JSON.parse(row.meta || "{}");
      assert.equal(meta.reason, "mfa.disabled");
    });

    summary("audit-auth-events");
    console.log("\n🎉 All audit-auth-events tests passed!");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ audit-auth-events failed:", err);
  process.exit(1);
});

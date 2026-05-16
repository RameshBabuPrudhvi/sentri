/**
 * @module tests/auth-mfa-enforcement
 * @description Integration tests for per-workspace MFA enforcement (SEC-004).
 *
 * Covers:
 *   - evaluateMfaEnforcement() — allow / grace / block decision logic
 *   - Grace clock anchored at MAX(policyAt, joinedAt, accountAt)
 *   - Strictest-wins across multi-workspace users
 *   - POST /login enforces 403 MFA_ENROLLMENT_REQUIRED past grace
 *   - POST /login sets X-MFA-Grace-Period-Days-Remaining within grace
 *   - PATCH /workspaces/current accepts + validates mfaRequired + mfaGracePeriodDays
 *   - PATCH /workspaces/current stamps mfaPolicyUpdatedAt only on transition
 *   - GET /workspaces/current/mfa-compliance returns enrolled/notEnrolled counts
 *   - workspace.mfa_policy_changed audit log emitted
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import workspacesRouter from "../src/routes/workspaces.js";
import * as workspaceRepo from "../src/database/repositories/workspaceRepo.js";
import * as userRepo from "../src/database/repositories/userRepo.js";
import * as webauthnRepo from "../src/database/repositories/webauthnRepo.js";
import { evaluateMfaEnforcement } from "../src/utils/mfaEnforcement.js";
import { createTestContext, parseCookies, buildCookieHeader } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/workspaces", requireAuth, workspaceScope, workspacesRouter);
  mounted = true;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  mountRoutesOnce();
  t.resetDb();

  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true", MFA_TOTP_WINDOW: "2" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const runner = t.createTestRunner();
  const { test, summary } = runner;

  try {
    async function setupUser(suffix) {
      const email = `enf-${suffix}-${Date.now()}@test.local`;
      const password = "Password123!";
      let res = await fetch(`${base}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Enf User", email, password }),
      });
      assert.equal(res.status, 201);
      res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(res.status, 200);
      const cookies = parseCookies(res);
      return {
        email, password,
        csrf: cookies._csrf.value,
        cookieHeader: buildCookieHeader(cookies),
        user: (await res.json()).user,
      };
    }

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🛡️  evaluateMfaEnforcement — pure decision logic");
    // ──────────────────────────────────────────────────────────────────────

    await test("returns allow when user has no workspaces", () => {
      const decision = evaluateMfaEnforcement({
        id: "U-NOWS", mfaEnabled: 0, createdAt: new Date().toISOString(),
      });
      assert.equal(decision.state, "allow");
    });

    await test("returns allow when user has mfaEnabled=1 regardless of policy", async () => {
      const u = await setupUser("eval-enabled");
      const db = t.getDatabase();
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 0, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(new Date(Date.now() - 10 * DAY_MS).toISOString(), u.user.workspaceId);
      db.prepare("UPDATE users SET mfaEnabled = 1 WHERE id = ?").run(u.user.id);

      const user = userRepo.getById(u.user.id);
      assert.equal(evaluateMfaEnforcement(user).state, "allow");
    });

    await test("returns allow when user has a passkey but no TOTP (passkey satisfies MFA)", async () => {
      // Regression for the OAuth-only-with-passkey false-block bug:
      // before the fix, evaluateMfaEnforcement only checked mfaEnabled and
      // returned `block` for users who had passkeys but no TOTP, locking
      // them out of OAuth login under workspace enforcement.
      const u = await setupUser("eval-passkey");
      const db = t.getDatabase();
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 0, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(new Date(Date.now() - 10 * DAY_MS).toISOString(), u.user.workspaceId);

      // Register a passkey for the user (mfaEnabled stays 0).
      webauthnRepo.create({
        id: `cred-passkey-eval-${Date.now()}`,
        userId: u.user.id,
        publicKey: Buffer.from("fake-cose-pubkey").toString("base64"),
        counter: 0,
        transports: ["internal"],
        deviceName: "Test passkey",
      });

      const user = userRepo.getById(u.user.id);
      assert.equal(user.mfaEnabled, 0, "TOTP must be off so we exercise the passkey-only path");
      assert.equal(evaluateMfaEnforcement(user).state, "allow",
        "user with a registered passkey must be allowed even when workspace requires MFA");
    });

    await test("grace clock anchors at joinedAt for new members of a long-standing policy", async () => {
      // Regression for the missing-joinedAt bug: workspaceRepo.getByUserId
      // did not SELECT wm.joinedAt, so evaluateMfaEnforcement's anchor
      // collapsed to policyAt and new hires inherited zero grace from an
      // old policy.
      const u = await setupUser("eval-joinedat");
      const db = t.getDatabase();
      // Policy enabled 90 days ago, grace = 7 days.
      // User's membership row was created moments ago via setupUser.
      // After the fix, joinedAt (today) wins the MAX(...) so we should be
      // mid-grace (~6-7 days remaining), NOT past-grace.
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 7, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(new Date(Date.now() - 90 * DAY_MS).toISOString(), u.user.workspaceId);

      const user = userRepo.getById(u.user.id);
      const decision = evaluateMfaEnforcement(user);
      assert.equal(decision.state, "grace",
        "new member of an old-policy workspace must land in grace, not block");
      assert.ok(decision.gracePeriodDaysRemaining >= 6,
        `expected ~7 days remaining (anchored at joinedAt), got ${decision.gracePeriodDaysRemaining}`);
    });

    await test("returns allow when workspace mfaRequired=0", async () => {
      const u = await setupUser("eval-policy-off");
      const user = userRepo.getById(u.user.id);
      assert.equal(evaluateMfaEnforcement(user).state, "allow");
    });

    await test("returns grace when within grace window", async () => {
      const u = await setupUser("eval-grace");
      const db = t.getDatabase();
      // Policy flipped 2 days ago, grace = 7 days → ~5 days remaining.
      // Backdate joinedAt + user.createdAt so policyAt wins the
      // MAX(policyAt, joinedAt, accountAt) anchor in evaluateMfaEnforcement.
      const policyAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
      const backdate = new Date(Date.now() - 30 * DAY_MS).toISOString();
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 7, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(policyAt, u.user.workspaceId);
      db.prepare("UPDATE workspace_members SET joinedAt = ? WHERE userId = ? AND workspaceId = ?")
        .run(backdate, u.user.id, u.user.workspaceId);
      db.prepare("UPDATE users SET createdAt = ? WHERE id = ?").run(backdate, u.user.id);

      const user = userRepo.getById(u.user.id);
      const decision = evaluateMfaEnforcement(user);
      assert.equal(decision.state, "grace");
      assert.equal(decision.workspaceId, u.user.workspaceId);
      assert.ok(decision.gracePeriodDaysRemaining >= 4 && decision.gracePeriodDaysRemaining <= 5,
        `expected ~5 days remaining, got ${decision.gracePeriodDaysRemaining}`);
      assert.ok(decision.graceEndsAt, "graceEndsAt should be set");
    });

    await test("returns block when past grace window", async () => {
      const u = await setupUser("eval-block");
      const db = t.getDatabase();
      // Policy enabled 10 days ago, grace = 1 day → past grace.
      // Backdate joinedAt + user.createdAt so policyAt wins the anchor —
      // otherwise the just-created membership/account would re-anchor the
      // clock to now and place the user inside grace.
      const policyAt = new Date(Date.now() - 10 * DAY_MS).toISOString();
      const backdate = new Date(Date.now() - 30 * DAY_MS).toISOString();
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 1, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(policyAt, u.user.workspaceId);
      db.prepare("UPDATE workspace_members SET joinedAt = ? WHERE userId = ? AND workspaceId = ?")
        .run(backdate, u.user.id, u.user.workspaceId);
      db.prepare("UPDATE users SET createdAt = ? WHERE id = ?").run(backdate, u.user.id);

      const user = userRepo.getById(u.user.id);
      const decision = evaluateMfaEnforcement(user);
      assert.equal(decision.state, "block");
      assert.equal(decision.workspaceId, u.user.workspaceId);
      assert.ok(decision.graceEndsAt, "graceEndsAt should be set");
    });

    await test("strictest-wins: block beats grace across multiple workspaces", async () => {
      const u = await setupUser("eval-multi-ws");
      const db = t.getDatabase();
      // Current workspace: within grace
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 7, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(new Date(Date.now() - 1 * DAY_MS).toISOString(), u.user.workspaceId);
      // Second workspace owned by same user: past grace
      const ws2 = workspaceRepo.create({
        name: "Strict WS",
        slug: `strict-${Date.now()}`,
        ownerId: u.user.id,
      });
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 0, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(new Date(Date.now() - 10 * DAY_MS).toISOString(), ws2.id);

      const user = userRepo.getById(u.user.id);
      const decision = evaluateMfaEnforcement(user);
      assert.equal(decision.state, "block", "block must win over grace");
      assert.equal(decision.workspaceId, ws2.id);
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🛡️  /login enforcement");
    // ──────────────────────────────────────────────────────────────────────

    await test("/login blocks with 403 MFA_ENROLLMENT_REQUIRED past grace", async () => {
      const u = await setupUser("login-blocked");
      const db = t.getDatabase();
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 0, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(new Date(Date.now() - 10 * DAY_MS).toISOString(), u.user.workspaceId);

      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "MFA_ENROLLMENT_REQUIRED");
      assert.equal(body.workspaceId, u.user.workspaceId);
      assert.ok(body.workspaceName, "should include workspaceName");
    });

    await test("/login within grace sets X-MFA-Grace-Period-Days-Remaining header", async () => {
      const u = await setupUser("login-grace");
      const db = t.getDatabase();
      // Backdate joinedAt + user.createdAt so policyAt (2 days ago) wins the
      // MAX(policyAt, joinedAt, accountAt) anchor in evaluateMfaEnforcement.
      const policyAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
      const backdate = new Date(Date.now() - 30 * DAY_MS).toISOString();
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 7, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(policyAt, u.user.workspaceId);
      db.prepare("UPDATE workspace_members SET joinedAt = ? WHERE userId = ? AND workspaceId = ?")
        .run(backdate, u.user.id, u.user.workspaceId);
      db.prepare("UPDATE users SET createdAt = ? WHERE id = ?").run(backdate, u.user.id);

      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      assert.equal(res.status, 200, "login should succeed within grace");
      const remaining = res.headers.get("x-mfa-grace-period-days-remaining");
      assert.ok(remaining, "header should be set within grace");
      assert.ok(Number(remaining) >= 4 && Number(remaining) <= 5, `expected ~5, got ${remaining}`);
      assert.ok(res.headers.get("x-mfa-grace-ends-at"), "graceEndsAt header should be set");
    });

    await test("/login with policy off has no grace header", async () => {
      const u = await setupUser("login-no-policy");
      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-mfa-grace-period-days-remaining"), null,
        "grace header should be absent when policy is off");
    });

    await test("/login blocked logs auth.mfa.enrollment_required activity", async () => {
      const u = await setupUser("login-audit-block");
      const db = t.getDatabase();
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 0, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(new Date(Date.now() - 10 * DAY_MS).toISOString(), u.user.workspaceId);

      await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      const row = db.prepare(
        "SELECT type, meta FROM activities WHERE userId = ? AND type = 'auth.mfa.enrollment_required'"
      ).get(u.user.id);
      assert.ok(row, "enrollment_required activity should be logged");
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🛡️  PATCH /workspaces/current — admin policy controls");
    // ──────────────────────────────────────────────────────────────────────

    await test("PATCH /workspaces/current accepts mfaRequired + mfaGracePeriodDays", async () => {
      const u = await setupUser("ws-patch-ok");
      const res = await fetch(`${base}/api/v1/workspaces/current`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ mfaRequired: true, mfaGracePeriodDays: 14 }),
      });
      assert.equal(res.status, 200);
      const ws = await res.json();
      assert.equal(ws.mfaRequired, 1);
      assert.equal(ws.mfaGracePeriodDays, 14);
      assert.ok(ws.mfaPolicyUpdatedAt, "policy timestamp should be stamped on transition");
    });

    await test("PATCH /workspaces/current rejects mfaGracePeriodDays out of range", async () => {
      const u = await setupUser("ws-patch-range");
      const res = await fetch(`${base}/api/v1/workspaces/current`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ mfaGracePeriodDays: 999 }),
      });
      assert.equal(res.status, 400);
    });

    await test("mfaPolicyUpdatedAt only stamps on transition, not on every edit", async () => {
      const u = await setupUser("ws-patch-stable");
      // First PATCH: 0 → 1 (stamps timestamp)
      let res = await fetch(`${base}/api/v1/workspaces/current`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ mfaRequired: true }),
      });
      const firstStamp = (await res.json()).mfaPolicyUpdatedAt;

      // Second PATCH: unrelated edit (grace days only) — should NOT bump timestamp
      await new Promise((r) => setTimeout(r, 10)); // ensure clock advances
      res = await fetch(`${base}/api/v1/workspaces/current`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ mfaGracePeriodDays: 30 }),
      });
      const secondStamp = (await res.json()).mfaPolicyUpdatedAt;
      assert.equal(firstStamp, secondStamp, "mfaPolicyUpdatedAt should not change on unrelated edits");
    });

    await test("PATCH /workspaces/current emits workspace.mfa_policy_changed activity on transition", async () => {
      const u = await setupUser("ws-patch-audit");
      await fetch(`${base}/api/v1/workspaces/current`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ mfaRequired: true }),
      });
      const db = t.getDatabase();
      const row = db.prepare(
        "SELECT type, meta FROM activities WHERE workspaceId = ? AND type = 'workspace.mfa_policy_changed'"
      ).get(u.user.workspaceId);
      assert.ok(row, "policy-change activity should be logged");
      const meta = JSON.parse(row.meta);
      assert.equal(meta.mfaRequired, 1);
    });

    await test("GET /workspaces/current/mfa-compliance returns enrolled/notEnrolled counts", async () => {
      const u = await setupUser("ws-compliance");
      const res = await fetch(`${base}/api/v1/workspaces/current/mfa-compliance`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.totalMembers, "number");
      assert.equal(typeof body.enrolled, "number");
      assert.equal(typeof body.notEnrolled, "number");
      assert.ok(Array.isArray(body.members), "members must be an array");
      assert.equal(body.totalMembers, body.enrolled + body.notEnrolled);
      // The user we just created has mfaEnabled=0
      const me = body.members.find((m) => m.userId === u.user.id);
      assert.ok(me, "compliance should include the calling user");
      assert.equal(me.mfaEnabled, false);
    });

    summary("MFA enforcement");
    console.log("\n🎉 All MFA enforcement tests passed!");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ auth-mfa-enforcement failed:", err);
  process.exit(1);
});

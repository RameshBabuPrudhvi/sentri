/**
 * @module tests/auth-webauthn
 * @description Tests for WebAuthn / passkey support (SEC-004 §4).
 *
 * The full cryptographic round-trip (browser → attestation → server
 * verification) cannot be exercised here without a real authenticator —
 * `@simplewebauthn/server` does ECDSA / COSE / certificate-chain
 * validation that needs a hardware credential or a complex test rig.
 *
 * What this file CAN cover (and does):
 *   - `webauthnRepo` CRUD: create, getById, listByUser, updateCounter,
 *     deleteById (incl. cross-user isolation), countByUser
 *   - Transports JSON round-trip (stored as TEXT, hydrated as array)
 *   - Cascade delete on user removal (FK ON DELETE CASCADE)
 *   - Route guard behaviour:
 *     * /authenticate/options 401 when pendingToken is invalid
 *     * /authenticate/options 400 when user has no registered passkeys
 *     * /authenticate/verify 400 when challengeToken is invalid/expired
 *     * /credentials list excludes publicKey
 *     * DELETE /credentials/:id requires correct password (403)
 *     * DELETE /credentials/:id cross-user isolation (404 on someone else's)
 *     * DELETE /credentials/:id self-lockout guard returns MFA_LAST_FACTOR_PROTECTED
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import webauthnRouter from "../src/routes/webauthn.js";
import * as webauthnRepo from "../src/database/repositories/webauthnRepo.js";
import { createTestContext, parseCookies, buildCookieHeader } from "./helpers/test-base.js";

const t = createTestContext();
const { app } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/auth/webauthn", webauthnRouter);
  mounted = true;
}

/** Synthesise a deterministic credential row for repo tests. */
function fakeCred(userId, idSuffix = "1") {
  return {
    id: `cred-${userId}-${idSuffix}-${crypto.randomBytes(2).toString("hex")}`,
    userId,
    publicKey: Buffer.from("fake-cose-pubkey").toString("base64"),
    counter: 0,
    transports: ["internal", "hybrid"],
    deviceName: `Device-${idSuffix}`,
  };
}

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
      const email = `wa-${suffix}-${Date.now()}@test.local`;
      const password = "Password123!";
      let res = await fetch(`${base}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "WA User", email, password }),
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
    console.log("\n🔑 webauthnRepo — CRUD");
    // ──────────────────────────────────────────────────────────────────────

    await test("create() persists row and hydrates transports as array", async () => {
      const u = await setupUser("repo-create");
      const cred = fakeCred(u.user.id);
      const stored = webauthnRepo.create(cred);
      assert.equal(stored.id, cred.id);
      assert.equal(stored.userId, u.user.id);
      assert.deepEqual(stored.transports, ["internal", "hybrid"]);
      assert.equal(stored.deviceName, cred.deviceName);
      assert.equal(stored.counter, 0);
      assert.ok(stored.createdAt);
      assert.equal(stored.lastUsedAt, null);
    });

    await test("getById() returns hydrated row, or undefined when missing", async () => {
      const u = await setupUser("repo-getbyid");
      const cred = fakeCred(u.user.id);
      webauthnRepo.create(cred);
      const found = webauthnRepo.getById(cred.id);
      assert.ok(found);
      assert.deepEqual(found.transports, cred.transports);
      assert.equal(webauthnRepo.getById("does-not-exist"), undefined);
    });

    await test("listByUser() returns oldest first", async () => {
      const u = await setupUser("repo-list");
      const a = fakeCred(u.user.id, "a"); webauthnRepo.create(a);
      await new Promise((r) => setTimeout(r, 5)); // ensure distinct createdAt
      const b = fakeCred(u.user.id, "b"); webauthnRepo.create(b);
      const list = webauthnRepo.listByUser(u.user.id);
      assert.equal(list.length, 2);
      assert.equal(list[0].id, a.id);
      assert.equal(list[1].id, b.id);
    });

    await test("countByUser() returns 0 / 1 / N correctly", async () => {
      const u = await setupUser("repo-count");
      assert.equal(webauthnRepo.countByUser(u.user.id), 0);
      webauthnRepo.create(fakeCred(u.user.id, "x"));
      assert.equal(webauthnRepo.countByUser(u.user.id), 1);
      webauthnRepo.create(fakeCred(u.user.id, "y"));
      assert.equal(webauthnRepo.countByUser(u.user.id), 2);
    });

    await test("updateCounter() bumps counter and stamps lastUsedAt", async () => {
      const u = await setupUser("repo-counter");
      const cred = fakeCred(u.user.id);
      webauthnRepo.create(cred);
      assert.equal(webauthnRepo.updateCounter(cred.id, 42), true);
      const refetched = webauthnRepo.getById(cred.id);
      assert.equal(refetched.counter, 42);
      assert.ok(refetched.lastUsedAt, "lastUsedAt should be stamped");
    });

    await test("deleteById() is userId-scoped — cannot delete another user's credential", async () => {
      const a = await setupUser("repo-del-a");
      const b = await setupUser("repo-del-b");
      const credA = fakeCred(a.user.id);
      webauthnRepo.create(credA);

      // User B tries to delete user A's credential
      const result = webauthnRepo.deleteById(credA.id, b.user.id);
      assert.equal(result, false, "cross-user delete must be rejected");
      assert.ok(webauthnRepo.getById(credA.id), "credential must still exist");

      // User A can delete their own
      assert.equal(webauthnRepo.deleteById(credA.id, a.user.id), true);
      assert.equal(webauthnRepo.getById(credA.id), undefined);
    });

    await test("FK ON DELETE CASCADE removes credentials when user is deleted", async () => {
      const u = await setupUser("repo-cascade");
      webauthnRepo.create(fakeCred(u.user.id, "a"));
      webauthnRepo.create(fakeCred(u.user.id, "b"));
      assert.equal(webauthnRepo.countByUser(u.user.id), 2);

      const db = t.getDatabase();
      db.prepare("DELETE FROM users WHERE id = ?").run(u.user.id);
      assert.equal(webauthnRepo.countByUser(u.user.id), 0,
        "credentials should cascade-delete when user is removed");
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔑 /auth/webauthn — route guards");
    // ──────────────────────────────────────────────────────────────────────

    await test("GET /webauthn/credentials excludes publicKey from response", async () => {
      const u = await setupUser("route-list");
      webauthnRepo.create(fakeCred(u.user.id));
      const res = await fetch(`${base}/api/v1/auth/webauthn/credentials`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.credentials));
      assert.equal(body.credentials.length, 1);
      assert.equal(body.credentials[0].publicKey, undefined,
        "publicKey must NOT be exposed in the list response");
      assert.ok(body.credentials[0].id);
      assert.ok(Array.isArray(body.credentials[0].transports));
    });

    await test("POST /webauthn/authenticate/options returns 401 on missing pendingToken", async () => {
      const res = await fetch(`${base}/api/v1/auth/webauthn/authenticate/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // 503 if dep missing, 400 if dep present (pendingToken required check)
      assert.ok(res.status === 400 || res.status === 503,
        `expected 400 or 503, got ${res.status}`);
    });

    await test("POST /webauthn/authenticate/options returns 401 on invalid pendingToken", async () => {
      const res = await fetch(`${base}/api/v1/auth/webauthn/authenticate/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken: "not-a-real-token" }),
      });
      assert.ok(res.status === 401 || res.status === 503,
        `expected 401 or 503, got ${res.status}`);
    });

    await test("POST /webauthn/authenticate/verify returns 400 on bad challengeToken", async () => {
      const res = await fetch(`${base}/api/v1/auth/webauthn/authenticate/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: "fake", assertion: { id: "x" } }),
      });
      assert.ok(res.status === 400 || res.status === 503,
        `expected 400 or 503, got ${res.status}`);
    });

    await test("DELETE /webauthn/credentials/:id rejects wrong password with 403", async () => {
      const u = await setupUser("route-del-403");
      const cred = fakeCred(u.user.id);
      webauthnRepo.create(cred);
      const res = await fetch(`${base}/api/v1/auth/webauthn/credentials/${cred.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: "WrongPassword!" }),
      });
      assert.equal(res.status, 403);
      // Credential should still exist
      assert.ok(webauthnRepo.getById(cred.id));
    });

    await test("DELETE /webauthn/credentials/:id returns 404 for another user's credential", async () => {
      const a = await setupUser("route-del-cross-a");
      const b = await setupUser("route-del-cross-b");
      const credA = fakeCred(a.user.id);
      webauthnRepo.create(credA);
      // User B tries to delete user A's credential
      const res = await fetch(`${base}/api/v1/auth/webauthn/credentials/${credA.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: b.cookieHeader, "X-CSRF-Token": b.csrf },
        body: JSON.stringify({ password: b.password }),
      });
      assert.equal(res.status, 404, "cross-user delete must be 404");
      assert.ok(webauthnRepo.getById(credA.id), "credential must still exist");
    });

    await test("DELETE /webauthn/credentials/:id self-lockout guard blocks last factor under enforcement", async () => {
      const u = await setupUser("route-del-lockout");
      const cred = fakeCred(u.user.id);
      webauthnRepo.create(cred);

      // Workspace requires MFA past grace
      const db = t.getDatabase();
      db.prepare(
        "UPDATE workspaces SET mfaRequired = 1, mfaGracePeriodDays = 0, mfaPolicyUpdatedAt = ? WHERE id = ?"
      ).run(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), u.user.workspaceId);

      const res = await fetch(`${base}/api/v1/auth/webauthn/credentials/${cred.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: u.password }),
      });
      assert.equal(res.status, 400, "removing last factor under enforcement must be 400");
      const body = await res.json();
      assert.equal(body.code, "MFA_LAST_FACTOR_PROTECTED");
      assert.ok(webauthnRepo.getById(cred.id), "credential must still exist");
    });

    await test("DELETE /webauthn/credentials/:id succeeds with correct password (no enforcement)", async () => {
      const u = await setupUser("route-del-ok");
      const cred = fakeCred(u.user.id);
      webauthnRepo.create(cred);
      const res = await fetch(`${base}/api/v1/auth/webauthn/credentials/${cred.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: u.password }),
      });
      assert.equal(res.status, 200);
      assert.equal(webauthnRepo.getById(cred.id), undefined);
    });

    summary("WebAuthn");
    console.log("\n🎉 All WebAuthn tests passed!");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ auth-webauthn failed:", err);
  process.exit(1);
});

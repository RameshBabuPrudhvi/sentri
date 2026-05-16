/**
 * @module tests/auth-mfa-totp
 * @description Integration tests for TOTP-based MFA (SEC-004).
 *
 * Covers:
 *   - GET  /auth/mfa/status / /auth/mfa/factors
 *   - POST /auth/mfa/enroll (incl. 409 re-enroll guard)
 *   - POST /auth/mfa/enable (with valid + invalid code)
 *   - POST /auth/login returns mfaRequired + methods when enrolled
 *   - POST /auth/mfa/verify (TOTP code path) → cookie + amr=["pwd","mfa"]
 *   - POST /auth/mfa/verify (recovery code path) → consumes code, second use fails
 *   - POST /auth/mfa/recovery-codes/regenerate (password-confirmed)
 *   - POST /auth/mfa/disable (password-confirmed)
 *   - Encrypted-at-rest secret storage
 *   - Audit-log entries emitted for enrol/enable/verify/recovery/disable
 *   - amr=["pwd"] for password-only login when MFA not enabled
 *
 * Uses the `generateTotpCode` test helper to produce valid codes without a
 * real authenticator app.
 */

import assert from "node:assert/strict";
import authRouter from "../src/routes/auth.js";
import { createTestContext, parseCookies, buildCookieHeader } from "./helpers/test-base.js";
import { decryptString } from "../src/utils/credentialEncryption.js";

const t = createTestContext();
const { app } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/v1/auth", authRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();

  // Widen the TOTP window to ±2 steps (60s each side) so CI runners with
  // slow I/O don't fail on window-boundary timing. Production default is 1.
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true", MFA_TOTP_WINDOW: "2" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const runner = t.createTestRunner();
  const { test, summary } = runner;

  try {
    // ── Helper: register a fresh user and return { cookieHeader, csrf, user } ──
    async function setupUser(suffix) {
      const email = `mfa-${suffix}-${Date.now()}@test.local`;
      const password = "Password123!";
      let res = await fetch(`${base}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "MFA User", email, password }),
      });
      assert.equal(res.status, 201, `register failed: ${res.status}`);
      res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(res.status, 200, `login failed: ${res.status}`);
      const cookies = parseCookies(res);
      const csrf = cookies._csrf.value;
      const cookieHeader = buildCookieHeader(cookies);
      const body = await res.json();
      return { email, password, cookies, csrf, cookieHeader, user: body.user };
    }

    /** Enroll + enable TOTP, returning the secret + recovery codes. */
    async function enrollAndEnable(u) {
      let res = await fetch(`${base}/api/v1/auth/mfa/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
      });
      const { secret } = await res.json();
      res = await fetch(`${base}/api/v1/auth/mfa/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ token: t.generateTotpCode(secret) }),
      });
      assert.equal(res.status, 200, `enable failed: ${res.status}`);
      const { recoveryCodes } = await res.json();
      return { secret, recoveryCodes };
    }

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔐 /auth/mfa — status + factors");
    // ──────────────────────────────────────────────────────────────────────

    await test("GET /mfa/status returns enabled:false for new user", async () => {
      const u = await setupUser("status-disabled");
      const res = await fetch(`${base}/api/v1/auth/mfa/status`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.enabled, false);
    });

    await test("GET /mfa/factors returns aggregate state for new user", async () => {
      const u = await setupUser("factors-empty");
      const res = await fetch(`${base}/api/v1/auth/mfa/factors`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.totp, false);
      assert.equal(body.recoveryCodesRemaining, 0);
      assert.deepEqual(body.webauthn, []);
    });

    await test("GET /mfa/factors reports recoveryCodesRemaining after enable", async () => {
      const u = await setupUser("factors-enrolled");
      await enrollAndEnable(u);
      const res = await fetch(`${base}/api/v1/auth/mfa/factors`, {
        headers: { Cookie: u.cookieHeader },
      });
      const body = await res.json();
      assert.equal(body.totp, true);
      assert.equal(body.recoveryCodesRemaining, 8);
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔐 /auth/mfa/enroll");
    // ──────────────────────────────────────────────────────────────────────

    await test("POST /mfa/enroll returns secret + otpauth and persists encrypted secret", async () => {
      const u = await setupUser("enroll-ok");
      const res = await fetch(`${base}/api/v1/auth/mfa/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.secret, /^[A-Z2-7]{20,}$/, "secret should be base32");
      assert.match(body.otpauth, /^otpauth:\/\/totp\/Sentri:/, "otpauth URL should be issuer-tagged");

      // Verify encrypted-at-rest storage
      const db = t.getDatabase();
      const row = db.prepare("SELECT mfaSecret, mfaEnabled FROM users WHERE id = ?").get(u.user.id);
      assert.equal(row.mfaEnabled, 0, "mfaEnabled should still be 0 before /enable");
      assert.notEqual(row.mfaSecret, body.secret, "secret must be encrypted, not plaintext");
      assert.equal(decryptString(row.mfaSecret), body.secret, "decryptString should round-trip");
    });

    await test("POST /mfa/enroll returns 409 when MFA already enabled", async () => {
      const u = await setupUser("enroll-409");
      await enrollAndEnable(u);
      const res = await fetch(`${base}/api/v1/auth/mfa/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
      });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.match(body.error, /already enabled/i);
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔐 /auth/mfa/enable");
    // ──────────────────────────────────────────────────────────────────────

    await test("POST /mfa/enable rejects invalid TOTP with 400", async () => {
      const u = await setupUser("enable-400");
      await fetch(`${base}/api/v1/auth/mfa/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
      });
      const res = await fetch(`${base}/api/v1/auth/mfa/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ token: "000000" }),
      });
      assert.equal(res.status, 400);
    });

    await test("POST /mfa/enable returns 400 when enrollment not initialized", async () => {
      const u = await setupUser("enable-400-noinit");
      const res = await fetch(`${base}/api/v1/auth/mfa/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ token: "123456" }),
      });
      assert.equal(res.status, 400);
    });

    await test("POST /mfa/enable succeeds and persists hashed (not raw) recovery codes", async () => {
      const u = await setupUser("enable-ok");
      const { recoveryCodes } = await enrollAndEnable(u);
      assert.equal(recoveryCodes.length, 8);
      for (const code of recoveryCodes) {
        assert.match(code, /^[a-f0-9]{8}$/, "recovery codes should be 8-hex-char");
      }
      const db = t.getDatabase();
      const row = db.prepare("SELECT mfaEnabled, mfaRecoveryCodes FROM users WHERE id = ?").get(u.user.id);
      assert.equal(row.mfaEnabled, 1);
      const hashed = JSON.parse(row.mfaRecoveryCodes);
      assert.equal(hashed.length, 8);
      for (const h of hashed) assert.match(h, /^[a-f0-9]{64}$/, "stored codes should be SHA-256 hex");
      for (const raw of recoveryCodes) {
        assert.ok(!hashed.includes(raw), "raw recovery codes must not be persisted");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔐 /auth/login with MFA enabled");
    // ──────────────────────────────────────────────────────────────────────

    await test("/login with non-MFA user issues cookie with amr=[pwd]", async () => {
      const u = await setupUser("login-pwd-only");
      // The setup login already happened; check the original response.
      const token = u.cookies.access_token.value;
      const payload = t.decodeJwtPayload(token);
      assert.deepEqual(payload.amr, ["pwd"], "non-MFA login should set amr=[pwd]");
    });

    await test("/login with MFA-enabled user returns mfaRequired + methods, no cookie", async () => {
      const u = await setupUser("login-mfa-required");
      await enrollAndEnable(u);
      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.mfaRequired, true);
      assert.ok(body.pendingToken, "should issue pendingToken");
      assert.equal(body.methods?.totp, true);
      assert.equal(body.methods?.webauthn, false);
      assert.equal(body.user, undefined, "no user payload until /mfa/verify");

      const cookies = parseCookies(res);
      assert.equal(cookies.access_token, undefined, "no auth cookie until /mfa/verify");
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔐 /auth/mfa/verify");
    // ──────────────────────────────────────────────────────────────────────

    await test("/mfa/verify with valid TOTP sets cookie + amr=[pwd,mfa]", async () => {
      const u = await setupUser("verify-totp");
      const { secret } = await enrollAndEnable(u);
      let res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      const { pendingToken } = await res.json();

      res = await fetch(`${base}/api/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, token: t.generateTotpCode(secret) }),
      });
      assert.equal(res.status, 200);
      const cookies = parseCookies(res);
      assert.ok(cookies.access_token, "verify must set the auth cookie");
      const payload = t.decodeJwtPayload(cookies.access_token.value);
      assert.deepEqual(payload.amr, ["pwd", "mfa"], "MFA-asserted session must be amr=[pwd,mfa]");
    });

    await test("/mfa/verify with invalid TOTP returns 400", async () => {
      const u = await setupUser("verify-400");
      await enrollAndEnable(u);
      let res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      const { pendingToken } = await res.json();

      res = await fetch(`${base}/api/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, token: "000000" }),
      });
      assert.equal(res.status, 400);
    });

    await test("/mfa/verify pendingToken is single-use", async () => {
      const u = await setupUser("verify-single-use");
      const { secret } = await enrollAndEnable(u);
      let res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      const { pendingToken } = await res.json();

      // First verify succeeds and consumes the token.
      res = await fetch(`${base}/api/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, token: t.generateTotpCode(secret) }),
      });
      assert.equal(res.status, 200);

      // Second verify with the same pendingToken fails with 401.
      res = await fetch(`${base}/api/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, token: t.generateTotpCode(secret) }),
      });
      assert.equal(res.status, 401);
    });

    await test("/mfa/verify with recovery code consumes it (second use fails)", async () => {
      const u = await setupUser("verify-recovery");
      const { recoveryCodes } = await enrollAndEnable(u);
      const code = recoveryCodes[0];

      // First login: use recovery code
      let res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      let pending = (await res.json()).pendingToken;
      res = await fetch(`${base}/api/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken: pending, token: code }),
      });
      assert.equal(res.status, 200, "first use of recovery code should succeed");

      // Remaining count should be 7
      const factors = await (await fetch(`${base}/api/v1/auth/mfa/factors`, {
        headers: { Cookie: parseCookies(res).access_token ? `access_token=${parseCookies(res).access_token.value}` : "" },
      })).json();
      assert.equal(factors.recoveryCodesRemaining, 7);

      // Second login: same recovery code must fail
      res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      pending = (await res.json()).pendingToken;
      res = await fetch(`${base}/api/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken: pending, token: code }),
      });
      assert.equal(res.status, 400, "consumed recovery code must be rejected on reuse");
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔐 /auth/mfa/recovery-codes/regenerate");
    // ──────────────────────────────────────────────────────────────────────

    await test("regenerate requires password (403 on wrong password)", async () => {
      const u = await setupUser("regen-403");
      await enrollAndEnable(u);
      const res = await fetch(`${base}/api/v1/auth/mfa/recovery-codes/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: "WrongPassword!" }),
      });
      assert.equal(res.status, 403);
    });

    await test("regenerate issues fresh codes and invalidates the old set", async () => {
      const u = await setupUser("regen-ok");
      const { recoveryCodes: oldCodes } = await enrollAndEnable(u);
      const res = await fetch(`${base}/api/v1/auth/mfa/recovery-codes/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: u.password }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.recoveryCodes.length, 8);
      // No overlap with the old set (probability of collision is ~2^-32 per code).
      const overlap = body.recoveryCodes.filter((c) => oldCodes.includes(c));
      assert.equal(overlap.length, 0, "regenerated codes must not overlap old set");

      // Old code should no longer work at verify
      let loginRes = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      const { pendingToken } = await loginRes.json();
      const vRes = await fetch(`${base}/api/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, token: oldCodes[0] }),
      });
      assert.equal(vRes.status, 400, "old recovery code must be invalid after regenerate");
    });

    await test("regenerate returns 400 when MFA is not enabled", async () => {
      const u = await setupUser("regen-400-noenable");
      const res = await fetch(`${base}/api/v1/auth/mfa/recovery-codes/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: u.password }),
      });
      assert.equal(res.status, 400);
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔐 /auth/mfa/disable");
    // ──────────────────────────────────────────────────────────────────────

    await test("/mfa/disable requires correct password (403 on wrong)", async () => {
      const u = await setupUser("disable-403");
      await enrollAndEnable(u);
      const res = await fetch(`${base}/api/v1/auth/mfa/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: "WrongPassword!" }),
      });
      assert.equal(res.status, 403);
    });

    await test("/mfa/disable clears secret + recovery + flag", async () => {
      const u = await setupUser("disable-ok");
      await enrollAndEnable(u);
      const res = await fetch(`${base}/api/v1/auth/mfa/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: u.password }),
      });
      assert.equal(res.status, 200);
      const db = t.getDatabase();
      const row = db.prepare("SELECT mfaEnabled, mfaSecret, mfaRecoveryCodes FROM users WHERE id = ?").get(u.user.id);
      assert.equal(row.mfaEnabled, 0);
      assert.equal(row.mfaSecret, null);
      assert.equal(row.mfaRecoveryCodes, null);
    });

    // ──────────────────────────────────────────────────────────────────────
    console.log("\n🔐 Audit logging");
    // ──────────────────────────────────────────────────────────────────────

    await test("enroll/enable/disable emit auth.mfa.* activity rows", async () => {
      const u = await setupUser("audit");
      await enrollAndEnable(u);
      await fetch(`${base}/api/v1/auth/mfa/disable`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        body: JSON.stringify({ password: u.password }),
      });

      const db = t.getDatabase();
      const rows = db.prepare("SELECT type FROM activities WHERE userId = ? ORDER BY createdAt ASC").all(u.user.id);
      const types = rows.map((r) => r.type);
      assert.ok(types.includes("auth.mfa.enroll_started"), `expected auth.mfa.enroll_started, got ${types.join(",")}`);
      assert.ok(types.includes("auth.mfa.enabled"), `expected auth.mfa.enabled, got ${types.join(",")}`);
      assert.ok(types.includes("auth.mfa.disabled"), `expected auth.mfa.disabled, got ${types.join(",")}`);
    });

    await test("recovery-code consumption emits auth.mfa.recovery_code_consumed", async () => {
      const u = await setupUser("audit-recovery");
      const { recoveryCodes } = await enrollAndEnable(u);
      let res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: u.password }),
      });
      const { pendingToken } = await res.json();
      await fetch(`${base}/api/v1/auth/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, token: recoveryCodes[0] }),
      });

      const db = t.getDatabase();
      const row = db.prepare(
        "SELECT type, meta FROM activities WHERE userId = ? AND type = 'auth.mfa.recovery_code_consumed'"
      ).get(u.user.id);
      assert.ok(row, "recovery_code_consumed activity should exist");
      const meta = JSON.parse(row.meta);
      assert.equal(meta.remaining, 7);
    });

    summary("MFA TOTP");
    console.log("\n🎉 All MFA TOTP tests passed!");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ auth-mfa-totp failed:", err);
  process.exit(1);
});

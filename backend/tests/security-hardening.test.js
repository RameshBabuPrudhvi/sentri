/**
 * @module tests/security-hardening
 * @description Regression tests for the security hardening PR (#78).
 *
 * Covers:
 *   - Password reset: DB-backed tokens survive the full forgot → reset flow
 *   - Password reset: used token cannot be replayed (TOCTOU regression)
 *   - Password reset: expired token is rejected
 *   - JWT name claim: login JWT contains the user's display name
 *   - JWT name claim: refresh JWT also contains name
 *   - Audit trail: activities created by authenticated routes include userId and userName
 *   - Audit trail: activities record the user's display name (not just email)
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req, getDatabase, extractCookie, decodeJwtPayload } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, projectsRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();

  const env = t.setupEnv({
    ENABLE_DEV_RESET_TOKENS: "true",
    SKIP_EMAIL_VERIFICATION: "true",
  });

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const email = `sec-${Date.now()}@test.local`;
    const password = "Password123!";
    const newPassword = "NewPassword456!";

    // ── Register + Login ──────────────────────────────────────────────────
    const { token, payload: loginPayload } = await t.registerAndLogin(base, {
      name: "Security User", email, password,
    });

    // ── JWT name claim: login token contains name ─────────────────────────
    assert.equal(loginPayload.name, "Security User", "Login JWT should contain user's display name");
    assert.equal(loginPayload.email, email, "Login JWT should contain email");
    assert.ok(loginPayload.sub, "Login JWT should contain sub");

    // ── JWT name claim: refresh token also contains name ──────────────────
    let out = await req(base, "/api/auth/refresh", {
      method: "POST",
      token,
    });
    assert.equal(out.res.status, 200);
    const refreshToken = extractCookie(out.res, "access_token");
    assert.ok(refreshToken, "Refresh should set new access_token cookie");
    const refreshPayload = decodeJwtPayload(refreshToken);
    assert.equal(refreshPayload.name, "Security User", "Refresh JWT should contain user's display name");

    // Use the refreshed token for subsequent requests
    const authToken = refreshToken;

    // ── Audit trail: project create records userId and userName ────────────
    out = await req(base, "/api/projects", {
      method: "POST",
      token: authToken,
      body: { name: "Audit App", url: "https://example.com" },
    });
    assert.equal(out.res.status, 201);

    const activities = activityRepo.getAll();
    const createActivity = activities.find(a => a.type === "project.create");
    assert.ok(createActivity, "project.create activity should exist");
    assert.equal(createActivity.userId, loginPayload.sub, "Activity should record userId from JWT");
    assert.equal(createActivity.userName, "Security User", "Activity should record display name (not email)");

    // ── Password reset: full forgot → reset flow ──────────────────────────
    out = await req(base, "/api/auth/forgot-password", {
      method: "POST",
      body: { email },
    });
    assert.equal(out.res.status, 200);
    assert.ok(out.json.resetToken, "Dev mode should return resetToken in response");
    const resetToken = out.json.resetToken;

    // Verify token is in the DB
    const db = getDatabase();
    const dbToken = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get(resetToken);
    assert.ok(dbToken, "Reset token should be persisted in DB");
    assert.equal(dbToken.usedAt, null, "Token should not be used yet");

    // Reset password with the token
    out = await req(base, "/api/auth/reset-password", {
      method: "POST",
      body: { token: resetToken, newPassword },
    });
    assert.equal(out.res.status, 200);
    assert.ok(out.json.message.includes("reset successfully"), "Should confirm password reset");

    // Verify token is now marked as used in DB
    const usedToken = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get(resetToken);
    assert.ok(usedToken.usedAt, "Token should be marked as used after reset");

    // ── Password reset: used token cannot be replayed (TOCTOU regression) ─
    out = await req(base, "/api/auth/reset-password", {
      method: "POST",
      body: { token: resetToken, newPassword: "AnotherPassword789!" },
    });
    assert.equal(out.res.status, 400, "Replaying a used token should fail");
    assert.ok(out.json.error.includes("Invalid or expired"), "Error should indicate invalid token");

    // ── Login with new password works ─────────────────────────────────────
    out = await req(base, "/api/auth/login", {
      method: "POST",
      body: { email, password: newPassword },
    });
    assert.equal(out.res.status, 200, "Login with new password should succeed");

    // ── Login with old password fails ─────────────────────────────────────
    out = await req(base, "/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(out.res.status, 401, "Login with old password should fail");

    // ── Password reset: expired token is rejected ─────────────────────────
    // Request a new token, then manually expire it in the DB
    out = await req(base, "/api/auth/forgot-password", {
      method: "POST",
      body: { email },
    });
    assert.equal(out.res.status, 200);
    const expiredToken = out.json.resetToken;

    // Manually set expiresAt to the past
    db.prepare("UPDATE password_reset_tokens SET expiresAt = ? WHERE token = ?")
      .run(new Date(Date.now() - 60 * 1000).toISOString(), expiredToken);

    out = await req(base, "/api/auth/reset-password", {
      method: "POST",
      body: { token: expiredToken, newPassword: "YetAnother000!" },
    });
    assert.equal(out.res.status, 400, "Expired token should be rejected");
    assert.ok(out.json.error.includes("Invalid or expired"), "Error should indicate expired token");

    // ── Password reset: second forgot-password invalidates first token ────
    out = await req(base, "/api/auth/forgot-password", {
      method: "POST",
      body: { email },
    });
    const token1 = out.json.resetToken;

    out = await req(base, "/api/auth/forgot-password", {
      method: "POST",
      body: { email },
    });
    const token2 = out.json.resetToken;
    assert.notEqual(token1, token2, "Two forgot-password requests should produce different tokens");

    // First token should be invalidated
    out = await req(base, "/api/auth/reset-password", {
      method: "POST",
      body: { token: token1, newPassword: "FirstToken111!" },
    });
    assert.equal(out.res.status, 400, "First token should be invalidated after second request");

    // Second token should work
    out = await req(base, "/api/auth/reset-password", {
      method: "POST",
      body: { token: token2, newPassword: "SecondToken222!" },
    });
    assert.equal(out.res.status, 200, "Second (latest) token should work");

    console.log("✅ security-hardening: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ security-hardening failed:", err);
  process.exit(1);
});

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
import { app } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import { getDatabase } from "../src/database/sqlite.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, projectsRouter);
  mounted = true;
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM password_reset_tokens");
  db.exec("DELETE FROM healing_history");
  db.exec("DELETE FROM activities");
  db.exec("DELETE FROM runs");
  db.exec("DELETE FROM tests");
  db.exec("DELETE FROM oauth_ids");
  db.exec("DELETE FROM projects");
  db.exec("DELETE FROM users");
  db.exec("UPDATE counters SET value = 0");
}

/** Extract a named cookie value from a fetch Response's Set-Cookie header. */
function extractCookie(res, name) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const match = c.match(new RegExp(`^${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

/** Decode a JWT payload (no signature verification — just base64url decode). */
function decodeJwtPayload(token) {
  const parts = token.split(".");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString());
}

/** Shared CSRF token — captured from the first server response that sets it. */
let csrfToken = null;

async function req(base, path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
    headers.Cookie = (headers.Cookie ? headers.Cookie + "; " : "") + `_csrf=${csrfToken}`;
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const csrf = extractCookie(res, "_csrf");
  if (csrf) csrfToken = csrf;
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function main() {
  mountRoutesOnce();
  resetDb();

  // Enable dev reset tokens so the forgot-password response includes the token
  const origEnv = process.env.ENABLE_DEV_RESET_TOKENS;
  process.env.ENABLE_DEV_RESET_TOKENS = "true";
  // Skip email verification so test users can log in immediately
  const origSkipVerify = process.env.SKIP_EMAIL_VERIFICATION;
  process.env.SKIP_EMAIL_VERIFICATION = "true";

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const email = `sec-${Date.now()}@test.local`;
    const password = "Password123!";
    const newPassword = "NewPassword456!";

    // ── Register + Login ──────────────────────────────────────────────────
    let out = await req(base, "/api/auth/register", {
      method: "POST",
      body: { name: "Security User", email, password },
    });
    assert.equal(out.res.status, 201);

    out = await req(base, "/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(out.res.status, 200);
    const token = extractCookie(out.res, "access_token");
    assert.ok(token, "Login should set access_token cookie");

    // ── JWT name claim: login token contains name ─────────────────────────
    const loginPayload = decodeJwtPayload(token);
    assert.equal(loginPayload.name, "Security User", "Login JWT should contain user's display name");
    assert.equal(loginPayload.email, email, "Login JWT should contain email");
    assert.ok(loginPayload.sub, "Login JWT should contain sub");

    // ── JWT name claim: refresh token also contains name ──────────────────
    out = await req(base, "/api/auth/refresh", {
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
    process.env.ENABLE_DEV_RESET_TOKENS = origEnv;
    process.env.SKIP_EMAIL_VERIFICATION = origSkipVerify;
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ security-hardening failed:", err);
  process.exit(1);
});

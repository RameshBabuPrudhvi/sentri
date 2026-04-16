/**
 * @module tests/auth-cookies
 * @description Tests for cookie-based auth, CSRF middleware, and session refresh.
 *
 * Covers:
 *   - Login sets access_token (HttpOnly) and token_exp cookies
 *   - Login response body does NOT contain a token field
 *   - GET /api/auth/me works with cookie auth
 *   - POST /api/auth/refresh issues a new token and sets new cookies
 *   - POST /api/auth/logout clears auth cookies
 *   - CSRF middleware blocks mutating requests without X-CSRF-Token header
 *   - CSRF middleware allows safe methods (GET) without X-CSRF-Token
 *   - CSRF middleware allows exempt paths (login, register) without X-CSRF-Token
 */

import assert from "node:assert/strict";
import { app } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import { getDatabase } from "../src/database/sqlite.js";

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, projectsRouter);
  mounted = true;
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM healing_history");
  db.exec("DELETE FROM activities");
  db.exec("DELETE FROM runs");
  db.exec("DELETE FROM tests");
  db.exec("DELETE FROM oauth_ids");
  db.exec("DELETE FROM projects");
  db.exec("DELETE FROM users");
  db.exec("UPDATE counters SET value = 0");
}

/** Parse all Set-Cookie headers into a map of { name → { value, attrs } }. */
function parseCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  const cookies = {};
  for (const c of raw) {
    const parts = c.split(";").map(s => s.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf("=");
    const name = nameVal.slice(0, eqIdx);
    const value = nameVal.slice(eqIdx + 1);
    cookies[name] = { value, attrs: attrs.map(a => a.toLowerCase()) };
  }
  return cookies;
}

/** Build a Cookie header string from a parsed cookies map. */
function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v.value}`).join("; ");
}

async function main() {
  mountRoutesOnce();
  resetDb();

  // Skip email verification so test users can log in immediately (SEC-001)
  const origSkipVerify = process.env.SKIP_EMAIL_VERIFICATION;
  process.env.SKIP_EMAIL_VERIFICATION = "true";

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const email = `cookie-${Date.now()}@test.local`;

    // ── Register ──────────────────────────────────────────────────────────
    let res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cookie User", email, password: "Password123!" }),
    });
    assert.equal(res.status, 201);

    // ── Login sets correct cookies ────────────────────────────────────────
    res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!" }),
    });
    assert.equal(res.status, 200);

    const loginCookies = parseCookies(res);
    assert.ok(loginCookies.access_token, "Login should set access_token cookie");
    assert.ok(loginCookies.access_token.attrs.some(a => a === "httponly"), "access_token should be HttpOnly");
    assert.ok(loginCookies.access_token.attrs.some(a => a.startsWith("samesite")), "access_token should have SameSite");
    assert.ok(loginCookies.token_exp, "Login should set token_exp cookie");
    assert.ok(!loginCookies.token_exp.attrs.some(a => a === "httponly"), "token_exp should NOT be HttpOnly");

    const loginBody = await res.json();
    assert.equal(loginBody.token, undefined, "Login response should NOT contain token in body");
    assert.ok(loginBody.user, "Login response should contain user");
    assert.ok(loginBody.user.id, "User should have an id");

    // Also grab the CSRF cookie (set by middleware on first request)
    const csrfCookie = loginCookies._csrf;
    assert.ok(csrfCookie, "CSRF cookie should be set on login response");

    // Build cookie header for subsequent requests
    const cookieHeader = buildCookieHeader(loginCookies);
    const token = loginCookies.access_token.value;

    // ── GET /me with cookie auth ──────────────────────────────────────────
    res = await fetch(`${base}/api/auth/me`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.equal(me.email, email, "/me should return the authenticated user");

    // ── CSRF: GET should work without X-CSRF-Token ────────────────────────
    res = await fetch(`${base}/api/projects`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(res.status, 200, "GET should not require CSRF token");

    // ── CSRF: POST should fail without X-CSRF-Token ───────────────────────
    res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ name: "No CSRF", url: "https://example.com" }),
    });
    assert.equal(res.status, 403, "POST without CSRF token should be 403");
    const csrfErr = await res.json();
    assert.ok(csrfErr.error.includes("CSRF"), "Error should mention CSRF");

    // ── CSRF: POST should succeed with correct X-CSRF-Token ───────────────
    res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "X-CSRF-Token": csrfCookie.value,
      },
      body: JSON.stringify({ name: "With CSRF", url: "https://example.com" }),
    });
    assert.equal(res.status, 201, "POST with correct CSRF token should succeed");

    // ── CSRF: POST should fail with wrong X-CSRF-Token ────────────────────
    res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "X-CSRF-Token": "wrong-token",
      },
      body: JSON.stringify({ name: "Bad CSRF", url: "https://example.com" }),
    });
    assert.equal(res.status, 403, "POST with wrong CSRF token should be 403");

    // ── CSRF: exempt paths should work without X-CSRF-Token ───────────────
    res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Password123!" }),
    });
    assert.equal(res.status, 200, "Login (exempt path) should not require CSRF");

    // ── Refresh session ───────────────────────────────────────────────────
    // Refresh is CSRF-exempt, so no X-CSRF-Token needed
    res = await fetch(`${base}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
    });
    assert.equal(res.status, 200, "Refresh should succeed with valid cookie");
    const refreshCookies = parseCookies(res);
    assert.ok(refreshCookies.access_token, "Refresh should set new access_token cookie");
    assert.notEqual(refreshCookies.access_token.value, token, "Refresh should issue a different token");
    const refreshBody = await res.json();
    assert.ok(refreshBody.user, "Refresh should return user");

    // Old token should be revoked
    res = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401, "Old token should be revoked after refresh");

    // New token should work
    const newCookieHeader = buildCookieHeader(refreshCookies);
    res = await fetch(`${base}/api/auth/me`, {
      headers: { Cookie: newCookieHeader },
    });
    assert.equal(res.status, 200, "New token from refresh should work");

    // ── Logout clears cookies ─────────────────────────────────────────────
    res = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: newCookieHeader },
    });
    assert.equal(res.status, 200);
    const logoutCookies = parseCookies(res);
    assert.ok(logoutCookies.access_token, "Logout should set access_token cookie");
    assert.equal(logoutCookies.access_token.value, "", "Logout should clear access_token value");
    assert.ok(logoutCookies.access_token.attrs.some(a => a === "max-age=0"), "Logout should set Max-Age=0");

    console.log("✅ auth-cookies: all checks passed");
  } finally {
    process.env.SKIP_EMAIL_VERIFICATION = origSkipVerify;
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ auth-cookies failed:", err);
  process.exit(1);
});

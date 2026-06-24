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
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import workspacesRouter from "../src/routes/workspaces.js";
import * as workspaceRepo from "../src/database/repositories/workspaceRepo.js";
import { createTestContext, parseCookies, buildCookieHeader } from "./helpers/test-base.js";

const t = createTestContext();
const runner = t.createTestRunner();
const { app, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, workspaceScope, projectsRouter);
  app.use("/api/workspaces", requireAuth, workspaceScope, workspacesRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();

  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const email = `cookie-${Date.now()}@test.local`;

    // Shared state populated by the early test cases and consumed by the
    // later ones — kept in the outer scope so each `runner.test` is still
    // small but the flow stays linear.
    let loginCookies, csrfCookie, cookieHeader, token, originalWorkspaceId;

    await runner.test("register returns 201", async () => {
      const res = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Cookie User", email, password: "Password123!" }),
      });
      assert.equal(res.status, 201);
    });

    await runner.test("login sets HttpOnly access_token + non-HttpOnly token_exp cookies, omits token from body", async () => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "Password123!" }),
      });
      assert.equal(res.status, 200);

      loginCookies = parseCookies(res);
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
      csrfCookie = loginCookies._csrf;
      assert.ok(csrfCookie, "CSRF cookie should be set on login response");

      // Build cookie header for subsequent requests
      cookieHeader = buildCookieHeader(loginCookies);
      token = loginCookies.access_token.value;
    });

    await runner.test("GET /me works with cookie auth", async () => {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: cookieHeader },
      });
      assert.equal(res.status, 200);
      const me = await res.json();
      assert.equal(me.email, email, "/me should return the authenticated user");
      originalWorkspaceId = me.workspaceId;
    });

    // Re-fetch /me to grab user.id for the workspace-create step.
    const meRes = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookieHeader } });
    const me = await meRes.json();

    // ── Workspace switch should persist across /me and /refresh ─────────────
    const secondaryWorkspace = workspaceRepo.create({
      name: "Secondary Workspace",
      slug: `secondary-${Date.now()}`,
      ownerId: me.id,
    });

    let switchedCookieHeader, switchedToken;

    await runner.test("workspace switch returns 200 and rotates the access_token", async () => {
      const res = await fetch(`${base}/api/workspaces/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader, "X-CSRF-Token": csrfCookie.value },
        body: JSON.stringify({ workspaceId: secondaryWorkspace.id }),
      });
      assert.equal(res.status, 200, "Switch should succeed for owned workspace");
      const switchCookies = parseCookies(res);
      // Carry forward the _csrf cookie from login (switch response only sets auth cookies)
      if (csrfCookie && !switchCookies._csrf) switchCookies._csrf = csrfCookie;
      switchedCookieHeader = buildCookieHeader(switchCookies);
      switchedToken = switchCookies.access_token.value;
      const switchedUser = (await res.json()).user;
      assert.equal(switchedUser.workspaceId, secondaryWorkspace.id, "Switch response should reflect target workspace");
    });

    await runner.test("/me reflects switched workspace from new token", async () => {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: switchedCookieHeader },
      });
      assert.equal(res.status, 200);
      const switchedMe = await res.json();
      assert.equal(switchedMe.workspaceId, secondaryWorkspace.id, "/me should preserve switched workspace");
      assert.notEqual(switchedMe.workspaceId, originalWorkspaceId, "Switched workspace should differ from original");
    });

    let newCookieHeader;

    await runner.test("CSRF: GET should not require X-CSRF-Token", async () => {
      // Use switchedCookieHeader — the original token was revoked by workspace switch.
      const res = await fetch(`${base}/api/projects`, {
        headers: { Cookie: switchedCookieHeader },
      });
      assert.equal(res.status, 200, "GET should not require CSRF token");
    });

    await runner.test("CSRF: POST without X-CSRF-Token → 403", async () => {
      const res = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: switchedCookieHeader },
        body: JSON.stringify({ name: "No CSRF", url: "https://example.com" }),
      });
      assert.equal(res.status, 403, "POST without CSRF token should be 403");
      const csrfErr = await res.json();
      assert.ok(csrfErr.error.includes("CSRF"), "Error should mention CSRF");
    });

    await runner.test("CSRF: POST with correct X-CSRF-Token succeeds", async () => {
      const res = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: switchedCookieHeader,
          "X-CSRF-Token": csrfCookie.value,
        },
        body: JSON.stringify({ name: "With CSRF", url: "https://example.com" }),
      });
      assert.equal(res.status, 201, "POST with correct CSRF token should succeed");
    });

    await runner.test("CSRF: POST with wrong X-CSRF-Token → 403", async () => {
      const res = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: switchedCookieHeader,
          "X-CSRF-Token": "wrong-token",
        },
        body: JSON.stringify({ name: "Bad CSRF", url: "https://example.com" }),
      });
      assert.equal(res.status, 403, "POST with wrong CSRF token should be 403");
    });

    await runner.test("CSRF: exempt paths (login) work without X-CSRF-Token", async () => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "Password123!" }),
      });
      assert.equal(res.status, 200, "Login (exempt path) should not require CSRF");
    });

    await runner.test("refresh issues new access_token, preserves switched workspace, revokes old token", async () => {
      // Refresh is CSRF-exempt, so no X-CSRF-Token needed
      const res = await fetch(`${base}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: switchedCookieHeader },
      });
      assert.equal(res.status, 200, "Refresh should succeed with valid cookie");
      const refreshCookies = parseCookies(res);
      assert.ok(refreshCookies.access_token, "Refresh should set new access_token cookie");
      assert.notEqual(refreshCookies.access_token.value, switchedToken, "Refresh should issue a different token");
      const refreshBody = await res.json();
      assert.ok(refreshBody.user, "Refresh should return user");
      assert.equal(refreshBody.user.workspaceId, secondaryWorkspace.id, "Refresh response should preserve switched workspace");

      // Old (switched) token should be revoked
      const oldRes = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: `Bearer ${switchedToken}` },
      });
      assert.equal(oldRes.status, 401, "Old token should be revoked after refresh");

      // New token should work
      newCookieHeader = buildCookieHeader(refreshCookies);
      const newRes = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: newCookieHeader },
      });
      assert.equal(newRes.status, 200, "New token from refresh should work");
    });

    await runner.test("logout clears access_token cookie (empty value + Max-Age=0)", async () => {
      const res = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: newCookieHeader },
      });
      assert.equal(res.status, 200);
      const logoutCookies = parseCookies(res);
      assert.ok(logoutCookies.access_token, "Logout should set access_token cookie");
      assert.equal(logoutCookies.access_token.value, "", "Logout should clear access_token value");
      assert.ok(logoutCookies.access_token.attrs.some(a => a === "max-age=0"), "Logout should set Max-Age=0");
    });

    runner.summary("auth-cookies");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ auth-cookies failed:", err);
  process.exit(1);
});

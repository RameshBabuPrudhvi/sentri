/**
 * @module tests/trigger-api
 * @description Integration tests for ENH-011 — CI/CD trigger endpoint and
 * trigger-token management routes.
 *
 * Exercises the full HTTP flow for:
 *   - POST   /api/projects/:id/trigger-tokens   (create token — JWT auth)
 *   - GET    /api/projects/:id/trigger-tokens    (list tokens — JWT auth)
 *   - DELETE /api/projects/:id/trigger-tokens/:tid (revoke — JWT auth)
 *   - POST   /api/projects/:id/trigger           (Bearer token auth, CSRF-exempt)
 *   - GET    /api/projects/:id/trigger/runs/:runId (Bearer token auth)
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import { workspaceScope } from "../src/middleware/workspaceScope.js";
import projectsRouter from "../src/routes/projects.js";
import testsRouter from "../src/routes/tests.js";
import runsRouter from "../src/routes/runs.js";
import triggerRouter from "../src/routes/trigger.js";
import { getDatabase } from "../src/database/sqlite.js";

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api", triggerRouter);
  app.use("/api/projects", requireAuth, workspaceScope, projectsRouter);
  app.use("/api", requireAuth, workspaceScope, testsRouter);
  app.use("/api", requireAuth, workspaceScope, runsRouter);
  mounted = true;
}

function extractCookie(res, name) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const match = c.match(new RegExp(`^${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

let csrfToken = null;

async function jwtReq(base, path, { method = "GET", cookie, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
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

async function bearerReq(base, path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  \u2713 " + name);
  } catch (err) {
    failed++;
    console.error("  \u2717 " + name + ": " + err.message);
  }
}

async function main() {
  mountRoutesOnce();
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  try {
    const email = `trigger-${Date.now()}@test.local`;
    let out;

    out = await jwtReq(base, "/api/auth/register", {
      method: "POST", body: { name: "Trigger Tester", email, password: "Password123!" },
    });
    assert.equal(out.res.status, 201);

    // SEC-001: Mark test user as verified so login succeeds
    const db = getDatabase();
    db.prepare("UPDATE users SET emailVerified = 1 WHERE email = ?").run(email);

    out = await jwtReq(base, "/api/auth/login", {
      method: "POST", body: { email, password: "Password123!" },
    });
    const accessToken = extractCookie(out.res, "access_token");
    const authCookie = "access_token=" + accessToken;

    out = await jwtReq(base, "/api/projects", {
      method: "POST", cookie: authCookie,
      body: { name: "Trigger Project", url: "https://example.com" },
    });
    const projectId = out.json.id;

    out = await jwtReq(base, "/api/projects", {
      method: "POST", cookie: authCookie,
      body: { name: "Other Project", url: "https://other.com" },
    });
    const otherProjectId = out.json.id;

    out = await jwtReq(base, `/api/projects/${projectId}/tests`, {
      method: "POST", cookie: authCookie,
      body: { name: "Trigger test", steps: ["Open app", "Click button"] },
    });
    const testId = out.json.id;

    await jwtReq(base, `/api/projects/${projectId}/tests/${testId}/approve`, {
      method: "PATCH", cookie: authCookie,
    });

    console.log("\n\u2500\u2500 Trigger token management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("GET trigger-tokens returns empty array initially", async () => {
      out = await jwtReq(base, `/api/projects/${projectId}/trigger-tokens`, { cookie: authCookie });
      assert.equal(out.res.status, 200);
      assert.deepEqual(out.json, []);
    });

    let triggerToken, tokenId;

    await test("POST trigger-tokens creates a token", async () => {
      out = await jwtReq(base, `/api/projects/${projectId}/trigger-tokens`, {
        method: "POST", cookie: authCookie, body: { label: "CI token" },
      });
      assert.equal(out.res.status, 201);
      assert.ok(out.json.id);
      assert.ok(out.json.token);
      assert.equal(out.json.label, "CI token");
      triggerToken = out.json.token;
      tokenId = out.json.id;
    });

    await test("GET trigger-tokens lists the token (no hash)", async () => {
      out = await jwtReq(base, `/api/projects/${projectId}/trigger-tokens`, { cookie: authCookie });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.length, 1);
      assert.equal(out.json[0].id, tokenId);
      assert.equal(out.json[0].tokenHash, undefined, "tokenHash must not be returned");
    });

    await test("GET trigger-tokens 404 for non-existent project", async () => {
      out = await jwtReq(base, "/api/projects/PRJ-FAKE/trigger-tokens", { cookie: authCookie });
      assert.equal(out.res.status, 404);
    });

    console.log("\n\u2500\u2500 POST /trigger \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("POST trigger 401 without Authorization header", async () => {
      out = await bearerReq(base, `/api/projects/${projectId}/trigger`, { method: "POST" });
      assert.equal(out.res.status, 401);
    });

    await test("POST trigger 401 with invalid token", async () => {
      out = await bearerReq(base, `/api/projects/${projectId}/trigger`, {
        method: "POST", token: "invalid-token-value",
      });
      assert.equal(out.res.status, 401);
    });

    await test("POST trigger 404 for non-existent project", async () => {
      out = await bearerReq(base, "/api/projects/PRJ-FAKE/trigger", {
        method: "POST", token: triggerToken,
      });
      assert.equal(out.res.status, 404);
    });

    await test("POST trigger 403 when token belongs to different project", async () => {
      out = await bearerReq(base, `/api/projects/${otherProjectId}/trigger`, {
        method: "POST", token: triggerToken,
      });
      assert.equal(out.res.status, 403);
    });

    await test("POST trigger 202 with valid token", async () => {
      out = await bearerReq(base, `/api/projects/${projectId}/trigger`, {
        method: "POST", token: triggerToken,
      });
      assert.equal(out.res.status, 202);
      assert.ok(out.json.runId);
      assert.ok(out.json.statusUrl);
    });

    const triggeredRunId = out.json.runId;

    await test("POST trigger 409 when run already in progress", async () => {
      out = await bearerReq(base, `/api/projects/${projectId}/trigger`, {
        method: "POST", token: triggerToken,
      });
      assert.equal(out.res.status, 409);
    });

    console.log("\n\u2500\u2500 GET /trigger/runs/:runId \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("GET trigger run status 401 without token", async () => {
      out = await bearerReq(base, `/api/projects/${projectId}/trigger/runs/${triggeredRunId}`);
      assert.equal(out.res.status, 401);
    });

    await test("GET trigger run status 200 with valid token", async () => {
      out = await bearerReq(base, `/api/projects/${projectId}/trigger/runs/${triggeredRunId}`, {
        token: triggerToken,
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.id, triggeredRunId);
      assert.ok(out.json.status);
    });

    await test("GET trigger run status 403 with cross-project token", async () => {
      out = await bearerReq(base, `/api/projects/${otherProjectId}/trigger/runs/${triggeredRunId}`, {
        token: triggerToken,
      });
      assert.equal(out.res.status, 403);
    });

    await test("GET trigger run status 404 for non-existent run", async () => {
      out = await bearerReq(base, `/api/projects/${projectId}/trigger/runs/RUN-FAKE`, {
        token: triggerToken,
      });
      assert.equal(out.res.status, 404);
    });

    console.log("\n\u2500\u2500 Token revocation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    // Reuse the `db` variable declared above (line 106) — do not redeclare with `const`
    db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(triggeredRunId);

    await test("DELETE trigger-tokens 404 for non-existent token", async () => {
      out = await jwtReq(base, `/api/projects/${projectId}/trigger-tokens/WH-FAKE`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 404);
    });

    out = await jwtReq(base, `/api/projects/${otherProjectId}/trigger-tokens`, {
      method: "POST", cookie: authCookie, body: { label: "other" },
    });
    const otherTokenId = out.json.id;

    await test("DELETE trigger-tokens 404 when token belongs to different project", async () => {
      out = await jwtReq(base, `/api/projects/${projectId}/trigger-tokens/${otherTokenId}`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 404);
    });

    await test("DELETE trigger-tokens succeeds for own token", async () => {
      out = await jwtReq(base, `/api/projects/${projectId}/trigger-tokens/${tokenId}`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.ok, true);
    });

    await test("POST trigger 401 after token revocation", async () => {
      out = await bearerReq(base, `/api/projects/${projectId}/trigger`, {
        method: "POST", token: triggerToken,
      });
      assert.equal(out.res.status, 401);
    });

    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
    console.log("\uD83C\uDF89 All trigger-api integration tests passed!");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("\u2717 trigger-api failed:", err);
  process.exit(1);
});

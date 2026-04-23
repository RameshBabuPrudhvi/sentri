/**
 * @module tests/recorder-baselines-routes
 * @description Integration tests for DIF-001 + DIF-015 HTTP routes (PR #103).
 *
 * Covers the 6 new endpoints introduced by the visual-regression and
 * interactive-recorder features. These tests exercise the full HTTP path —
 * auth, CSRF, workspace scoping, role enforcement, input validation, and
 * response shapes — without launching a real Chromium (the recorder session
 * map is still empty at request time, so the "not found" branches cover most
 * of the route surface).
 *
 *   - GET    /api/tests/:testId/baselines
 *   - POST   /api/tests/:testId/baselines/:stepNumber/accept
 *   - DELETE /api/tests/:testId/baselines/:stepNumber
 *   - POST   /api/projects/:id/record
 *   - POST   /api/projects/:id/record/:sessionId/stop
 *   - GET    /api/projects/:id/record/:sessionId
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import testsRouter from "../src/routes/tests.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req, workspaceScope, getDatabase } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, workspaceScope, projectsRouter);
  app.use("/api", requireAuth, workspaceScope, testsRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const { test, summary } = t.createTestRunner();

  try {
    const email = `recorder-${Date.now()}@test.local`;
    const { token } = await t.registerAndLogin(base, {
      name: "Recorder Tester", email, password: "Password123!",
    });
    const authCookie = `access_token=${token}`;

    // Create a project and one test we can reference from the baseline endpoints.
    let out = await req(base, "/api/projects", {
      method: "POST", cookie: authCookie,
      body: { name: "Recorder Project", url: "https://example.com" },
    });
    assert.equal(out.res.status, 201, `create project failed: ${JSON.stringify(out.json)}`);
    const projectId = out.json.id;

    out = await req(base, `/api/projects/${projectId}/tests`, {
      method: "POST", cookie: authCookie,
      body: { name: "Baseline test", steps: ["Open home"] },
    });
    assert.equal(out.res.status, 201, `create test failed: ${JSON.stringify(out.json)}`);
    const testId = out.json.id;

    console.log("\n── DIF-001: visual-baseline routes ──────────────────────────");

    await test("GET /tests/:id/baselines 401 without auth", async () => {
      const r = await fetch(`${base}/api/tests/${testId}/baselines`);
      assert.equal(r.status, 401);
    });

    await test("GET /tests/:id/baselines returns [] for a test with no baselines yet", async () => {
      out = await req(base, `/api/tests/${testId}/baselines`, { cookie: authCookie });
      assert.equal(out.res.status, 200);
      assert.ok(Array.isArray(out.json));
      assert.equal(out.json.length, 0);
    });

    await test("GET /tests/:id/baselines 404 for unknown test", async () => {
      out = await req(base, `/api/tests/TC-DOES-NOT-EXIST/baselines`, { cookie: authCookie });
      assert.equal(out.res.status, 404);
      assert.ok(out.json.error);
    });

    await test("POST /tests/:id/baselines/:step/accept 400 for missing runId", async () => {
      out = await req(base, `/api/tests/${testId}/baselines/0/accept`, {
        method: "POST", cookie: authCookie, body: {},
      });
      assert.equal(out.res.status, 400);
      assert.match(out.json.error, /runId is required/i);
    });

    await test("POST /tests/:id/baselines/:step/accept 400 for non-numeric stepNumber", async () => {
      out = await req(base, `/api/tests/${testId}/baselines/notanumber/accept`, {
        method: "POST", cookie: authCookie, body: { runId: "RUN-1" },
      });
      assert.equal(out.res.status, 400);
      assert.match(out.json.error, /invalid stepNumber/i);
    });

    await test("POST /tests/:id/baselines/:step/accept 400 for negative stepNumber", async () => {
      out = await req(base, `/api/tests/${testId}/baselines/-1/accept`, {
        method: "POST", cookie: authCookie, body: { runId: "RUN-1" },
      });
      assert.equal(out.res.status, 400);
    });

    await test("POST /tests/:id/baselines/:step/accept 404 for unknown run", async () => {
      out = await req(base, `/api/tests/${testId}/baselines/0/accept`, {
        method: "POST", cookie: authCookie, body: { runId: "RUN-NOPE" },
      });
      assert.equal(out.res.status, 404);
      assert.match(out.json.error, /run not found/i);
    });

    await test("POST /tests/:id/baselines/:step/accept 404 for unknown test", async () => {
      out = await req(base, `/api/tests/TC-GHOST/baselines/0/accept`, {
        method: "POST", cookie: authCookie, body: { runId: "RUN-1" },
      });
      assert.equal(out.res.status, 404);
    });

    await test("DELETE /tests/:id/baselines/:step 200 even when nothing is stored", async () => {
      out = await req(base, `/api/tests/${testId}/baselines/0`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.ok, true);
      // deleted = 0 is fine — the route is idempotent.
      assert.equal(out.json.deleted, 0);
    });

    await test("DELETE /tests/:id/baselines/:step 400 for invalid stepNumber", async () => {
      out = await req(base, `/api/tests/${testId}/baselines/abc`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 400);
    });

    await test("DELETE /tests/:id/baselines/:step 404 for unknown test", async () => {
      out = await req(base, `/api/tests/TC-GHOST/baselines/0`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 404);
    });

    await test("DELETE /tests/:id/baselines/:step 403 for viewer role", async () => {
      // Demote our user to viewer for the active workspace.
      const db = getDatabase();
      const row = db.prepare(
        "SELECT workspaceId FROM workspace_members WHERE userId = (SELECT id FROM users WHERE email = ?) LIMIT 1",
      ).get(email);
      db.prepare("UPDATE workspace_members SET role = 'viewer' WHERE userId = (SELECT id FROM users WHERE email = ?) AND workspaceId = ?").run(email, row.workspaceId);

      out = await req(base, `/api/tests/${testId}/baselines/0`, {
        method: "DELETE", cookie: authCookie,
      });
      assert.equal(out.res.status, 403);
      assert.match(out.json.error, /qa_lead/i);

      // Restore role for the remaining tests.
      db.prepare("UPDATE workspace_members SET role = 'admin' WHERE userId = (SELECT id FROM users WHERE email = ?) AND workspaceId = ?").run(email, row.workspaceId);
    });

    console.log("\n── DIF-015: recorder routes ─────────────────────────────────");

    await test("POST /projects/:id/record 401 without auth", async () => {
      const r = await fetch(`${base}/api/projects/${projectId}/record`, { method: "POST" });
      assert.equal(r.status, 401);
    });

    await test("POST /projects/:id/record 400 for invalid startUrl", async () => {
      out = await req(base, `/api/projects/${projectId}/record`, {
        method: "POST", cookie: authCookie, body: { startUrl: "not-a-url" },
      });
      assert.equal(out.res.status, 400);
      assert.match(out.json.error, /http\(s\) URL/i);
    });

    await test("POST /projects/:id/record 404 for unknown project", async () => {
      out = await req(base, "/api/projects/PRJ-GHOST/record", {
        method: "POST", cookie: authCookie, body: { startUrl: "https://example.com" },
      });
      assert.equal(out.res.status, 404);
    });

    await test("GET /projects/:id/record/:sessionId 404 for unknown session", async () => {
      out = await req(base, `/api/projects/${projectId}/record/REC-ghost`, { cookie: authCookie });
      assert.equal(out.res.status, 404);
      assert.match(out.json.error, /session not found/i);
    });

    await test("POST /projects/:id/record/:sessionId/stop 404 for unknown session", async () => {
      out = await req(base, `/api/projects/${projectId}/record/REC-ghost/stop`, {
        method: "POST", cookie: authCookie, body: { name: "whatever" },
      });
      assert.equal(out.res.status, 404);
    });

    await test("POST /projects/:id/record/:sessionId/stop 404 for unknown project", async () => {
      out = await req(base, "/api/projects/PRJ-GHOST/record/REC-ghost/stop", {
        method: "POST", cookie: authCookie, body: { name: "x" },
      });
      assert.equal(out.res.status, 404);
    });
  } finally {
    summary("recorder/baseline routes");
    env.restore();
    await new Promise((r) => server.close(r));
  }
}

main().catch((err) => {
  console.error("❌ recorder-baselines-routes failed:", err);
  process.exit(1);
});

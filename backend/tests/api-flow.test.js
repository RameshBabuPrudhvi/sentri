/**
 * @module tests/api-flow
 * @description End-to-end API lifecycle smoke test without external framework.
 *
 * API flow integration smoke tests (no external framework).
 *
 * Covers: auth -> project create -> test create -> approve -> run guard -> abort lifecycle.
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import testsRouter from "../src/routes/tests.js";
import runsRouter from "../src/routes/runs.js";
import sseRouter from "../src/routes/sse.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, workspaceScope, projectsRouter);
  app.use("/api", requireAuth, workspaceScope, testsRouter);
  app.use("/api", requireAuth, workspaceScope, runsRouter);
  app.use("/api", requireAuth, workspaceScope, sseRouter);
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
    const { token } = await t.registerAndLogin(base, {
      name: "QA User",
      email: `qa-${Date.now()}@test.local`,
      password: "Password123!",
    });

    let out = await req(base, "/api/projects", {
      method: "POST",
      token,
      body: { name: "Flow App", url: "https://example.com" },
    });
    assert.equal(out.res.status, 201);
    const projectId = out.json.id;
    assert.ok(projectId);

    out = await req(base, `/api/projects/${projectId}/tests`, {
      method: "POST",
      token,
      body: { name: "Login test", steps: ["Open app", "Click login"] },
    });
    assert.equal(out.res.status, 201);
    const testId = out.json.id;

    out = await req(base, `/api/projects/${projectId}/tests/${testId}/approve`, {
      method: "PATCH",
      token,
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.reviewStatus, "approved");

    // Seed an active run and verify duplicate-run guard (409).
    runRepo.create({
      id: "RUN_ACTIVE",
      projectId,
      type: "test_run",
      status: "running",
      startedAt: new Date().toISOString(),
      logs: [],
      tests: [],
      results: [],
    });

    out = await req(base, `/api/projects/${projectId}/run`, { method: "POST", token });
    assert.equal(out.res.status, 409);

    // Abort lifecycle should transition run to aborted.
    out = await req(base, "/api/runs/RUN_ACTIVE/abort", { method: "POST", token });
    assert.equal(out.res.status, 200);

    out = await req(base, "/api/runs/RUN_ACTIVE", { token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.status, "aborted");

    // ── Bulk approve with per-test audit trail (PR #66) ──────────────────
    // Create a second test so we can bulk-approve both and verify individual
    // activity log entries are created for each test.
    out = await req(base, `/api/projects/${projectId}/tests`, {
      method: "POST",
      token,
      body: { name: "Signup test", steps: ["Open app", "Click signup"] },
    });
    assert.equal(out.res.status, 201);
    const testId2 = out.json.id;

    // Restore both tests to draft first (testId was approved above)
    await req(base, `/api/projects/${projectId}/tests/${testId}/restore`, { method: "PATCH", token });

    // Bulk approve both tests
    out = await req(base, `/api/projects/${projectId}/tests/bulk`, {
      method: "POST",
      token,
      body: { testIds: [testId, testId2], action: "approve" },
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.updated, 2, "Should approve 2 tests");

    // Verify per-test activity entries were created
    const activities = activityRepo.getAll();
    const perTestApprovals = activities.filter(a =>
      a.type === "test.approve" && a.detail?.includes("(bulk)")
    );
    assert.ok(perTestApprovals.length >= 2, `Should have ≥2 per-test audit entries, got ${perTestApprovals.length}`);

    console.log("✅ api-flow: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ api-flow failed:", err);
  process.exit(1);
});

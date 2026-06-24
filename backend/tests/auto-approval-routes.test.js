// Integration tests for AUTO-003b HTTP routes:
//   - POST /api/v1/tests/:testId/revoke      (qa_lead+)
//   - GET  /api/v1/projects/:id/approval-stats
//
// Companion to backend/tests/auto-approval.test.js, which covers the
// pipeline-level auto-approval + revoke logic via direct repo calls. This
// file exercises the actual Express handlers end-to-end so the route
// guards, workspace scoping, and JSON shape are covered.

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import testsRouter from "../src/routes/tests.js";
import testApprovalsRouter from "../src/routes/testApprovals.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/v1/projects", requireAuth, workspaceScope, projectsRouter);
  app.use("/api/v1", requireAuth, workspaceScope, testsRouter);
  app.use("/api/v1", requireAuth, workspaceScope, testApprovalsRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { token } = await t.registerAndLogin(base, {
      name: "QA", email: `qa-${Date.now()}@example.com`, password: "Password123!",
    });

    // Create a project and seed an auto-approved test directly via the repo
    // (mirrors what `persistGeneratedTests` writes when threshold is met).
    const created = await t.req(base, "/api/v1/projects", {
      method: "POST", token, body: { name: "P", url: "https://example.com" },
    });
    assert.equal(created.res.status, 201);
    const projectId = created.json.id;

    const testId = "TST-AUTO-1";
    testRepo.create({
      id: testId,
      projectId,
      name: "auto-approved test",
      steps: [],
      reviewStatus: "approved",
      reviewedAt: new Date().toISOString(),
      confidenceScore: 0.92,
      approvalSource: "auto",
      approvalThreshold: 0.8,
      approvedAt: Date.now(),
      approvedBy: "auto-approver",
      createdAt: new Date().toISOString(),
    });

    // ── approval-stats: counts the auto-approved test ─────────────────────
    let out = await t.req(base, `/api/v1/projects/${projectId}/approval-stats`, { token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.auto, 1);
    assert.equal(out.json.human, 0);
    assert.equal(typeof out.json.revertRate7d, "number");

    // ── revoke: clears all five provenance columns + reviewedAt ───────────
    out = await t.req(base, `/api/v1/tests/${testId}/revoke`, { method: "POST", token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.reviewStatus, "draft");
    assert.equal(out.json.approvalSource, null);
    assert.equal(out.json.approvalThreshold, null);
    assert.equal(out.json.approvedAt, null);
    assert.equal(out.json.approvedBy, null);
    assert.equal(out.json.reviewedAt, null);

    // ── revoke writes meta.wasAutoApproved (AUTO-003b audit trail) ────────
    // The approval-stats handler filters reverts by `meta.wasAutoApproved
    // === true`, so this row needs to round-trip the JSON column correctly.
    const revokeRows = activityRepo.getFiltered({ type: "test.revoke", projectId });
    const revokeRow = revokeRows.find((a) => a.testId === testId);
    assert.ok(revokeRow, "revoke activity row was logged");
    assert.equal(revokeRow.meta?.wasAutoApproved, true);

    // ── stats: revert rate now reflects the meta-filtered revoke ──────────
    // The seeded test was created via testRepo.create() (no auto_approved
    // activity row), so autoApprovals7d is 0 and revertRate7d stays at 0
    // — but the handler should still survive a meta-bearing revoke row.
    out = await t.req(base, `/api/v1/projects/${projectId}/approval-stats`, { token });
    assert.equal(out.res.status, 200);
    assert.ok(out.json.revertRate7d >= 0 && out.json.revertRate7d <= 1, "revertRate7d is clamped to [0, 1]");

    // ── revoke is idempotent-guarded: drafts can't be revoked ─────────────
    out = await t.req(base, `/api/v1/tests/${testId}/revoke`, { method: "POST", token });
    assert.equal(out.res.status, 400);

    // ── 404: revoke unknown test ──────────────────────────────────────────
    out = await t.req(base, `/api/v1/tests/NOPE/revoke`, { method: "POST", token });
    assert.equal(out.res.status, 404);

    // ── 404: cross-workspace ACL (second user can't see this project) ─────
    const { token: otherToken } = await t.registerAndLogin(base, {
      name: "U2", email: `u2-${Date.now()}@example.com`, password: "Password123!",
    });
    out = await t.req(base, `/api/v1/projects/${projectId}/approval-stats`, { token: otherToken });
    assert.equal(out.res.status, 404);

    // ── concurrency: two simultaneous revokes of the same test ────────────
    // The revoke route reads `test.reviewStatus`, then issues an UPDATE.
    // SQLite serialises writes per-connection (better-sqlite3 is fully
    // synchronous), but at the HTTP layer two requests can still race past
    // the read-side guard before either UPDATE lands. The 400 guard
    // ("only approved tests can be revoked") protects against that — the
    // second request reads `reviewStatus = 'draft'` and bails. This test
    // pins the contract: exactly one revoke succeeds with 200, exactly
    // one rejects with 400, no in-between states (e.g. two 200s, or a
    // double-revoked row with conflicting provenance).
    //
    // Seed a fresh approved test for the race so we don't depend on the
    // earlier test's final state.
    const raceTestId = "TST-AUTO-RACE";
    testRepo.create({
      id: raceTestId,
      projectId,
      name: "race-target",
      steps: [],
      reviewStatus: "approved",
      reviewedAt: new Date().toISOString(),
      confidenceScore: 0.95,
      approvalSource: "auto",
      approvalThreshold: 0.8,
      approvedAt: Date.now(),
      approvedBy: "auto-approver",
      createdAt: new Date().toISOString(),
    });

    const [a, b] = await Promise.all([
      t.req(base, `/api/v1/tests/${raceTestId}/revoke`, { method: "POST", token }),
      t.req(base, `/api/v1/tests/${raceTestId}/revoke`, { method: "POST", token }),
    ]);
    const statuses = [a.res.status, b.res.status].sort();
    assert.deepEqual(statuses, [200, 400],
      `concurrent revokes: expected one 200 + one 400, got ${statuses.join(", ")}`);

    // Final state must be a fully cleared draft — no half-revoked row where
    // some provenance columns kept stale values from a partial UPDATE.
    const after = testRepo.getById(raceTestId);
    assert.equal(after.reviewStatus, "draft");
    assert.equal(after.approvalSource, null);
    assert.equal(after.approvalThreshold, null);
    assert.equal(after.approvedAt, null);
    assert.equal(after.approvedBy, null);

    // The audit log must record exactly one revoke event for the race
    // target. A second `test.revoke` row would mean both requests passed
    // the read-side guard and both wrote their UPDATEs — the bug we're
    // guarding against.
    const raceRevokes = activityRepo
      .getFiltered({ type: "test.revoke", projectId })
      .filter((r) => r.testId === raceTestId);
    assert.equal(raceRevokes.length, 1,
      `expected exactly 1 revoke activity row for race target, got ${raceRevokes.length}`);

    console.log("✅ auto-approval-routes: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ auto-approval-routes failed:", err);
  process.exit(1);
});

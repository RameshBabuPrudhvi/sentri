import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";
import { persistGeneratedTests } from "../src/pipeline/testPersistence.js";

// AGENTS.md §"Use `createTestContext().createTestRunner()`" — migrated from
// pattern 4 (raw `main()` + `console.log("✅")`, no per-case reporting) to
// pattern 2 because this PR (B6) touches the file. Mirrors the canonical
// `agent-loop-collapse.test.js` shape: `ctx`/`runner`, an `async main()`
// wrapper with `await runner.test(...)` per case, `runner.summary(...)`,
// and a `main().catch()` tail that surfaces unhandled rejections so CI
// never sees the silent `exit 1 with zero output` failure mode.
const ctx = createTestContext();
const runner = ctx.createTestRunner();

let projectCounter = 0;

function makeRun() {
  return { tests: [] };
}

// Inserts a real project row so the FK on `tests.projectId` is satisfied
// when `persistGeneratedTests` calls `testRepo.create()`. Each call gets a
// unique id to avoid PK collisions across the test blocks below.
function makeProject(overrides = {}) {
  const project = {
    id: `PRJ-${++projectCounter}`,
    name: "Proj",
    url: "https://example.com",
    // Omit workspaceId — `projects.workspaceId` has a FK to `workspaces`,
    // and this unit test exercises pipeline logic (not ACL). Leave null so
    // the FK isn't checked.
    workspaceId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  projectRepo.create(project);
  return project;
}

// `confidenceScore` is on the 0–1 scale in production: the deduplicator
// normalises `scoreTestWithFactors().score` (0–100) via `quality / 100` at
// `backend/src/pipeline/deduplicator.js:334`, and the route validates
// `autoApproveThreshold` to `(0, 1]` at `backend/src/routes/projects.js:162`.
// Use the production scale here so the test would catch a regression that
// removes the `/ 100` normalisation — a 0–100 score against a 0–1 threshold
// would auto-approve every test, and these assertions exist to lock that
// invariant. `_quality` is kept on its native 0–100 scale (matches what
// `scoreTest()` actually produces) so the fallback path in
// `testPersistence.js:78` is also exercised correctly.
function makeTest(confidenceScore) {
  return { name: "Generated", steps: ["step"], confidenceScore, _quality: confidenceScore * 100 };
}

// Seed the system workspace + clear tables once before the cases run.
// Each pattern-2 case below creates its own project rows via `makeProject`
// (unique ids via `projectCounter`), so the blocks stay mutually
// independent — exactly as they were under the pattern-4 `main()`.
async function main() {
  ctx.resetDb();

  await runner.test("threshold null → test lands in draft with no provenance", async () => {
  const run = makeRun();
  const project = makeProject({ autoApproveThreshold: null });
  // AUDIT-ROADMAP B6 — `persistGeneratedTests` is async (opt-in dry-run
  // gate per QAL-001 launches `browserPool` leases per test). Even when
  // the gate is disabled (the default + this unit-test path), the function
  // is async so callers must `await`. The legacy sync invocation now
  // returns the unresolved Promise and `ids[0]` is `undefined`.
  const ids = await persistGeneratedTests([makeTest(0.95)], project, run);
  const saved = testRepo.getById(ids[0]);
  assert.equal(saved.reviewStatus, "draft");
  assert.equal(saved.approvalSource, null);
});

  await runner.test("confidence below threshold → draft", async () => {
  const run = makeRun();
  const project = makeProject({ autoApproveThreshold: 0.8 });
  const ids = await persistGeneratedTests([makeTest(0.4)], project, run);
  const saved = testRepo.getById(ids[0]);
  assert.equal(saved.reviewStatus, "draft");
});

  await runner.test("confidence above threshold → auto-approved with provenance", async () => {
  const run = makeRun();
  const project = makeProject({ autoApproveThreshold: 0.8 });
  const ids = await persistGeneratedTests([makeTest(0.9)], project, run);
  const saved = testRepo.getById(ids[0]);
  assert.equal(saved.reviewStatus, "approved");
  assert.equal(saved.approvalSource, "auto");
  assert.equal(saved.approvalThreshold, 0.8);
  assert.equal(saved.approvedBy, "auto-approver");
  const activities = activityRepo.getFiltered({ type: "test.auto_approve", projectId: project.id });
  assert.ok(activities.some((a) => a.testId === ids[0] && a.userName === "auto-approver"));
});

  await runner.test("revoke clears all four provenance columns on an auto-approved test", async () => {
  // Revoke (AUTO-003b): an auto-approved test returns to draft with all
  // four provenance columns cleared. We mirror the route handler in
  // backend/src/routes/tests.js (POST /tests/:testId/revoke) directly via
  // the repo so this stays a unit test — HTTP-level coverage can come from
  // a sibling integration test once the supertest harness is wired in.
  const run = makeRun();
  const project = makeProject({ autoApproveThreshold: 0.8 });
  const ids = await persistGeneratedTests([makeTest(0.95)], project, run);
  const before = testRepo.getById(ids[0]);
  assert.equal(before.reviewStatus, "approved");
  assert.equal(before.approvalSource, "auto");

  testRepo.update(ids[0], {
    reviewStatus: "draft",
    reviewedAt: null,
    approvalSource: null,
    approvalThreshold: null,
    approvedAt: null,
    approvedBy: null,
  });
  activityRepo.create({
    type: "test.revoke",
    projectId: project.id,
    projectName: "Proj",
    testId: ids[0],
    testName: before.name,
    userName: "tester",
    detail: `Approval revoked — "${before.name}" (was auto-approved)`,
    createdAt: new Date().toISOString(),
  });

  const after = testRepo.getById(ids[0]);
  assert.equal(after.reviewStatus, "draft");
  assert.equal(after.approvalSource, null);
  assert.equal(after.approvalThreshold, null);
  assert.equal(after.approvedAt, null);
  assert.equal(after.approvedBy, null);
  assert.equal(after.reviewedAt, null);
  const revokeActivities = activityRepo.getFiltered({ type: "test.revoke", projectId: project.id });
  assert.ok(revokeActivities.some((a) => a.testId === ids[0]));
});

  await runner.test("revoking a human-approved test also clears provenance and returns to draft", async () => {
  const run = makeRun();
  const project = makeProject({ autoApproveThreshold: null });
  const ids = await persistGeneratedTests([makeTest(0.5)], project, run);
  // Simulate a human approval (mirrors PATCH /projects/:id/tests/:testId/approve).
  testRepo.update(ids[0], { reviewStatus: "approved", reviewedAt: new Date().toISOString() });
  testRepo.update(ids[0], {
    reviewStatus: "draft",
    reviewedAt: null,
    approvalSource: null,
    approvalThreshold: null,
    approvedAt: null,
    approvedBy: null,
  });
  const after = testRepo.getById(ids[0]);
  assert.equal(after.reviewStatus, "draft");
  assert.equal(after.approvalSource, null);
});

  await runner.test("rejecting an auto-approved test clears provenance (no audit-trail lie)", async () => {
  // Rejecting an auto-approved test clears provenance so the rejected row
  // doesn't keep stale `approvalSource: "auto"` / `approvedBy: "auto-approver"`
  // on subsequent reads — a rejected test that still looks auto-approved is
  // a confusing audit-trail lie. Mirrors the route handler's call to
  // `testRepo.update(id, { reviewStatus: "rejected", reviewedAt, ...PROVENANCE_CLEAR })`.
  const run = makeRun();
  const project = makeProject({ autoApproveThreshold: 0.8 });
  const ids = await persistGeneratedTests([makeTest(0.95)], project, run);
  const before = testRepo.getById(ids[0]);
  assert.equal(before.reviewStatus, "approved");
  assert.equal(before.approvalSource, "auto");

  // Mirror the reject handler's exact write shape.
  testRepo.update(ids[0], {
    reviewStatus: "rejected",
    reviewedAt: new Date().toISOString(),
    approvalSource: null,
    approvalThreshold: null,
    approvedAt: null,
    approvedBy: null,
  });

  const after = testRepo.getById(ids[0]);
  assert.equal(after.reviewStatus, "rejected");
  assert.equal(after.approvalSource, null);
  assert.equal(after.approvalThreshold, null);
  assert.equal(after.approvedAt, null);
  assert.equal(after.approvedBy, null);
});

  // DISABLE_AUTO_APPROVAL kill-switch (AUTO-003b ops rollback path):
  // setting the env var forces every generated test into Draft regardless
  // of the project's `autoApproveThreshold`. The check is read per-call
  // (not cached at module load) so a test fixture can drive both branches
  // by mutating `process.env` between cases. Restore the original value
  // at the end so subsequent test files in the same `node` process aren't
  // poisoned with a leftover kill-switch state.
  await runner.test("DISABLE_AUTO_APPROVAL kill-switch forces draft on every truthy value", async () => {
    const original = process.env.DISABLE_AUTO_APPROVAL;
    try {
      // Sanity check: with the kill-switch unset, a high-confidence test
      // above the threshold IS auto-approved (this is the AUTO-003 default).
      delete process.env.DISABLE_AUTO_APPROVAL;
      const baselineRun = makeRun();
      const baselineProject = makeProject({ autoApproveThreshold: 0.8 });
      const baselineIds = await persistGeneratedTests([makeTest(0.95)], baselineProject, baselineRun);
      assert.equal(testRepo.getById(baselineIds[0]).reviewStatus, "approved");

      // Kill-switch on: same project, same high-confidence test, lands as draft.
      // Cover all three documented truthy values to prove the parser
      // (`"1"` / `"true"` / `"yes"`, case-insensitive per testPersistence.js)
      // is what gates the behaviour.
      for (const truthy of ["1", "true", "TRUE", "yes"]) {
        process.env.DISABLE_AUTO_APPROVAL = truthy;
        const run = makeRun();
        const project = makeProject({ autoApproveThreshold: 0.8 });
        const ids = await persistGeneratedTests([makeTest(0.95)], project, run);
        const saved = testRepo.getById(ids[0]);
        assert.equal(saved.reviewStatus, "draft", `kill-switch=${truthy} should force draft`);
        assert.equal(saved.approvalSource, null, `kill-switch=${truthy} should clear approvalSource`);
        // No `test.auto_approve` activity row should be written when the
        // kill-switch is on — the audit trail must not record approvals
        // that didn't happen.
        const activities = activityRepo.getFiltered({ type: "test.auto_approve", projectId: project.id });
        assert.equal(
          activities.filter((a) => a.testId === ids[0]).length,
          0,
          `kill-switch=${truthy} should not write a test.auto_approve activity row`,
        );
      }

      // Falsy / unset values let auto-approval proceed normally.
      // `"false"` and `"0"` are explicitly NOT in the truthy list per the
      // parser; verify they don't accidentally trip the gate.
      for (const falsy of ["", "false", "0", "no"]) {
        process.env.DISABLE_AUTO_APPROVAL = falsy;
        const run = makeRun();
        const project = makeProject({ autoApproveThreshold: 0.8 });
        const ids = await persistGeneratedTests([makeTest(0.95)], project, run);
        assert.equal(
          testRepo.getById(ids[0]).reviewStatus,
          "approved",
          `kill-switch=${JSON.stringify(falsy)} should NOT block auto-approval`,
        );
      }
    } finally {
      // Restore the original env var so this test doesn't leak state into
      // the next test file in `run-tests.js`.
      if (original === undefined) delete process.env.DISABLE_AUTO_APPROVAL;
      else process.env.DISABLE_AUTO_APPROVAL = original;
    }
  });

  runner.summary("auto-approval");
}

// AGENTS.md §"Use `createTestContext().createTestRunner()`" — surface any
// unhandled rejection from `main()` so CI never sees `exit 1 with zero
// output` (the silent-CI-hang failure mode pattern 2 prevents). Mirrors
// the canonical `agent-loop-collapse.test.js:156-160` tail.
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ auto-approval failed:", err);
  process.exit(1);
});

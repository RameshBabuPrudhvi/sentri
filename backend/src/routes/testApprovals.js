/**
 * @module routes/testApprovals
 * @description Review state-machine for tests — approve / reject / restore /
 * revoke / bulk + the approval-stats aggregate. Mounted at `/api/v1`
 * (INF-005). Extracted from `routes/tests.js` (MNT decomposition).
 *
 * Self-contained: nothing in this module mutates anything other than the
 * `tests` table's review columns (`reviewStatus`, `reviewedAt`,
 * `reviewComment`, plus the four AUTO-003b provenance columns) and the
 * activity log. All approval-policy logic — provenance shapes, atomic
 * revoke predicate, computeStats aggregate — lives in
 * `services/approvalService.js`; the handlers here are the HTTP shim.
 *
 * ### Route-order constraint
 * `POST /projects/:id/tests/bulk` MUST be declared before any
 * `:testId`-wildcard POST that could capture the literal `"bulk"`. Within
 * THIS router there is no such wildcard, so internal order is free. The
 * constraint also holds across routers via the mount order in
 * `backend/src/index.js`: `routes/tests.js` owns `POST /projects/:id/tests`
 * (no second path segment), so the two never collide.
 *
 * ### Endpoints
 * | Method  | Path                                              | Description                              |
 * |---------|---------------------------------------------------|------------------------------------------|
 * | `PATCH` | `/api/v1/projects/:id/tests/:testId/approve`      | Approve (Draft → Approved)               |
 * | `PATCH` | `/api/v1/projects/:id/tests/:testId/reject`       | Reject                                   |
 * | `PATCH` | `/api/v1/projects/:id/tests/:testId/restore`      | Restore to Draft                         |
 * | `POST`  | `/api/v1/tests/:testId/revoke`                    | Revoke approval (atomic, AUTO-003b)      |
 * | `GET`   | `/api/v1/projects/:id/approval-stats`             | Decision counts + 7-day revert rate      |
 * | `POST`  | `/api/v1/projects/:id/tests/bulk`                 | Bulk approve / reject / restore / delete |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import { PROVENANCE_CLEAR, humanApproval, computeStats, APPROVAL_SOURCE } from "../services/approvalService.js";
import { ACTIVITY_TYPES } from "../constants/activityTypes.js";
import { logActivity } from "../utils/activityLogger.js";
import { validateBulkAction } from "../utils/validate.js";
import { trackTelemetry } from "../utils/telemetry.js";
import { actor } from "../utils/actor.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

// ─── Single-test review actions ──────────────────────────────────────────────

router.patch("/projects/:id/tests/:testId/approve", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const test = testRepo.getById(req.params.testId);
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  const reviewedAt = new Date().toISOString();
  // ENT-004: optional approval comment (e.g. "Verified login flow manually").
  // Same shape as the reject path — persisted to `tests.reviewComment`.
  const reviewComment = typeof req.body?.reviewComment === "string"
    ? req.body.reviewComment.trim().slice(0, 2000) || null
    : null;
  // AUTO-003b: populate provenance columns on human approvals too so the
  // approval-stats counter and audit trail carry full decision-time data.
  // `humanApproval()` returns the four provenance fields keyed to this
  // actor — see backend/src/services/approvalService.js for the contract.
  const actorInfo = actor(req);
  testRepo.update(test.id, {
    reviewStatus: "approved",
    reviewedAt,
    reviewComment,
    ...humanApproval(actorInfo),
  });
  logActivity({ ...actorInfo,
    type: ACTIVITY_TYPES.TEST_APPROVE, projectId: req.params.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Test approved — "${test.name}"`,
  });
  // DIF-013: approval/rejection rate telemetry. `generatedFrom` tells us
  // whether AI-generated, recorded, or manual tests are more likely to be
  // approved — useful for measuring pipeline quality over time.
  trackTelemetry("test.review", {
    projectId: req.params.id,
    decision: "approved",
    generatedFrom: test.generatedFrom || null,
    isBulk: false,
  });
  res.json(testRepo.getById(test.id));
});

router.patch("/projects/:id/tests/:testId/reject", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const test = testRepo.getById(req.params.testId);
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  const reviewedAt = new Date().toISOString();
  // ENT-004: optional rejection reason from the Review Queue modal.
  // Persisted to `tests.reviewComment` (migration 054) so TestDetail
  // renders "why was this rejected?" inline without digging through the
  // audit log. Blank/absent = no comment (column stays NULL or previous
  // value is cleared on status change).
  const reviewComment = typeof req.body?.reviewComment === "string"
    ? req.body.reviewComment.trim().slice(0, 2000) || null
    : null;
  // AUTO-003b: clear the four provenance columns alongside `reviewStatus`
  // so a rejected auto-approved test doesn't keep stale `approvalSource:
  // "auto"` / `approvedBy: "auto-approver"` — the response from GET
  // `/tests/:id` would otherwise show a rejected test that still looks
  // auto-approved, which is a confusing audit-trail lie. Matches the
  // restore / revoke / bulk-restore paths that also clear provenance.
  testRepo.update(test.id, { reviewStatus: "rejected", reviewedAt, reviewComment, ...PROVENANCE_CLEAR });
  logActivity({ ...actor(req),
    type: ACTIVITY_TYPES.TEST_REJECT, projectId: req.params.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Test rejected — "${test.name}"`,
  });
  // DIF-013: see approve handler above for rationale.
  trackTelemetry("test.review", {
    projectId: req.params.id,
    decision: "rejected",
    generatedFrom: test.generatedFrom || null,
    isBulk: false,
  });
  res.json(testRepo.getById(test.id));
});

router.patch("/projects/:id/tests/:testId/restore", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const test = testRepo.getById(req.params.testId);
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  // AUTO-003b: clear the four provenance columns alongside reviewStatus/reviewedAt
  // via the shared `PROVENANCE_CLEAR` shape so this stays in lock-step with
  // bulk restore + revoke (see backend/src/services/approvalService.js).
  testRepo.update(test.id, {
    reviewStatus: "draft",
    reviewedAt: null,
    ...PROVENANCE_CLEAR,
  });
  logActivity({ ...actor(req),
    type: ACTIVITY_TYPES.TEST_RESTORE, projectId: req.params.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Test restored to draft — "${test.name}"`,
  });
  res.json(testRepo.getById(test.id));
});

// POST /api/v1/tests/:testId/revoke (AUTO-003b)
//
// Revoke an approved test (auto- or human-approved) back to draft. Clears
// the provenance columns so a future approval writes a fresh decision-time
// snapshot, and emits an activity row so the audit trail records who pulled
// the test back. Workspace-scoped via the test's parent project (ACL-001).
router.post("/tests/:testId/revoke", requireRole("qa_lead"), (req, res) => {
  const test = testRepo.getById(req.params.testId);
  if (!test) return res.status(404).json({ error: "not found" });
  const project = projectRepo.getByIdInWorkspace(test.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  // Capture the previous source from the snapshot read above for the audit
  // row's `meta.wasAutoApproved` flag. By the time the UPDATE runs the row
  // has been cleared, so we can't read provenance off the post-state.
  const previousSource = test.approvalSource;
  // AUTO-003b: atomic check-and-update — `revokeApprovalIfApproved` bakes
  // the `reviewStatus = 'approved'` predicate into the UPDATE's WHERE clause
  // so two concurrent revokes can't both succeed. Returns `false` when the
  // row was already in a different state (e.g. another reviewer revoked
  // first); we map that to the same 400 the previous read-then-check path
  // produced. This stays correct on PostgreSQL pools where read snapshots
  // could otherwise let both requests pass the read-side guard.
  if (!testRepo.revokeApprovalIfApproved(test.id)) {
    return res.status(400).json({ error: "only approved tests can be revoked" });
  }
  logActivity({ ...actor(req),
    type: ACTIVITY_TYPES.TEST_REVOKE, projectId: project.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Approval revoked — "${test.name}" (was ${previousSource === APPROVAL_SOURCE.AUTO ? "auto-approved" : "human-approved"})`,
    // `wasAutoApproved` lets the project approval-stats handler compute the
    // 7-day revert rate without correlating testIds across activity types
    // — see GET /api/v1/projects/:id/approval-stats below.
    meta: { wasAutoApproved: previousSource === APPROVAL_SOURCE.AUTO },
  });
  res.json(testRepo.getById(test.id));
});

// GET /api/v1/projects/:id/approval-stats (AUTO-003b)
//
// Returns approval-decision counts (human / auto / draft) plus a 7-day
// revert rate, used by the project-settings calibration line under the
// `autoApproveThreshold` input.
router.get("/projects/:id/approval-stats", requireRole("qa_lead"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });
  // Aggregation lives in `services/approvalService.js` — keeping the route
  // handler thin lets the service be reused (e.g. a future workspace-wide
  // rollup) and keeps the test surface focused on auth/HTTP shape vs. logic.
  res.json(computeStats(project.id));
});

// NOTE: bulk must be declared BEFORE :testId wildcard routes to avoid conflict
router.post("/projects/:id/tests/bulk", requireRole("qa_lead"), (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  const validationErr = validateBulkAction(req.body);
  if (validationErr) return res.status(400).json({ error: validationErr });

  const { testIds, action } = req.body;

  if (action === "delete") {
    const deleted = [];
    testIds.forEach((tid) => {
      const test = testRepo.getById(tid);
      if (test && test.projectId === req.params.id) {
        deleted.push({ id: test.id, name: test.name });
        testRepo.deleteById(tid);
      }
    });
    if (deleted.length) {
      logActivity({ ...actor(req),
        type: "test.bulk_delete", projectId: req.params.id, projectName: project.name,
        detail: `Bulk delete — ${deleted.length} test${deleted.length !== 1 ? "s" : ""} moved to recycle bin`,
      });
    }
    return res.json({ deleted: deleted.length, tests: deleted });
  }

  const statusMap = { approve: "approved", reject: "rejected", restore: "draft" };
  const reviewedAt = action === "restore" ? null : new Date().toISOString();
  // AUTO-003b: bulk approve must populate provenance, and bulk restore must
  // clear it. Reuse the same `humanApproval()` / `PROVENANCE_CLEAR` shapes
  // the single-test handlers use (services/approvalService.js) so all four
  // approve/restore paths stay byte-identical.
  //
  // Provenance is passed through `bulkUpdateReviewStatus` so it lands in the
  // SAME UPDATE statement as `reviewStatus`/`reviewedAt`, inside the same
  // transaction. A two-phase pattern (status update, then per-row provenance
  // writes) could leave tests approved with null provenance if the request
  // was aborted between phases, miscounting them as human-approved on the
  // approval-stats endpoint. The returned rows are re-read after the UPDATE
  // so the response reflects the persisted provenance.
  // Reject + restore both clear provenance. Reject clears it so a rejected
  // auto-approved test doesn't carry stale `approvalSource: "auto"` on the
  // response (matches the single-test reject handler above); restore clears
  // it because the test is going back to draft for re-review. Only approve
  // writes new provenance.
  const extraFields = action === "approve"
    ? humanApproval(actor(req))
    : (action === "restore" || action === "reject")
      ? PROVENANCE_CLEAR
      : {};
  const updated = testRepo.bulkUpdateReviewStatus(testIds, req.params.id, statusMap[action], reviewedAt, extraFields);

  // Map the action verb onto the canonical ACTIVITY_TYPES values so the
  // bulk path emits the same `type` literals as the single-test handlers
  // above. Previously this used `\`test.${action}\`` interpolation which
  // happened to match today but reopened the `"test.approve"` vs
  // `"test.approved"` drift class the constants were introduced to prevent.
  const PER_TEST_TYPES = {
    approve: ACTIVITY_TYPES.TEST_APPROVE,
    reject:  ACTIVITY_TYPES.TEST_REJECT,
    restore: ACTIVITY_TYPES.TEST_RESTORE,
  };
  const BULK_TYPES = {
    approve: ACTIVITY_TYPES.TEST_BULK_APPROVE,
    reject:  ACTIVITY_TYPES.TEST_BULK_REJECT,
    restore: ACTIVITY_TYPES.TEST_BULK_RESTORE,
  };

  if (updated.length) {
    for (const test of updated) {
      logActivity({ ...actor(req),
        type: PER_TEST_TYPES[action], projectId: req.params.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Test ${action === "approve" ? "approved" : action === "reject" ? "rejected" : "restored to draft"} (bulk) — "${test.name}"`,
      });
    }
    logActivity({ ...actor(req),
      type: BULK_TYPES[action], projectId: req.params.id, projectName: project.name,
      detail: `Bulk ${action} — ${updated.length} test${updated.length !== 1 ? "s" : ""}`,
    });
    // DIF-013: emit ONE bulk event (not N per-test) to keep PostHog volume
    // reasonable. The aggregated count is what we need for approval-rate
    // analytics; per-test granularity would dominate the event stream.
    if (action === "approve" || action === "reject") {
      trackTelemetry("test.review", {
        projectId: req.params.id,
        decision: action === "approve" ? "approved" : "rejected",
        count: updated.length,
        isBulk: true,
      });
    }
  }
  res.json({ updated: updated.length, tests: updated });
});

export default router;

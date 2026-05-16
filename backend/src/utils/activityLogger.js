/**
 * @module utils/activityLogger
 * @description Shared activity logging helper. Records user/system actions
 * so the Activity page shows a complete timeline.
 *
 * ### Type convention (dot-separated: `<resource>.<action>`, imperative form)
 * `project.create` · `crawl.start` · `crawl.complete` · `crawl.fail` ·
 * `test_run.start` · `test_run.complete` · `test_run.fail` ·
 * `test.create` · `test.generate` · `test.edit` · `test.delete` ·
 * `test.approve` · `test.reject` · `test.restore` ·
 * `test.auto_approve` · `test.revoke` · (AUTO-003b)
 * `test.bulk_approve` · `test.bulk_reject` · `test.bulk_restore` ·
 * `settings.update`
 *
 * Test-review event literals are exported as `ACTIVITY_TYPES` from
 * `backend/src/constants/activityTypes.js` — prefer the constant over the
 * literal string at every callsite (the `"test.approve"` vs `"test.approved"`
 * mismatch with the frontend was the bug that motivated extracting them).
 */

import { generateActivityId } from "./idGenerator.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import { formatLogLine } from "./logFormatter.js";

/**
 * Log an activity entry to the database.
 *
 * @param {Object}      opts
 * @param {string}      opts.type        - Activity type (e.g. `"test.approve"`).
 * @param {string}      [opts.projectId] - Associated project ID.
 * @param {string}      [opts.projectName] - Project name for display.
 * @param {string}      [opts.testId]    - Associated test ID.
 * @param {string}      [opts.testName]  - Test name for display.
 * @param {string}      [opts.detail]    - Human-readable description.
 * @param {string}      [opts.status="completed"] - Activity status.
 * @param {string}      [opts.userId]    - ID of the user who triggered the action (from req.authUser.sub).
 * @param {string}      [opts.userName]  - Display name of the user (from req.authUser.name or email).
 * @param {string}      [opts.workspaceId] - Workspace ID for multi-tenancy scoping (ACL-001).
 * @param {Object}      [opts.meta]      - Structured metadata persisted as JSON (migration 018). E.g. `{ score, threshold }` on auto-approval, `{ wasAutoApproved }` on revoke.
 * @returns {Object}    The created activity record.
 */
export function logActivity({ type, req, projectId, projectName, testId, testName, detail, status, userId, userName, workspaceId, meta }) {
  // Warn when a project-scoped activity is logged without a workspaceId.
  // Activities with workspaceId=NULL become orphaned — invisible to
  // workspace-scoped queries (/api/activities, /api/data/activities).
  if (projectId && !workspaceId) {
    console.warn(formatLogLine("warn", null,
      `[activity] Activity "${type}" for project ${projectId} logged without workspaceId — row will be orphaned`));
  }

  const id = generateActivityId();
  const activity = {
    id,
    type,
    projectId: projectId || null,
    projectName: projectName || null,
    testId: testId || null,
    testName: testName || null,
    detail: detail || null,
    status: status || "completed",
    createdAt: new Date().toISOString(),
    userId: userId || null,
    userName: userName || null,
    workspaceId: workspaceId || null,
    meta: meta || null,
    ipAddress: req?.ip || null,
    userAgent: req?.get?.("user-agent") || null,
    prevHash: null,
  };
  activityRepo.create(activity);

  // SEC-007 Part C: fire-and-forget SIEM forwarding. Every persisted
  // audit row is pushed to the workspace's configured SIEM target on
  // a deferred microtask so the originating request is never blocked
  // by a SIEM outage. The forwarder itself NEVER throws — failures
  // land in the `audit_dlq` table for admin replay.
  //
  // Lazy-imported to break the import cycle: notifications.js imports
  // auditDlqRepo, which imports counterRepo, which… etc. Using a
  // dynamic import here keeps activityLogger's top-level dependency
  // graph minimal (the original notification dispatcher uses the same
  // dynamic-import pattern in routes/system.js for the replay path).
  // SEC-007 SIEM dispatch contract:
  //   - First write of an event → forwarded once with `count: 1`, `deduped: false`.
  //   - Dedup hit (auth.login.failed burst, audit.read poll) → forwarded
  //     again with the SAME `id`, incremented `count`, and `deduped: true`.
  //     SIEM-side integrity verifiers that expect unique row ids must
  //     dedupe on `(id, count)` or treat repeated ids as UPDATE events.
  //     The alternative (suppress dispatch on dedup hits) would hide
  //     credential-stuffing bursts — the live `count++` stream is the
  //     attack signal a SOC analyst wants.
  if (activity.workspaceId) {
    setImmediate(() => {
      import("./notifications.js")
        .then((mod) => mod.dispatchSiemEvent?.(activity.workspaceId, activity))
        .catch((err) => {
          // SEC-007: best-effort SIEM forwarding — the row is already
          // persisted, so a dispatch failure does not block the originating
          // request. BUT a dynamic-import failure (module not found, syntax
          // error in notifications.js, etc.) never reaches the DLQ —
          // dispatchSiemEvent was never invoked. Surface to stderr so
          // operators see persistent forwarding outages even when the DLQ
          // counter stays at zero. Per-row failures (HTTP errors) are
          // handled inside dispatchSiemEvent and land in audit_dlq.
          console.error(formatLogLine("error", null,
            `[activity/siem] SIEM dispatch failed for activity ${activity.id}: ${err?.message || err}`));
        });
    });
  }

  return activity;
}

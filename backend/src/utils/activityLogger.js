/**
 * @module utils/activityLogger
 * @description Shared activity logging helper. Records user/system actions
 * so the Activity page shows a complete timeline.
 *
 * ### Type convention (dot-separated: `<resource>.<action>`)
 * `project.create` · `crawl.start` · `crawl.complete` · `crawl.fail` ·
 * `test_run.start` · `test_run.complete` · `test_run.fail` ·
 * `test.create` · `test.generate` · `test.edit` · `test.delete` ·
 * `test.approve` · `test.reject` · `test.restore` ·
 * `test.bulk_approve` · `test.bulk_reject` · `test.bulk_restore` ·
 * `settings.update`
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
 * @returns {Object}    The created activity record.
 */
export function logActivity({ type, projectId, projectName, testId, testName, detail, status, userId, userName, workspaceId }) {
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
  };
  activityRepo.create(activity);
  return activity;
}

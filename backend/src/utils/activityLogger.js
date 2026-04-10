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
 * @returns {Object}    The created activity record.
 */
export function logActivity({ type, projectId, projectName, testId, testName, detail, status }) {
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
  };
  activityRepo.create(activity);
  return activity;
}

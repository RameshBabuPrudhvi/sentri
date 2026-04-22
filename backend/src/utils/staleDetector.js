/**
 * @module utils/staleDetector
 * @description Detect and flag stale tests (AUTO-013).
 *
 * A test is considered stale when it is approved but has not been run in
 * a configurable number of days (default 90, env `STALE_TEST_DAYS`).
 *
 * Called by the weekly background job in `scheduler.js` and can also be
 * invoked manually via `POST /api/v1/system/detect-stale`.
 *
 * @example
 * import { detectStaleTests } from "../utils/staleDetector.js";
 * const result = detectStaleTests();
 * // { flagged: 12, cleared: 3 }
 */

import * as testRepo from "../database/repositories/testRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import { formatLogLine } from "./logFormatter.js";

/** @type {number} Days since last run before a test is considered stale. */
const STALE_DAYS = parseInt(process.env.STALE_TEST_DAYS ?? "", 10) || 90;

/**
 * Scan all projects and flag approved tests that haven't been run recently.
 *
 * 1. Clear existing stale flags (tests that have since been run).
 * 2. Find tests older than `STALE_DAYS` since their last run.
 * 3. Bulk-flag them as stale.
 *
 * @param {string[]} [projectIds] — Scope to specific projects. If omitted, scans all.
 * @returns {{ flagged: number, cleared: number, staleDays: number }}
 */
export function detectStaleTests(projectIds) {
  const ids = projectIds || projectRepo.getAll().map(p => p.id);
  if (ids.length === 0) return { flagged: 0, cleared: 0, staleDays: STALE_DAYS };

  // Step 1: Clear stale flags so re-run tests are unflagged
  testRepo.clearStaleByProjectIds(ids);

  // Step 2: Find tests that are stale by age
  const staleIds = testRepo.findStaleByAge(ids, STALE_DAYS);

  // Step 3: Flag them
  if (staleIds.length > 0) {
    testRepo.bulkSetStale(staleIds, true);
  }

  console.log(formatLogLine("info", null,
    `[stale-detector] Flagged ${staleIds.length} stale test(s) across ${ids.length} project(s) (threshold: ${STALE_DAYS} days)`
  ));

  return { flagged: staleIds.length, cleared: 0, staleDays: STALE_DAYS };
}

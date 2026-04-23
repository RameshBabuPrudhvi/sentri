/**
 * @module utils/staleDetector
 * @description Detect and flag stale tests (AUTO-013).
 *
 * A test is considered stale when it is approved but has not been run in
 * a configurable number of days (default 90, env `STALE_TEST_DAYS`).
 *
 * Called by the weekly background job in `scheduler.js` and can also be
 * invoked programmatically via `detectStaleTests(projectIds)`.
 *
 * When called without arguments from the cron job, scans each workspace
 * independently so logging and counts are per-workspace (multi-tenant safe).
 *
 * @example
 * import { detectStaleTests } from "../utils/staleDetector.js";
 * const result = detectStaleTests();
 * // { flagged: 12, cleared: 3 }
 */

import * as testRepo from "../database/repositories/testRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import { getDatabase } from "../database/sqlite.js";
import { formatLogLine } from "./logFormatter.js";

/** @type {number} Days since last run before a test is considered stale. */
const STALE_DAYS = parseInt(process.env.STALE_TEST_DAYS ?? "", 10) || 90;

/**
 * Scan projects and flag approved tests that haven't been run recently.
 *
 * 1. Clear existing stale flags (tests that have since been run).
 * 2. Find tests older than `STALE_DAYS` since their last run.
 * 3. Bulk-flag them as stale.
 *
 * When `projectIds` is provided, scans only those projects (used by API
 * triggers or tests).  When omitted, discovers all workspaces and scans
 * each independently so multi-tenant deployments get per-workspace logging.
 *
 * @param {string[]} [projectIds] — Scope to specific projects. If omitted, scans all workspaces.
 * @returns {{ flagged: number, cleared: number, staleDays: number }}
 */
export function detectStaleTests(projectIds) {
  // When explicit project IDs are provided, scan them directly.
  if (projectIds && projectIds.length > 0) {
    return _scanProjects(projectIds);
  }

  // No project IDs — discover all workspaces and scan each independently.
  // This keeps logging and counts per-workspace for multi-tenant clarity.
  let totalFlagged = 0;
  let totalCleared = 0;

  let workspaceIds;
  try {
    const db = getDatabase();
    workspaceIds = db.prepare("SELECT id FROM workspaces").all().map(r => r.id);
  } catch {
    // workspaces table may not exist yet (pre-migration-004) — fall back to
    // scanning all projects without workspace scoping.
    workspaceIds = null;
  }

  if (workspaceIds && workspaceIds.length > 0) {
    for (const wsId of workspaceIds) {
      const ids = projectRepo.getAll(wsId).map(p => p.id);
      if (ids.length === 0) continue;
      const result = _scanProjects(ids, wsId);
      totalFlagged += result.flagged;
      totalCleared += result.cleared;
    }
  } else {
    // Single-tenant or pre-workspace — scan all projects
    const ids = projectRepo.getAll().map(p => p.id);
    if (ids.length > 0) {
      const result = _scanProjects(ids);
      totalFlagged += result.flagged;
      totalCleared += result.cleared;
    }
  }

  return { flagged: totalFlagged, cleared: totalCleared, staleDays: STALE_DAYS };
}

/**
 * Internal: scan a set of project IDs for stale tests.
 * @param {string[]} ids
 * @param {string}   [workspaceId] — For logging only.
 * @returns {{ flagged: number, cleared: number, staleDays: number }}
 * @private
 */
function _scanProjects(ids, workspaceId) {
  if (!ids || ids.length === 0) return { flagged: 0, cleared: 0, staleDays: STALE_DAYS };

  // Step 1: Clear stale flags so re-run tests are unflagged
  const cleared = testRepo.clearStaleByProjectIds(ids);

  // Step 2: Find tests that are stale by age
  const staleIds = testRepo.findStaleByAge(ids, STALE_DAYS);

  // Step 3: Flag them
  if (staleIds.length > 0) {
    testRepo.bulkSetStale(staleIds, true);
  }

  const scope = workspaceId ? ` (workspace ${workspaceId})` : "";
  console.log(formatLogLine("info", null,
    `[stale-detector] Flagged ${staleIds.length} stale test(s), cleared ${cleared} across ${ids.length} project(s)${scope} (threshold: ${STALE_DAYS} days)`
  ));

  return { flagged: staleIds.length, cleared, staleDays: STALE_DAYS };
}

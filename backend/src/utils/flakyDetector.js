/**
 * @module utils/flakyDetector
 * @description Compute and persist flaky scores for tests (DIF-004).
 *
 * A test is "flaky" when it sometimes passes and sometimes fails across
 * runs.  The flaky score (0–100) represents the pass/fail balance ratio:
 *   `flakyScore = (min(passes, fails) / total) * 100`
 *
 * A score of 0 means the test always produces the same result (all pass or all fail).
 * A score of 50 means it passes and fails equally often (maximally flaky).
 * Note: the score measures the *proportion* of minority outcomes, not the
 * sequential alternation pattern — PPPPPFFFFF and PFPFPFPFPF both score 50.
 *
 * Called after each test run by `testRunner.js` via `runFeedbackLoop`.
 * The score is persisted to `tests.flakyScore` for dashboard display,
 * filtering, and badge rendering.
 *
 * @example
 * import { computeAndPersistFlakyScores } from "../utils/flakyDetector.js";
 * const result = computeAndPersistFlakyScores("PRJ-1");
 * // { updated: 5, flaky: 2 }
 */

import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import { formatLogLine } from "./logFormatter.js";

/** @type {number} Minimum number of run results before computing a flaky score. */
const MIN_RESULTS = 2;

/**
 * Compute flaky scores for all tests in a project and persist them.
 *
 * Scans the last N completed test runs (default 20) for the project,
 * aggregates pass/fail counts per test, computes the flaky score, and
 * bulk-updates the `flakyScore` column.
 *
 * @param {string} projectId
 * @param {number} [maxRuns=20] — Maximum number of recent runs to consider.
 * @returns {{ updated: number, flaky: number }}
 */
export function computeAndPersistFlakyScores(projectId, maxRuns = 20) {
  // Fetch recent completed test runs with results — lean query that only
  // selects the 5 columns we need (id, type, status, startedAt, results)
  // with SQL-level filtering and LIMIT.  The previous implementation loaded
  // ALL columns for ALL runs via getByProjectId() then filtered in JS,
  // which parsed megabytes of unused JSON blobs on every test run completion.
  const completedRuns = runRepo.getRecentCompletedWithResults(projectId, maxRuns);

  if (completedRuns.length < MIN_RESULTS) {
    return { updated: 0, flaky: 0 };
  }

  // Aggregate pass/fail counts per test
  const testResults = new Map(); // testId → { passes, fails }
  for (const run of completedRuns) {
    for (const result of run.results) {
      if (!result.testId) continue;
      if (!testResults.has(result.testId)) {
        testResults.set(result.testId, { passes: 0, fails: 0 });
      }
      const entry = testResults.get(result.testId);
      if (result.status === "passed" || result.status === "warning") entry.passes++;
      else if (result.status === "failed") entry.fails++;
    }
  }

  // Compute and persist scores
  let updated = 0;
  let flaky = 0;
  for (const [testId, { passes, fails }] of testResults) {
    const total = passes + fails;
    if (total < MIN_RESULTS) continue;

    const score = Math.round((Math.min(passes, fails) / total) * 100);
    testRepo.update(testId, { flakyScore: score });
    updated++;
    if (score > 0) flaky++;
  }

  if (flaky > 0) {
    console.log(formatLogLine("info", null,
      `[flaky-detector] Project ${projectId}: ${flaky} flaky test(s) detected across ${completedRuns.length} run(s)`
    ));
  }

  return { updated, flaky };
}

/**
 * Get the top N flakiest tests for a set of project IDs.
 * Used by the dashboard to display the "Flaky Tests" panel.
 *
 * @param {string[]} projectIds
 * @param {number}   [limit=10]
 * @returns {Array<{testId: string, name: string, flakyScore: number, projectId: string}>}
 */
export function getTopFlakyTests(projectIds, limit = 10) {
  if (!projectIds || projectIds.length === 0) return [];
  const tests = testRepo.getAllByProjectIds(projectIds);
  return tests
    .filter(t => t.flakyScore > 0 && t.reviewStatus === "approved")
    .sort((a, b) => b.flakyScore - a.flakyScore)
    .slice(0, limit)
    .map(t => ({
      testId: t.id,
      name: t.name,
      flakyScore: t.flakyScore,
      projectId: t.projectId,
    }));
}

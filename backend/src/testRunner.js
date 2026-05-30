/**
 * @module testRunner
 * @description Thin orchestrator for Playwright test execution with parallel
 * worker support.
 *
 * Owns the browser lifecycle, per-test loop (sequential or parallel), trace
 * management, and final status transition. Delegates heavy sub-tasks to
 * focused modules:
 *
 * | Module                          | Responsibility                        |
 * |---------------------------------|---------------------------------------|
 * | `runner/config.js`              | Env constants, artifact dir setup     |
 * | `runner/codeParsing.js`         | `extractTestBody` (hasCode check)     |
 * | `runner/executeTest.js`         | Single-test execution                 |
 * | `runner/feedbackIntegration.js` | Post-run AI feedback loop             |
 *
 * ### Parallel execution
 * When `parallelWorkers > 1`, tests run in concurrent browser contexts within
 * a single Chromium instance. Each worker picks the next queued test, executes
 * it in its own isolated `BrowserContext`, and reports back. The shared browser
 * process keeps memory usage lower than launching N separate browsers.
 *
 * Concurrency is controlled by:
 * 1. `PARALLEL_WORKERS` env var (default for all runs)
 * 2. Per-run override via `options.parallelWorkers` (from Test Dials / API)
 *
 * ### Exports
 * - {@link runTests} — Execute an array of approved tests against a project.
 */

import { extractTestBody, isApiTest } from "./runner/codeParsing.js";
import { executeTest, executeTestIterations } from "./runner/executeTest.js";
import { finalizeCoverage, aggregateShardCoverage } from "./pipeline/finalizeCoverage.js";
import { detectCoverageRegression, fireCoverageRegressionAlert } from "./pipeline/coverageRegressionDetector.js"; // AUTO-009i
import { runFeedbackLoop } from "./runner/feedbackIntegration.js";
import { isSmokeTest } from "./pipeline/riskScorer.js";
import { clusterFailures } from "./pipeline/failureClusterer.js";
import { TRACES_DIR, DEFAULT_PARALLEL_WORKERS, MAX_TEST_RETRIES, resolveBrowser, BROWSER_HEADLESS } from "./runner/config.js";
import { browserPool } from "./runner/browserPool.js";
import { executeWithRetries } from "./runner/retry.js";
import { finalizeRunIfNotAborted, isRunAborted } from "./utils/abortHelper.js";
import { trackTelemetry } from "./utils/telemetry.js";
import { emitRunEvent, log, logWarn, logError, logSuccess } from "./utils/runLogger.js";
import { classifyError } from "./utils/errorClassifier.js";
import { structuredLog, formatLogLine } from "./utils/logFormatter.js";
import * as testRepo from "./database/repositories/testRepo.js";
import * as runRepo from "./database/repositories/runRepo.js";
import * as runTestResultRepo from "./database/repositories/runTestResultRepo.js";
import * as testFixtureRepo from "./database/repositories/testFixtureRepo.js";
import { enqueue as enqueueDbWrite } from "./utils/dbWriteQueue.js";
import { signRunArtifacts, signArtifactUrl } from "./middleware/appSetup.js";
import { writeArtifactBuffer } from "./utils/objectStorage.js";
import fs from "fs";
import { recordMetric } from "./utils/recordMetric.js";
import { isNonExecutedSkip } from "./utils/skipReasons.js";
import { testsExecutedTotal, testDurationSeconds, recordRunOutcome } from "./utils/metrics.js"; // INF-007 — per-test + per-run telemetry.


/**
 * Evaluate per-project quality gates against a finalised run.
 *
 * @param {Object} gates - Validated `project.qualityGates` payload (see
 *   `validateQualityGates` in `routes/projects.js`). Coverage thresholds
 *   (`minCoveragePct`, `minBranchPct`, `minPrCoveragePct`,
 *   `maxCoverageRegressionPct`) are AUTO-009d additions; all four are
 *   expressed as percentages (0–100) and compared against `run.coverageSummary`
 *   ratios after a single ×100 conversion.
 * @param {Object} run   - Run record. `run.coverageSummary` must be populated
 *   BEFORE this is called (mutated in-place by `aggregateRunCoverage`).
 * @param {Object} [opts]
 * @param {Object|null} [opts.priorRunCoverage] - Previous run's
 *   `coverageSummary` for regression-gate comparison. Pass `null` (no prior
 *   run) and the regression rule short-circuits to a no-op — first-ever
 *   coverage-enabled run can't regress against something that doesn't exist.
 * @returns {{ passed: boolean, violations: Array }|null}
 */
function evaluateQualityGates(gates, run, { priorRunCoverage = null } = {}) {
  // Defense-in-depth: `validateQualityGates` in `backend/src/routes/projects.js`
  // already rejects payloads that produce an empty object, but a corrupted DB
  // row or direct DB manipulation could still surface `{}` here. Treat any
  // non-object, array, or empty object as "no gates configured" and return
  // null — same shape as the unconfigured case — so callers (trigger response,
  // RunDetail UI, GateBadge) render legacy-style with no enforcement rather
  // than silently reporting `{ passed: true }` from a misconfigured project.
  if (!gates || typeof gates !== "object" || Array.isArray(gates)) return null;
  if (Object.keys(gates).length === 0) return null;
  const violations = [];
  // AUTO-001 / AUTO-004: `run.total` reflects the approved-test set (audit
  // fidelity), but skipped tests never executed — they shouldn't dilute the
  // pass-rate denominator. Exclude both `over_budget` (AUTO-001) and
  // `skipped_no_impact` (AUTO-004) so a `minPassRate: 80%` gate doesn't
  // falsely fail when budget truncation or impact analysis happens to skip
  // tests that would otherwise have passed. Must stay in sync with the
  // frontend denominator at `frontend/src/pages/RunDetail.jsx` —
  // `passRateDenominator = total - skippedOverBudget - skippedNoImpact`.
  const rawTotal = Number(run.total || 0);
  const skippedNonExecuted = Array.isArray(run.results)
    ? run.results.filter(isNonExecutedSkip).length
    : 0;
  const total = Math.max(0, rawTotal - skippedNonExecuted);
  const failed = Number(run.failed || 0);
  const passed = Number(run.passed || 0);
  const passRate = total > 0 ? (passed / total) * 100 : 100;

  // `flakyPct` = % of tests that needed at least one retry, NOT the sum of
  // retries across the suite. Using `run.retryCount` directly (sum of per-test
  // retries — see line ~340 below) would let a single 3×-retried test push
  // flakyPct above 100% on a 1-test run, which is both nonsensical and
  // unreachable given `maxFlakyPct` is range-validated to 0–100 server-side
  // (`backend/src/routes/projects.js`). Counting flaky *tests* instead matches
  // the user-facing meaning and stays bounded in [0, 100]. Falls back to
  // counting per-result retryCount > 0 when run.results is available; uses 0
  // when results aren't populated yet (e.g. aborted runs). Denominator uses
  // the dispatched-count `total` (budget-skipped tests excluded) for the same
  // reason as `passRate` above.
  const flakyTests = Array.isArray(run.results)
    ? run.results.filter((r) => Number(r?.retryCount || 0) > 0).length
    : 0;
  const flakyPct = total > 0 ? (flakyTests / total) * 100 : 0;

  if (Number.isFinite(gates.minPassRate) && passRate < gates.minPassRate) {
    violations.push({ rule: "minPassRate", threshold: gates.minPassRate, actual: Number(passRate.toFixed(2)) });
  }
  if (Number.isFinite(gates.maxFlakyPct) && flakyPct > gates.maxFlakyPct) {
    violations.push({ rule: "maxFlakyPct", threshold: gates.maxFlakyPct, actual: Number(flakyPct.toFixed(2)) });
  }
  if (Number.isFinite(gates.maxFailures) && failed > gates.maxFailures) {
    violations.push({ rule: "maxFailures", threshold: gates.maxFailures, actual: failed });
  }

  // AUTO-009d — coverage gates. Only evaluated when (a) the project has at
  // least one coverage threshold configured AND (b) the run actually
  // produced a `coverageSummary` (`project.coverageEnabled === true` and
  // aggregation didn't no-op). When coverage is enabled on the project but
  // a transient capture failure left `coverageSummary` null, the gates
  // short-circuit rather than failing the run on missing data — same
  // best-effort philosophy as `evaluateWebVitalsBudgets` (`anyMeasured`
  // guard). The single source of truth for the rule names + percent
  // semantics is `validateQualityGates` in `routes/projects.js`.
  const cov = run.coverageSummary;
  const hasCoverageGate =
    Number.isFinite(gates.minCoveragePct) ||
    Number.isFinite(gates.minBranchPct) ||
    Number.isFinite(gates.minPrCoveragePct) ||
    Number.isFinite(gates.maxCoverageRegressionPct);
  if (hasCoverageGate && cov && typeof cov === "object") {
    // Line / overall coverage — `coveragePct` is a 0–1 ratio on the summary.
    if (Number.isFinite(gates.minCoveragePct) && Number.isFinite(cov.coveragePct)) {
      const actualPct = Number((cov.coveragePct * 100).toFixed(2));
      if (actualPct < gates.minCoveragePct) {
        violations.push({ rule: "minCoveragePct", threshold: gates.minCoveragePct, actual: actualPct });
      }
    }
    // Branch coverage — only present when AUTO-009c v8-to-istanbul produced
    // data. Missing key (line-only coverage runs) → rule no-ops, NOT a
    // violation — operator's gate is moot when there's nothing to measure.
    if (Number.isFinite(gates.minBranchPct) && Number.isFinite(cov.branchPct)) {
      const actualPct = Number((cov.branchPct * 100).toFixed(2));
      if (actualPct < gates.minBranchPct) {
        violations.push({ rule: "minBranchPct", threshold: gates.minBranchPct, actual: actualPct });
      }
    }
    // PR coverage — reads `run.prCoverageDiff.prCoveragePct` when the run
    // was triggered from a GitHub PR and `finalizeCoverage` populated the
    // PR-scoped diff (AUTO-009d). **Skipped entirely on non-PR runs**
    // (manual UI, scheduled, crawl-only) — the gate is semantically "PR
    // coverage", so firing it on runs that have no PR context would
    // surprise operators who set `minCoveragePct: 60` (overall) and
    // `minPrCoveragePct: 80` (PR-only) expecting the second gate to be
    // dormant on scheduled runs. Matches the "first run" regression-rule
    // pattern at the `maxCoverageRegressionPct` block below, which also
    // short-circuits when the comparison data is unavailable.
    //
    // When `prCoverageDiff` is present but `prTotalLines === 0` (the PR
    // touched only files outside the test suite's coverage scope),
    // `prCoveragePct` is the structured-zero `0` from `computePrCoverage`.
    // We additionally guard `prTotalLines > 0` so the gate doesn't fire
    // a false-positive "0% vs 80%" on a PR that had zero analyzable lines.
    {
      const prDiff = run.prCoverageDiff;
      const hasPrData = prDiff && typeof prDiff === "object"
        && Number.isFinite(prDiff.prCoveragePct)
        && (prDiff.prTotalLines || 0) > 0;
      if (Number.isFinite(gates.minPrCoveragePct) && hasPrData) {
        const actualPct = Number((prDiff.prCoveragePct * 100).toFixed(2));
        if (actualPct < gates.minPrCoveragePct) {
          violations.push({ rule: "minPrCoveragePct", threshold: gates.minPrCoveragePct, actual: actualPct });
        }
      }
    }
    // Regression — drop relative to the previous coverage-enabled run.
    // Skipped when no prior run exists (first-ever coverage run) so a
    // brand-new project doesn't fail its first coverage gate on missing
    // history.
    if (
      Number.isFinite(gates.maxCoverageRegressionPct) &&
      priorRunCoverage &&
      Number.isFinite(priorRunCoverage.coveragePct) &&
      Number.isFinite(cov.coveragePct)
    ) {
      const dropPct = Number(((priorRunCoverage.coveragePct - cov.coveragePct) * 100).toFixed(2));
      if (dropPct > gates.maxCoverageRegressionPct) {
        violations.push({
          rule: "maxCoverageRegressionPct",
          threshold: gates.maxCoverageRegressionPct,
          actual: dropPct,
          // Surface the comparison context so the violation message in the
          // GitHub Check summary / RunDetail panel can read "coverage
          // dropped 12% (from 80% to 68%)" — without this, the operator
          // sees the delta but not the baseline.
          priorCoveragePct: Number((priorRunCoverage.coveragePct * 100).toFixed(2)),
        });
      }
    }
  }

  return { passed: violations.length === 0, violations };
}


function evaluateWebVitalsBudgets(budgets, run) {
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets) || Object.keys(budgets).length === 0) return null;
  const violations = [];
  // Track whether *any* metric was actually compared against a budget. If zero
  // comparisons happened — e.g. the `web-vitals` IIFE failed to load and every
  // captureWebVitals() returned all-null metrics — return null to match the
  // "unconfigured" semantics. Otherwise CI consumers (trigger.js callback,
  // status endpoint) would see `{ passed: true, violations: [] }` and falsely
  // conclude the budgets passed when nothing was measured at all. Mirrors the
  // defense-in-depth pattern in evaluateQualityGates above.
  let anyMeasured = false;
  const rows = Array.isArray(run.results) ? run.results : [];
  for (const r of rows) {
    const m = r?.webVitals;
    if (!m || typeof m !== "object") continue;
    for (const key of ["lcp", "cls", "inp", "ttfb"]) {
      if (!Number.isFinite(budgets[key]) || !Number.isFinite(m[key])) continue;
      anyMeasured = true;
      if (m[key] > budgets[key]) {
        violations.push({ rule: key, threshold: budgets[key], actual: m[key], testId: r.testId, testName: r.testName || null });
      }
    }
  }
  if (!anyMeasured) return null;
  return { passed: violations.length === 0, violations };
}

// Exported under a name-mangled alias so integration tests can exercise the
// pure evaluator without pulling in the full runner surface. Not part of the
// public module contract — callers outside tests should rely on run.gateResult.
export { evaluateQualityGates as __evaluateQualityGatesForTest, evaluateWebVitalsBudgets as __evaluateWebVitalsBudgetsForTest };

// ── Concurrency helper ────────────────────────────────────────────────────────
// Lightweight promise pool — no external dependencies. Runs `fn` for each item
// in `items` with at most `concurrency` in-flight at once. Results are returned
// in the original item order.

/**
 * CAP-002 — Compute per-shard sizes using Playwright's `--shard=N/M`
 * algorithm: the first `total % shardCount` shards receive one extra item,
 * so shard sizes differ by at most one. Pure function — no I/O, no
 * mutation, no allocations beyond the returned array. The single source
 * of truth for the partition shape; both `partitionTestsIntoShards`
 * (stamps `_shardIndex` on test objects) and `partitionTestIdsForShards`
 * (slices plain-string arrays) derive their output from this.
 *
 * @param {number} total       - Total item count.
 * @param {number} shardCount  - 1..MAX_WORKERS (caller is responsible for clamp).
 * @returns {number[]} `sizes[shardIndex]` — per-shard item count. Empty
 *   trailing shards (possible when `shardCount > total`) yield 0.
 */
export function computeShardSizes(total, shardCount) {
  const count = Math.max(1, Number(shardCount) || 1);
  const safeTotal = Math.max(0, Number(total) || 0);
  const baseSize = Math.floor(safeTotal / count);
  const remainder = safeTotal % count;
  return new Array(count).fill(0).map((_, s) => baseSize + (s < remainder ? 1 : 0));
}

/**
 * CAP-002 — Partition tests into `shardCount` contiguous slices using the
 * shared {@link computeShardSizes} algorithm. Tags each test with
 * `_shardIndex` in place (callers rely on this to attribute results to the
 * correct shard at completion time) and returns the `sizes[]` array so the
 * runner can detect "last test in shard S has finished" without re-deriving
 * the partition. Pure function — no DB or side effects — so the partition
 * contract can be exercised in isolation by `backend/tests/run-sharding.test.js`.
 *
 * @param {Object[]} tests       - Tests in dispatch order (post-smoke-pin).
 * @param {number}   shardCount  - 1..MAX_WORKERS (caller is responsible for clamp).
 * @returns {{ sizes: number[] }} per-shard test counts.
 */
export function partitionTestsIntoShards(tests, shardCount) {
  const sizes = computeShardSizes(tests.length, shardCount);
  let cursor = 0;
  let shard = 0;
  for (let i = 0; i < tests.length; i++) {
    while (shard < sizes.length - 1 && i >= cursor + sizes[shard]) {
      cursor += sizes[shard];
      shard++;
    }
    tests[i]._shardIndex = shard;
  }
  return { sizes };
}

/**
 * CAP-002 Phase 2 — Partition test IDs into `shardCount` contiguous slices
 * using the shared {@link computeShardSizes} algorithm. The route layer
 * calls this at enqueue time to pre-compute each BullMQ shard job's
 * `testIds` payload — the coordinator is the single source of truth for
 * the split; workers never re-derive the partition (avoids drift if a
 * future test sort changes the approved-test order between enqueue and
 * worker pickup).
 *
 * Implementation note: slices the input array directly rather than allocating
 * a tagged-copy. `computeShardSizes` is the single source of truth shared
 * with `partitionTestsIntoShards`, so the algorithm cannot drift between
 * the two callers.
 *
 * @param {string[]} testIds    - Approved test IDs in dispatch order.
 * @param {number}   shardCount - 1..MAX_WORKERS (caller is responsible for clamp).
 * @returns {string[][]} `slices[shardIndex]` is the array of test IDs for
 *   that shard. Empty shards (possible when `shardCount > testIds.length`)
 *   yield `[]` at their slot.
 */
export function partitionTestIdsForShards(testIds, shardCount) {
  const ids = Array.isArray(testIds) ? testIds : [];
  const sizes = computeShardSizes(ids.length, shardCount);
  const slices = [];
  let cursor = 0;
  for (const size of sizes) {
    slices.push(ids.slice(cursor, cursor + size));
    cursor += size;
  }
  return slices;
}

/**
 * CAP-002 Phase 2 (Prerequisite #2) — Compute the public artifact URL for a
 * shard's trace zip. The path mirrors the on-disk layout in `TRACES_DIR` so
 * `signArtifactUrl` and the trace-viewer static-file mount can resolve nested
 * paths without special-casing. `shardIndex == null` (legacy / single-shard
 * runs) returns the flat `${runId}.zip` URL — zero regression for every
 * existing consumer of `run.tracePath`. Pure: no I/O, no DB, exported so
 * `backend/tests/run-sharding.test.js` can assert the contract directly.
 *
 * @param {string}       runId
 * @param {number|null}  shardIndex - 0-based shard index, or null for legacy single-path runs.
 * @returns {string} `/artifacts/traces/<runId>.zip` or `/artifacts/traces/<runId>/shard-<idx>.zip`
 */
export function shardTraceArtifactPath(runId, shardIndex) {
  if (shardIndex == null) return `/artifacts/traces/${runId}.zip`;
  return `/artifacts/traces/${runId}/shard-${shardIndex}.zip`;
}

async function poolMap(items, concurrency, fn, signal) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      if (signal?.aborted) break;
      const idx = nextIndex++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}


/**
 * Execute an array of approved tests against a project using Playwright.
 * Launches Chromium, runs each test with self-healing (optionally in parallel),
 * collects results, saves traces/videos, runs the AI feedback loop, and
 * finalises the run.
 *
 * @param {Object}      project                   - The project `{ id, name, url }`.
 * @param {Object[]}    tests                     - Array of test objects to execute.
 * @param {Object}      run                       - The run record (mutated in place).
 * @param {Object}      [options]
 * @param {number}      [options.parallelWorkers]  - Concurrent browser contexts (1–10). Overrides env default.
 * @param {string}      [options.browser]          - `"chromium" | "firefox" | "webkit"` (DIF-002). Defaults to chromium.
 * @param {string}      [options.device]           - Playwright device preset name (DIF-003).
 * @param {string}      [options.locale]           - BCP 47 locale (AUTO-007).
 * @param {string}      [options.timezoneId]       - IANA timezone (AUTO-007).
 * @param {Object}      [options.geolocation]      - `{ latitude, longitude }` (AUTO-007).
 * @param {AbortSignal} [options.signal]           - Abort signal for cancellation.
 * @param {number|null} [options.shardIndex]       - CAP-002 Phase 2: when set,
 *   the cross-process shard worker passes its 0-based shard index so trace
 *   artifacts land at `${TRACES_DIR}/${runId}/shard-${shardIndex}.zip`
 *   instead of the single-path layout. `null` (default) preserves the
 *   pre-shard zero-regression path — same filename, same `run.tracePath`,
 *   no `tracePaths[]` JSON column populated. See migration 026.
 * @returns {Promise<void>}
 */
export async function runTests(project, tests, run, { parallelWorkers, browser: browserName, device, locale, timezoneId, geolocation, networkCondition, signal, shardIndex = null } = {}) {
  const runId = run.id;
  // CAP-002 Phase 2 (Prerequisite #2) — shard-mode trace artifacts live in a
  // per-run subdirectory keyed by shard index so N concurrent shard workers
  // can write side-by-side without colliding on a single `${runId}.zip`.
  // Single-shard runs (`shardIndex == null`) preserve the legacy single-path
  // layout for bit-for-bit zero regression. The route-relative artifact path
  // mirrors the on-disk shape — `signArtifactUrl` and the trace-viewer
  // static-file route already handle nested paths via `req.params[0]`.
  const isShardMode = shardIndex != null;
  const tracePath = isShardMode
    ? `${TRACES_DIR}/${runId}/shard-${shardIndex}.zip`
    : `${TRACES_DIR}/${runId}.zip`;

  // AUTO-001: smoke tests always dispatch first regardless of caller order.
  // This is a runner-level invariant — any callsite of runTests (route layer,
  // BullMQ worker, single-test execute, future schedulers) gets the same
  // pin-smoke-to-front guarantee without duplicating the rule. Risk-based
  // ordering of the non-smoke tail is established at the route layer (where
  // run history + changedPages are available); the runner stays history-free
  // and only enforces the smoke pin to preserve auditability of the saved
  // run.testQueue order. Stable sort: tests retain their input order within
  // the smoke / non-smoke partitions.
  tests = [
    ...tests.filter((t) => isSmokeTest(t)),
    ...tests.filter((t) => !isSmokeTest(t)),
  ];

  // Resolve concurrency: per-run override → env default → 1 (sequential)
  const workers = Math.max(1, Math.min(10, parallelWorkers || DEFAULT_PARALLEL_WORKERS));

  // CAP-002 — partition the dispatch queue into `run.shardCount` contiguous
  // slices and tag each test with its shard index. Today the partition runs
  // in-process via `poolMap`; the follow-up cross-process PR (see
  // ROADMAP CAP-002 — coordinator + BullMQ shard jobs + Redis pub/sub
  // abort) will lift this same partition algorithm into the queue layer
  // so `partitionTestsIntoShards` is the single source of truth for the
  // split. `run.shardCount` defaults to 1 (the route layer only writes >1
  // when the caller explicitly passed `shards: N`), so fixture-less runs
  // and runs that only set `dialsConfig.parallelWorkers` go through the
  // single-shard zero-regression path.
  const shardCount = Math.max(1, Number(run.shardCount) || 1);
  // CAP-002 Phase 2 — when invoked by a shard worker (`shardIndex != null`),
  // the caller has already pre-partitioned the suite at enqueue time
  // (`partitionTestIdsForShards` in routes/runs.js), so this single call
  // owns ONE shard's slice. Stamp every test with the assigned shardIndex
  // so `processResult` attributes results to the right shard; skip the
  // in-process partition + shard-progress tracking (the worker drives
  // shard completion externally via `runRepo.incrementShardsCompleted`
  // after this function returns). Legacy single-process / non-sharded
  // callers (`isShardMode === false`) keep using the in-process partition
  // bit-for-bit — zero regression.
  let shardSizes;
  let shardRemaining;
  if (isShardMode) {
    // Pre-partitioned slice — every test belongs to this shard.
    for (const t of tests) { t._shardIndex = shardIndex; }
    shardSizes = [tests.length];
    shardRemaining = [tests.length];
  } else {
    ({ sizes: shardSizes } = partitionTestsIntoShards(tests, shardCount));
    // Track shard completion via a remaining-tests counter so we increment
    // `run.shardsCompleted` exactly when a shard's *last* test reports back —
    // poolMap may interleave shards (workers > shardCount, or shards of
    // different sizes), so a naive "increment per shard at boundary" would
    // miscount under concurrent dispatch.
    shardRemaining = [...shardSizes];
    if (run.shardsCompleted == null) run.shardsCompleted = 0;
    // CAP-002 — empty shards (size 0, possible when shardCount > tests.length)
    // have no tests to drain via `recordTestShardComplete`, so the counter
    // would never advance for them. Without pre-crediting, the badge would
    // surface "Shards M/N" with M < N during execution and only reconcile at
    // the very end of `finalizeRunIfNotAborted` — and if the run is aborted
    // before finalization, the badge would be permanently stuck at the
    // partial value. SSE snapshots fire on every result, so the badge needs
    // to reflect "no work to do here" the moment the partition is computed.
    const emptyShards = shardSizes.filter((s) => s === 0).length;
    if (emptyShards > 0) {
      run.shardsCompleted = Math.min(shardCount, run.shardsCompleted + emptyShards);
    }
  }

  // Classify each test once upfront and cache the result on the test object.
  // This avoids re-parsing the code body via isApiTest() multiple times per
  // test (previously called 4× each: allApiOnly, apiCount, logging, executeTest).
  // executeTest reads test._isApi instead of re-calling isApiTest().
  for (const t of tests) {
    t._isApi = !!(t.playwrightCode && isApiTest(t.playwrightCode));
    // Persist the classification on the test object so the frontend can read
    // test.isApiTest directly without reimplementing the detection heuristic.
    testRepo.update(t.id, { isApiTest: t._isApi });
  }

  // If every test is API-only, skip the entire browser launch + trace context
  // to save ~100-200MB of RAM.
  const allApiOnly = tests.every(t => t._isApi);

  let browser = null;
  let traceContext = null;

  // DIF-002: resolve the requested browser once so we can log + persist a
  // canonical name (invalid / unknown values fall back to chromium).
  const { name: resolvedBrowser } = resolveBrowser(browserName);
  run.browser = resolvedBrowser;

  structuredLog("run.start", { runId, projectId: project.id, tests: tests.length, workers, allApiOnly, browser: resolvedBrowser });

  if (!allApiOnly) {
    // Lazy shim: forwards `newContext()` into the pool while keeping the
    // `isConnected()` health probe (`executeTest.js:484` Bundle-B fix #5)
    // honest. Without this, the probe would always return `true` and an
    // OOM-killed Chromium between tests would skip the structured
    // `ERR_BROWSER_DISCONNECTED` early-fail path, surfacing instead as
    // a less-helpful "Target closed" deep inside `newContext`. The pool
    // tracks its warm browser per type; the read-only helper reflects
    // the cached handle's real connection state.
    browser = {
      isConnected: () => browserPool.isBrowserConnected(resolvedBrowser),
      newContext: async (contextOptions = {}) => {
        const lease = await browserPool.acquire({ browserType: resolvedBrowser, contextOptions, createPage: false });
        return lease.context;
      },
    };

    // Shared tracing context (separate from per-test contexts).
    //
    // The trace context is run-scoped: it is created here and held until the
    // `finally` block flushes the trace zip. We MUST NOT route it through
    // `browserPool.acquire()` — that would lock a pool slot for the entire
    // run (silently reducing effective per-run parallelism by 1, and
    // deadlocking outright when `BROWSER_POOL_SIZE=1` because every
    // per-test acquire would queue forever behind the trace lease). Instead
    // we share the warm browser process via `acquireSharedBrowser()` and
    // own the context lifecycle ourselves; per-test contexts continue to
    // flow through `acquire()` and respect the slot accounting.
    try {
      const sharedBrowser = await browserPool.acquireSharedBrowser(resolvedBrowser);
      traceContext = await sharedBrowser.newContext({
        userAgent: "Mozilla/5.0 (compatible; AutonomousQA/1.0)",
        viewport: { width: 1280, height: 720 },
      });
      await traceContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
    } catch (ctxErr) {
      // Close the half-built trace context on its way out. The pre-MNT-015
      // path relied on `browser.close()` (later in the original `finally`)
      // to implicitly close every context — but the browser is now pooled
      // and lives past this run, so an unclosed `traceContext` would leak
      // a viewport buffer + tracing state on the warm browser process.
      // The `finally` block at the bottom of this file's try-block also
      // closes `traceContext` on the success path, but only if we make it
      // there — a `tracing.start()` failure throws BEFORE the inner try
      // (line 716), so its `finally` never runs for this branch.
      if (traceContext) {
        await traceContext.close().catch(() => {});
        traceContext = null;
      }
      const classified = classifyError(ctxErr, "run");
      run.status = "failed";
      run.error = classified.message;
      run.errorCategory = classified.category;
      run.finishedAt = new Date().toISOString();
      run.shardsCompleted = shardCount;
      logError(run, classified.message);
      structuredLog("browser.pool_acquire_failed", { runId, error: classified.message });
      throw ctxErr;
    }
  }

  const apiCount = tests.filter(t => t._isApi).length;
  const modeLabel = workers > 1 ? `${workers} parallel workers` : "sequential";
  log(run, `🚀 Starting test run: ${tests.length} tests (${modeLabel})`);
  log(run, `⚙️ Run config:`);
  log(run, `Execution mode: ${workers > 1 ? `⚡ Parallel (${workers} workers)` : "▶ Sequential (1 worker)"}`);
  log(run, `Tests queued: ${tests.length}${apiCount > 0 ? ` (${apiCount} API, ${tests.length - apiCount} browser)` : ""}`);
  log(run, `Project URL: ${project.url}`);
  log(run, allApiOnly
    ? `Browser: ⏭️ Skipped (all tests are API-only)`
    : `Browser: ${resolvedBrowser} (${BROWSER_HEADLESS ? "headless" : "headed"})`);

  const runStart = Date.now();
  const allVideoSegments = [];
  // CAP-002 Phase 2 — per-shard stat accumulators. The worker composes the
  // parent `runs` row's totals from each shard's returned delta via
  // `runRepo.incrementRunStats`. For legacy single-shard runs these stay
  // aligned with `run.passed` / `run.failed` and are simply returned for
  // completeness — the caller may ignore them. `shardTotalDelta` captures
  // data-driven tests' iteration overflow (N fixture rows expand to N
  // iteration results — the original slice size already counted 1).
  let shardPassed = 0;
  let shardFailed = 0;
  let shardTotalDelta = 0;

  // CAP-002 — advance shard progress once per *test* (not per iteration
  // result). Data-driven tests call processResult N times for a single
  // test, so decrementing inside processResult would drain the shard
  // counter mid-test and surface a premature "Shards M/N" badge. The
  // poolMap callback below calls this helper exactly once after a test
  // fully resolves (success or crash), so each shard's counter reaches
  // zero precisely when its last test reports back. `_shardIndex` is
  // stamped by `partitionTestsIntoShards`; defensive `?? 0` covers
  // tests that bypass the partition (single-shard runs still attribute
  // to shard 0 — same effective behaviour).
  //
  // In `isShardMode` (cross-process shard worker), the BullMQ worker
  // drives `run.shardsCompleted` externally via
  // `runRepo.incrementShardsCompleted` after this function returns —
  // this helper must NOT touch the counter, or the boundary-crossing
  // finalizer detection in `runWorker.js` would double-count. The
  // previous implementation no-op'd by accident: tests are stamped
  // with the worker's `shardIndex` (e.g. 2) while `shardRemaining` is
  // sized `[tests.length]` (length 1), so `shardRemaining[2]` was
  // `undefined` and the `!= null` guard silently bailed. Make the
  // intent explicit so a future refactor of `shardRemaining` sizing
  // can't silently start incrementing here and break the worker's
  // external counter management.
  function recordTestShardComplete(test) {
    if (isShardMode) return;
    const shardIdx = test?._shardIndex ?? 0;
    if (shardRemaining[shardIdx] != null) {
      shardRemaining[shardIdx] -= 1;
      if (shardRemaining[shardIdx] === 0) {
        run.shardsCompleted = Math.min(shardCount, (run.shardsCompleted || 0) + 1);
      }
    }
  }

  // ── Process a single test result — shared by the pool worker callback ────
  function processResult(test, result) {
    // CAP-002 Phase 2 (Prerequisite #3) — stamp the result with its parent
    // test's shard index so the retry-reset path in `runWorker.js` can
    // identify which results to wipe (this shard's) vs. which to preserve
    // (sibling shards that already completed). Single-shard runs stamp
    // `_shardIndex: 0` uniformly — the retry filter is a no-op in that case.
    // `?? 0` covers the pre-partition path (crash-synth before
    // partitionTestsIntoShards stamps the test); shard 0 is the right
    // default for a single-shard run.
    result._shardIndex = test?._shardIndex ?? 0;
    run.results.push(result);

    if (result.videoPath) allVideoSegments.push(result.videoPath);

    // CAP-002 Phase 2 — count locally so we can return the shard's stats
    // delta to the worker, AND mirror to `run.passed` / `run.failed` for
    // legacy single-shard callers. In shard mode the worker composes the
    // parent run's totals from each shard's returned delta via
    // `runRepo.incrementRunStats`, so we don't bump the parent here.
    if (result.status === "passed") {
      if (!isShardMode) run.passed++;
      shardPassed++;
      logSuccess(run, `PASSED (${result.durationMs}ms)`);
    } else if (result.status === "warning") {
      if (!isShardMode) run.passed++;
      shardPassed++;
      logWarn(run, `WARNING: ${result.error}`);
    } else {
      if (!isShardMode) run.failed++;
      shardFailed++;
      logError(run, `FAILED: ${result.error}`);
    }
    // INF-007: count every executed result (passed + warning + failed) AND
    // record per-test duration so dashboards get p50/p95/p99 latency split by
    // browser engine + outcome. Skipped results never reach `processResult` —
    // they're pre-seeded into `run.results` at the route layer before this
    // function runs — so the counter cleanly captures "tests that actually
    // executed in a browser". Best-effort: a metrics hiccup must never fail
    // the run. `durationMs` is set by `executeTest.js` for every result; the
    // `?? 0` defence covers synth crash rows that didn't carry timing.
    //
    // Browser label: prefer `result.browser` (always populated by
    // `executeTest.js` from the test's actual launch options) over
    // `run.browser` (set once at the run level). They agree today, but
    // preferring the per-result value future-proofs the metric against any
    // change that lets individual tests override the run-level browser
    // (e.g. cross-browser sharding in a single run).
    try {
      const labels = { status: result.status || "unknown", browser: result.browser || run?.browser || "unknown" };
      testsExecutedTotal.inc(labels);
      const seconds = Number(result.durationMs ?? 0) / 1000;
      if (Number.isFinite(seconds) && seconds >= 0) testDurationSeconds.observe(labels, seconds);
    } catch { /* best-effort */ }

    // Emit result event (without the heavy base64 screenshot)
    const { screenshot: _ss, ...resultLean } = result;
    const signedResult = { ...resultLean };
    if (signedResult.screenshotPath) signedResult.screenshotPath = signArtifactUrl(signedResult.screenshotPath);
    if (signedResult.videoPath) signedResult.videoPath = signArtifactUrl(signedResult.videoPath);
    emitRunEvent(run.id, "result", { result: signedResult });
    if (result.screenshotPath) {
      emitRunEvent(run.id, "screenshot", {
        testId: test.id,
        screenshotPath: signArtifactUrl(result.screenshotPath),
      });
    }

    testRepo.update(test.id, {
      lastResult: result.status,
      lastRunAt: new Date().toISOString(),
    });

    // CAP-002 Phase 2 — flush this single result via the atomic primitive
    // in shard mode so N concurrent shard workers don't last-write-wins
    // each other's results. Legacy single-process runs continue to use
    // `runRepo.save(run)` (the full-snapshot path) for bit-for-bit zero
    // regression. The atomic primitive splices in a single SQL statement
    // (row-locked by SQLite/Postgres) — Prerequisite #1's contract,
    // verified end-to-end by `run-storage-concurrency.test.js`.
    if (isShardMode) {
      runRepo.appendRunResults(run.id, [result]);
    } else {
      // Flush run state to SQLite after each result so a crash mid-run
      // doesn't lose all results collected so far. SQLite writes are
      // synchronous (~1ms) so this adds negligible overhead per test.
      runRepo.save(run);
    }

    // B1.1 (AUDIT-ROADMAP Bundle 1) — append-only checkpoint write to
    // `run_test_results`. This row is the SOLE data source the resume
    // endpoint (`POST /api/v1/runs/:runId/resume`) consults via
    // `runTestResultRepo.getCompletedTestIds(runId)` to decide which
    // tests to skip after a crash. Industry-standard crash-recovery
    // checkpoints (GitHub Actions `re-run failed jobs`, CircleCI
    // `rerun-from-failed`, Buildkite `retry job`, AWS Step Functions,
    // Temporal workflow checkpoints) are durable, never lossy — losing
    // a checkpoint row would force resume to re-execute a test that
    // already completed, which can produce duplicate side-effects
    // (created records, sent emails, charged payments) and break the
    // "resume picks up where the crash left off" contract.
    //
    // Therefore: routed through `dbWriteQueue` with `priority: "durable"`
    // so each write commits synchronously inside its own BEGIN/COMMIT
    // before this call returns. Matches Postgres `synchronous_commit=on`
    // / Kafka `acks=all` / MySQL `sync_binlog=1` for audit-class writes.
    // The dbWriteQueue module's own JSDoc (`utils/dbWriteQueue.js:41`)
    // documents this rule of thumb: "Audit / compliance / circuit-breaker
    // writes → `durable`".
    //
    // Throughput cost: ~1–5 ms added per test result vs batched mode.
    // Acceptable because (a) test execution itself takes seconds-to-
    // minutes, so the durable write is <0.1% of wall-clock per test,
    // and (b) SQLite WAL still amortises the BEGIN/COMMIT — measured
    // overhead at parallelWorkers=10 is <5% even on chatty test suites.
    //
    // The legacy `runRepo.save(run)` / `runRepo.appendRunResults()`
    // paths above are kept (single-shard rewrites the full JSON
    // `results[]`; shard-mode splices via the atomic primitive) so
    // pre-B1.1 consumers reading `run.results` keep working. The
    // duplicate-write counter `app_run_test_result_duplicates_total
    // {reason="resume_replay"}` makes occasional resume-path replays
    // (when a near-persisted write was already committed) observable
    // without alerting — only `reason="duplicate_dispatch"` is a bug.
    enqueueDbWrite(
      () => {
        runTestResultRepo.append(run.id, {
          testId: test.id,
          status: result.status,
          error: result.error || null,
          errorCategory: result.errorCategory || null,
          duration: Number.isFinite(result.durationMs) ? result.durationMs : null,
          retryCount: result.retryCount || 0,
          iterationIndex: Number.isInteger(result.iterationIndex) ? result.iterationIndex : 0,
          // Lean artifact projection — only the paths the resume endpoint
          // and CI consumers need. Skip screenshot / video buffers (heavy)
          // and webVitals / coverage payloads (rehydrated from legacy
          // `runs.results` until the follow-up flips `getById` to the new
          // source).
          artifacts: {
            screenshotPath: result.screenshotPath || null,
            videoPath: result.videoPath || null,
            tracePath: result.tracePath || null,
          },
          healingEvents: Array.isArray(result.healingEvents) ? result.healingEvents : null,
        });
      },
      { priority: "durable" },
    );

    // Broadcast a snapshot after each result so the frontend progress bar
    // updates in real time (especially important during parallel execution
    // where multiple results arrive in quick succession). In shard mode the
    // snapshot is re-read from the DB so sibling-shard results that just
    // landed are reflected — the local `run` object only carries this
    // shard's slice.
    if (!isRunAborted(run, signal)) {
      const snapshotRun = isShardMode ? (runRepo.getById(run.id) || run) : run;
      emitRunEvent(run.id, "snapshot", { run: signRunArtifacts(snapshotRun) });
    }
  }

  try {
    await poolMap(tests, workers, async (test, i) => {
      if (signal?.aborted) return;

      const hasCode = !!(test.playwrightCode && extractTestBody(test.playwrightCode));
      const workerTag = workers > 1 ? ` [w${(i % workers) + 1}]` : "";
      const typeTag = test._isApi ? "🌐 API" : hasCode ? "executing generated code" : "fallback smoke test";
      structuredLog("test.start", { runId, testId: test.id, index: i + 1, total: tests.length, isApi: !!test._isApi });
      log(run, `▶ [${i + 1}/${tests.length}]${workerTag} ${test.name} (${typeTag})`);

      try {
        // The retry callback returns the *array* of iteration results (not a
        // single result) so processResult fires exactly once per iteration of
        // the final attempt — calling processResult inside the callback would
        // double-count `run.passed` / `run.failed` on every retry and push
        // `run.results.length` past `run.total`, corrupting quality-gate
        // evaluation, the SSE progress bar, and the `run.retryCount` /
        // `run.failedAfterRetry` aggregations below.
        const { result: iterResults, retryCount } = await executeWithRetries(async (attempt) => {
          if (attempt > 0) {
            logWarn(run, `↻ Retrying ${test.name} (attempt ${attempt + 1}/${MAX_TEST_RETRIES + 1})`);
          }
          // CAP-001: pull the fixture row-set keyed to this test's current
          // codeVersion. Falsy → fixture-less single-iteration path (zero
          // regression). On retries we re-resolve the fixture so a freshly
          // uploaded fixture between attempts is picked up; the cost is one
          // indexed SELECT per attempt (1-3 max).
          const fixture = testFixtureRepo.getFixture(test.id, Number(test.codeVersion || 1));
          const fixtureRows = fixture?.rows;
          const attemptResults = await executeTestIterations(
            test,
            fixtureRows,
            (iterTest) => executeTest(iterTest, browser, runId, i, runStart, { browser: resolvedBrowser, device, locale, timezoneId, geolocation, networkCondition, coverageEnabled: !!project.coverageEnabled, serverCoverageEndpoint: project.serverCoverageEndpoint || null }),
          );
          const lastResult = attemptResults[attemptResults.length - 1] || null;
          // Retry semantics:
          //  - Fixture-less tests (single iteration): preserve the original
          //    contract — throw on failure so executeWithRetries reruns the
          //    test up to MAX_TEST_RETRIES times. Earlier attempts are
          //    discarded; only the final attempt's results are surfaced.
          //  - Data-driven tests (≥1 fixture row): never retry. Retrying
          //    would re-execute every row (including the passes) on every
          //    failure, multiplying browser work. A visible log line keeps
          //    the suppression explicit — otherwise a failed data-driven
          //    test looks identical to a fixture-less retry exhaustion in
          //    the run timeline, masking the design choice from reviewers.
          // Log the retry-skip when *any* iteration failed, not just the
          // last one — an intermediate row failure with a passing tail row
          // would otherwise silently drop the message and break QA
          // acceptance criterion #18 in `QA.md`.
          const failedRows = attemptResults.filter((r) => r?.status === "failed").length;
          if (fixtureRows?.length && failedRows > 0) {
            logWarn(run, `↻ Skipping retry for ${test.name} — ${failedRows}/${attemptResults.length} fixture iteration(s) failed (data-driven tests don't retry)`);
          }
          if (!fixtureRows?.length && lastResult?.status === "failed") {
            const retryErr = new Error(lastResult.error || "Test failed");
            retryErr.result = lastResult;
            // Stash the attempt's results so the catch block can surface
            // them once after retries are exhausted (avoids double-emit).
            retryErr.attemptResults = attemptResults;
            throw retryErr;
          }
          return attemptResults;
        }, MAX_TEST_RETRIES);
        // CAP-001: `run.total` is initialised at the route layer to
        // `tests.length` (`backend/src/routes/runs.js:209`) — i.e. one slot
        // per *test*. Data-driven tests fan out into N iteration results
        // and each iteration increments `run.passed` / `run.failed` via
        // `processResult` below, so without adjusting `run.total` here the
        // pass-rate denominator in `evaluateQualityGates` (and the matching
        // `flakyPct` denominator) underflows, producing pass rates >100%
        // and making `minPassRate` / `maxFailures` gates unreachable. The
        // RunDetail progress bar would also render "5 / 1 test cases
        // executed". Bump the total by (N - 1) so the dispatched-iteration
        // count and the run aggregator stay in lock-step. Fixture-less
        // tests yield exactly one iteration → no adjustment, zero
        // regression.
        if (iterResults.length > 1) {
          const overflow = iterResults.length - 1;
          if (isShardMode) {
            // Shard mode: the parent run row's `total` is composed by the
            // worker via `incrementRunStats(totalDelta)` after this function
            // returns. Track the delta locally and surface it on return —
            // bumping `run.total` here would not persist (we don't save the
            // full snapshot in shard mode) and would mislead local SSE
            // snapshots that re-read from the DB anyway.
            shardTotalDelta += overflow;
          } else {
            run.total += overflow;
          }
        }
        // Surface every iteration from the final attempt to the run
        // aggregator — exactly once, after retries have fully resolved.
        for (const iterResult of iterResults) {
          iterResult.retryCount = retryCount;
          iterResult.failedAfterRetry = false;
          processResult(test, iterResult);
        }
        // CAP-002 — drain the shard counter once per test, after every
        // iteration result has been recorded. See `recordTestShardComplete`.
        recordTestShardComplete(test);
        const finalResult = iterResults[iterResults.length - 1];
        if (finalResult) {
          structuredLog("test.result", { runId, testId: test.id, status: finalResult.status, durationMs: finalResult.durationMs });
        }
      } catch (err) {
        // Build a synthetic result and route through processResult so SSE
        // `result` and `snapshot` events are emitted — otherwise the
        // frontend progress bar stalls during parallel execution.
        structuredLog("test.crash", { runId, testId: test.id, error: err.message?.slice(0, 200) });
        const errorResult = err.result || {
          testId: test.id, testName: test.name,
          status: "failed", error: err.message,
          durationMs: 0, network: [], consoleLogs: [],
        };
        // Prefer the actual retry count surfaced by executeWithRetries —
        // synchronous crashes from executeTest may exhaust fewer attempts
        // than MAX_TEST_RETRIES suggests.
        errorResult.retryCount = typeof err.retryCount === "number"
          ? err.retryCount
          : MAX_TEST_RETRIES;
        errorResult.failedAfterRetry = true;
        // processResult fires exactly once on exhaustion — earlier attempts
        // were discarded inside the retry loop so we never double-count.
        processResult(test, errorResult);
        // CAP-002 — crash path also resolves the test exactly once, so
        // drain the shard counter here too (matches the success path).
        recordTestShardComplete(test);
      }
    }, signal);
  } finally {
    // Always clean up browser resources — even if the loop threw unexpectedly.
    // browser/traceContext are null when all tests are API-only.
    if (traceContext) {
      try {
        await traceContext.tracing.stop({ path: tracePath });
        // Route through the storage adapter so S3-mode deployments upload
        // the trace zip; in local mode this is effectively a no-op rewrite
        // of the same file Playwright just produced.
        // CAP-002 Phase 2 (Prerequisite #2) — single source of truth for the
        // trace artifact URL. Mirrors the on-disk shard layout so the
        // trace-viewer route resolves nested paths verbatim. Single-shard
        // runs keep the legacy `/artifacts/traces/${runId}.zip` URL for
        // bit-for-bit zero regression with `run.tracePath` consumers
        // (RunDetail link, GitHub Check summary, signed-URL middleware).
        const traceArtifactPath = shardTraceArtifactPath(runId, isShardMode ? shardIndex : null);
        try {
          await writeArtifactBuffer({
            artifactPath: traceArtifactPath,
            absolutePath: tracePath,
            buffer: fs.readFileSync(tracePath),
            contentType: "application/zip",
          });
          run.tracePath = traceArtifactPath;
          // In shard mode also record the per-shard URL in the new
          // `tracePaths` JSON column (migration 026) so `RunDetail.jsx`
          // renders a dropdown when `shardCount > 1`. Use the atomic
          // primitive — N shard workers writing different slots on the
          // same `runs` row must compose, not last-write-wins. The
          // primitive's transaction wrapper serializes the read+write so
          // a concurrent sibling-shard update to a different slot can't
          // be lost (Prerequisite #1 contract for the trace-paths column).
          if (isShardMode) {
            if (!Array.isArray(run.tracePaths)) run.tracePaths = [];
            run.tracePaths[shardIndex] = traceArtifactPath;
            runRepo.setShardTracePath(runId, shardIndex, traceArtifactPath);
          }
        } catch (uploadErr) {
          logWarn(run, `Trace upload failed: ${uploadErr.message}`);
          run.tracePath = traceArtifactPath;
        }
        log(run, `📊 Trace saved`);
      } catch (e) {
        logWarn(run, `Trace save failed: ${e.message}`);
      }
      // We own the trace context directly (not via a pool lease) — see
      // `acquireSharedBrowser` rationale above. Close it here so the
      // underlying warm browser process stays available to other tests.
      await traceContext.close().catch(() => {});
    }
  }

  if (allVideoSegments.length > 0) {
    run.videoPath = allVideoSegments[0];
    run.videoSegments = allVideoSegments;
    log(run, `  🎬 ${allVideoSegments.length} video segment(s) saved`);
  }

  // CAP-002 Phase 2 — in shard mode, hand off to the worker for finalization.
  // The shard owns its slice's execution + trace flush; the worker composes
  // the parent run's totals via `incrementRunStats`, increments
  // `shardsCompleted`, and the boundary-crossing shard runs the feedback
  // loop + finalize + `done` event exactly once. Returning here avoids:
  //   - Running the feedback loop N times (once per shard) — wasteful AI calls
  //     and N redundant `testRepo.update(... reviewStatus: "draft")` writes.
  //   - N shards racing on `run.status = "completed"` via
  //     `finalizeRunIfNotAborted` — last-shard-wins semantics belong in the
  //     worker, gated on the atomic `incrementShardsCompleted` boundary.
  //   - N `done` SSE events for a single logical run.
  // Returns the shard's stats delta so the worker can compose them onto the
  // parent `runs` row atomically.
  if (isShardMode) {
    // AUTO-009k — pre-aggregate this shard's coverage slice and persist the
    // mergeable per-shard summary so the boundary-crossing finalizer can
    // set-union across shards instead of re-processing megabytes of raw V8
    // ranges from `runs.results`. Matches the industry pattern (c8 / nyc /
    // Istanbul `libCoverage.merge()` / Codecov upload-then-merge): each
    // shard emits a compact Istanbul-shaped summary; the finalizer merges
    // via id-set union. Naive count-summing across shards is wrong (proven
    // counter-example: see `mergeShardSummaries` JSDoc).
    //
    // Pre-aggregation also lets us strip raw `jsCoverage` from this shard's
    // results BEFORE they're persisted to `runs.results` — saving 10s of MB
    // per row on large-bundle SUTs. The boundary-crossing finalizer
    // (`runWorker.js#finalizeShardedRun`) detects the persisted summaries
    // via `runRepo.getById(runId).shardCoverageSummaries` and uses
    // `mergeShardSummaries` instead of the legacy AUTO-009f re-aggregation
    // path. Fallback path remains so a partial-deploy / migration race
    // (some shards on old code without persistence) still produces a
    // correct summary via the raw-results aggregator.
    //
    // Best-effort: any failure in pre-aggregation OR persistence falls back
    // to the AUTO-009f re-aggregation path. Coverage capture must never
    // fail a shard.
    try {
      const shardCoverage = await aggregateShardCoverage(project, run.results);
      if (shardCoverage) {
        runRepo.setShardCoverageSummary(run.id, shardIndex, shardCoverage);
        // Strip raw jsCoverage from this shard's in-memory results — the
        // per-shard summary now carries the mergeable id-set state, and
        // the boundary-crossing finalizer reads `shardCoverageSummaries`
        // (not raw `runs.results`) when AUTO-009k payloads are present.
        // The strip prevents megabytes of raw V8 ranges from landing in
        // `runs.results` via the route layer's eventual save.
        for (const r of run.results) {
          if (r && "jsCoverage" in r) delete r.jsCoverage;
        }
      }
    } catch (err) {
      // Swallow + log — fall back to AUTO-009f re-aggregation at finalizer.
      console.warn(formatLogLine("warn", runId,
        `[testRunner] AUTO-009k pre-aggregation failed: ${err?.message || err}`));
    }

    const elapsed = ((Date.now() - runStart) / 1000).toFixed(1);
    structuredLog("run.shard_execution_done", {
      runId, shardIndex,
      passed: shardPassed, failed: shardFailed,
      totalDelta: shardTotalDelta, elapsedSec: parseFloat(elapsed),
    });
    return {
      passed: shardPassed,
      failed: shardFailed,
      totalDelta: shardTotalDelta,
      tracePath: run.tracePath || null,
    };
  }

  // AUTO-005: aggregate per-result retry telemetry onto the run record so
  // the dedicated `runs.retryCount` / `runs.failedAfterRetry` columns
  // (migration 011) are populated for run-level analytics queries.
  run.retryCount = run.results.reduce((sum, r) => sum + (r.retryCount || 0), 0);
  run.failedAfterRetry = run.results.filter(r => r.failedAfterRetry).length;

  run.webVitalsResult = evaluateWebVitalsBudgets(project.webVitalsBudgets, run);
  run.rootCauses = clusterFailures({ results: run.results });
  // AUTO-009f — `finalizeCoverage` is the single source of truth for the
  // post-run coverage tail. Same helper is invoked from
  // `workers/runWorker.js#finalizeShardedRun` so sharded runs get an
  // identical `coverageSummary` shape (parity bug fix — previously every
  // multi-shard run with coverage enabled persisted `null`). The helper
  // runs the aggregator + source-map resolver (AUTO-009b), enforces the
  // AUTO-009g memory ceiling, and strips raw `jsCoverage` payloads from
  // `run.results` AFTER aggregation so the persisted JSON column stays lean.
  // AUTO-009d — pass changedFileRanges (populated at trigger time by
  // routes/trigger.js when the run was launched from a GitHub PR webhook)
  // so finalizeCoverage can compute the PR-scoped coverage diff. The diff
  // lands as `summary.prCoverageDiff`; we lift it onto `run.prCoverageDiff`
  // for the dedicated column, then strip it from the summary so the
  // persisted `coverageSummary` shape stays unchanged.
  run.coverageSummary = await finalizeCoverage(project, run.results, {
    changedFileRanges: run.changedFileRanges || null,
  });
  if (run.coverageSummary?.prCoverageDiff) {
    run.prCoverageDiff = run.coverageSummary.prCoverageDiff;
    delete run.coverageSummary.prCoverageDiff;
  }
  // Stamp the merge-source marker so the Dashboard CoveragePanel and
  // RunDetail can render a tooltip distinguishing single-process runs from
  // the sharded merge path. All three variants (`"single_process"`,
  // `"shards"`, `"fallback"`) are set at the boundary between aggregation
  // and persistence so a downstream consumer never sees a coverageSummary
  // without the marker on coverage-enabled runs.
  if (run.coverageSummary) run.coverageSummary.mergeSource = "single_process";

  // AUTO-009d — gate evaluation runs AFTER coverage aggregation so the
  // coverage rules see this run's freshly-computed `coverageSummary`. The
  // regression rule needs the previous coverage-enabled run's summary; we
  // pull it via the lean `getRunsWithCoverage` accessor (added for the
  // dashboard) and pick the most-recent row that isn't `run.id` itself
  // (the row at-hand is mid-flight and not yet persisted). Best-effort —
  // a repo failure falls back to `priorRunCoverage: null` which short-
  // circuits the regression rule (same first-run-ever semantics).
  let priorRunCoverage = null;
  if (project?.coverageEnabled) {
    try {
      const history = runRepo.getRunsWithCoverage([project.id], { windowDays: 0, limit: 50 });
      // Newest-last per the accessor's contract; walk backwards skipping
      // the current run id so the lookup is correct even if `save(run)`
      // wrote `run.coverageSummary` to disk between aggregation and gate
      // eval (single-process path saves on every result via `processResult`).
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].id !== run.id && history[i].coverageSummary) {
          priorRunCoverage = history[i].coverageSummary;
          break;
        }
      }
    } catch { /* best-effort — null prior degrades cleanly */ }
  }

  // AUTO-009i — coverage regression alerting. Fires AFTER priorRunCoverage
  // is resolved and BEFORE gate evaluation so the audit row + notification
  // land even when the gate itself doesn't include a regression threshold.
  // The detector is a pure function; the alert dispatcher is best-effort
  // (same contract as `fireNotifications`).
  try {
    const regression = detectCoverageRegression(run.coverageSummary, priorRunCoverage, project);
    if (regression) await fireCoverageRegressionAlert(regression, run, project);
  } catch { /* best-effort — regression alert failure must never block finalize */ }

  run.gateResult = evaluateQualityGates(project.qualityGates, run, { priorRunCoverage });

  // AUTO-009f — raw `jsCoverage` payloads are already stripped by
  // `finalizeCoverage` (above), so we don't need a second cleanup loop here.
  // The strip happens AFTER aggregation in the helper so the persisted
  // `run.results` JSON column never carries the heavy V8 ranges.

  // AUTO-017.3: persist per-run Web Vitals samples for MET-001 trend charts.
  // Best-effort only — telemetry failures must never fail the run.
  try {
    const rows = Array.isArray(run.results) ? run.results : [];
    const keys = ["lcp", "cls", "inp", "ttfb"];
    for (const key of keys) {
      const values = rows
        .map((r) => Number(r?.webVitals?.[key]))
        .filter((v) => Number.isFinite(v));
      if (values.length === 0) continue;
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
      const threshold = Number(project?.webVitalsBudgets?.[key]);
      recordMetric(project.id, `webVitals.${key}`, avg, { runId, source: "run", metric: key }, runStart);
      if (Number.isFinite(threshold)) {
        recordMetric(project.id, `webVitals.${key}.budget`, threshold, { runId, source: "budget", metric: key }, runStart);
      }
    }
  } catch (metricErr) {
    logWarn(run, `Web Vitals trend metric write failed: ${metricErr.message}`);
  }

  // NOTE: We intentionally keep run.status === "running" here so that:
  //   1. The abort endpoint (POST /api/runs/:id/abort) still works during the
  //      feedback loop — it checks run.status === "running".
  //   2. SSE reconnections don't prematurely close — the /events endpoint sends
  //      an immediate "done" + res.end() when run.status !== "running", which
  //      would cut off the client while the feedback loop is still active.
  // The status is set to "completed" only after the feedback loop finishes.
  const elapsed = ((Date.now() - runStart) / 1000).toFixed(1);
  structuredLog("run.execution_done", { runId, passed: run.passed, failed: run.failed, total: run.total, elapsedSec: parseFloat(elapsed) });
  log(run, `📋 Test execution done: ${run.passed} passed, ${run.failed} failed out of ${run.total} in ${elapsed}s${workers > 1 ? ` (${workers}x parallel)` : ""} — starting post-run analysis…`);

  // Broadcast a final snapshot so the frontend sees the complete pass/fail
  // counts before the feedback loop starts its long-running AI calls.
  // (processResult already emits per-result snapshots, but this ensures the
  // frontend has the final state even if the last result's snapshot was lost.)
  if (!isRunAborted(run, signal)) {
    emitRunEvent(run.id, "snapshot", { run: signRunArtifacts(run) });
  }

  // ── Feedback loop: auto-regenerate high-priority failing tests ──────────
  // Delegated to runner/feedbackIntegration.js — no-ops when no failures,
  // aborted, or no AI provider configured.
  await runFeedbackLoop(run, tests, signal);

  // Now that the feedback loop is done, finalize the run status.
  // This is the single place where status transitions to "completed".
  // Guard the log() call inside the callback so it only fires when the run
  // actually transitions to "completed". After an abort, the SSE "done" event
  // has already been emitted and the stream is closed — logging here would
  // append to run.logs but the SSE broadcast would be silently lost.
  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    // CAP-002 — `run.shardsCompleted` is incremented per-shard in
    // processResult as each shard's last test reports. A normal completion
    // should already have shardsCompleted === shardCount; this final
    // reconciliation only matters if a shard had zero tests (possible when
    // `shards > tests.length` clamps to per-shard size 0), which would
    // otherwise leave shardsCompleted < shardCount and surface a stuck
    // "Shards N-1/N" badge on the completed run.
    if ((run.shardsCompleted || 0) < shardCount) run.shardsCompleted = shardCount;
    run.duration = Date.now() - runStart;
    // INF-007: emit run-level outcome + duration histograms via the shared
    // helper. The label shape (`type`, `status`) drives both the per-type
    // success-rate panel and the per-type p99 latency SLO panel from a single
    // PromQL query. See `utils/metrics.js#recordRunOutcome` for the full
    // contract — falls back to `test_run` for the type label, and is fully
    // best-effort so a metrics-registry hiccup never blocks finalize.
    recordRunOutcome(run, "test_run");
    logSuccess(run, `Run complete: ${run.passed} passed, ${run.failed} failed out of ${run.total}`);
    structuredLog("run.complete", {
      runId, projectId: project.id,
      passed: run.passed, failed: run.failed, total: run.total,
      durationMs: run.duration,
    });
    // DIF-013: report run outcome (regression / single-test / scheduled run).
    // `run.started` is emitted at the route layer when the run is enqueued —
    // this is the matching `complete` event for funnel analysis. Retry
    // telemetry (AUTO-005) is included so we can measure flake-isolation
    // impact in aggregate.
    trackTelemetry("run.complete", {
      projectId: project.id,
      browser: resolvedBrowser,
      total: run.total,
      passed: run.passed,
      failed: run.failed,
      retryCount: run.retryCount || 0,
      failedAfterRetry: run.failedAfterRetry || 0,
      parallelWorkers: workers,
      durationMs: run.duration,
      url: project.url,
    });
  });

  // Emit "done" only now — after the feedback loop — so the frontend's
  // fetchRun() always sees the final, stable completed state.
  // Skip if already aborted — the abort endpoint already emitted the done event.
  if (!isRunAborted(run, signal)) {
    emitRunEvent(run.id, "done", { status: run.status, passed: run.passed, failed: run.failed, total: run.total });
  }
}

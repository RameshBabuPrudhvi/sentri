/**
 * @module types/run
 * @description Canonical type definitions for the `runs` table row shape and
 * related execution-layer contracts. Type-only module — no runtime exports.
 *
 * Consumed from JS files via JSDoc:
 *   `@param {import('../types/run').Run} run`
 *
 * Single source of truth for the row shape persisted by
 * `backend/src/database/repositories/runRepo.js`. When adding a new column,
 * update both this file AND the `INSERT_COLS` / `JSON_FIELDS` /
 * `ARRAY_DEFAULT_FIELDS` arrays in `runRepo.js`.
 */

export type RunStatus = "running" | "completed" | "failed" | "aborted";

export type RunType = "test_run" | "test_run_shard" | "crawl" | "generate" | "record";

/**
 * One row in the `runs` table after hydration via `rowToRun`. JSON columns
 * are deserialised; sparse array columns (`results`, `tests`, `videoSegments`,
 * `pages`, `rootCauses`) default to `[]` on pre-migration rows, never `null`.
 */
export interface Run {
  id: string;
  projectId: string;
  type: RunType;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string | null;
  duration?: number | null;
  error?: string | null;
  errorCategory?: string | null;

  // Aggregates — composed atomically by `incrementRunStats` in shard mode,
  // bumped per-result by `processResult` in single-process mode.
  total: number;
  passed: number;
  failed: number;
  pagesFound?: number;

  // Result payloads (JSON columns).
  results: RunResult[];
  tests?: unknown[];
  logs?: unknown[];
  videoSegments?: unknown[];
  pages?: unknown[];

  // DIF-012 — env scope.
  environmentId?: string | null;

  // CAP-002 — shard telemetry.
  shardCount?: number | null;
  shardsCompleted?: number | null;
  tracePath?: string | null;
  /** Sparse array indexed by shardIndex; `null` slots = shard never flushed. */
  tracePaths?: (string | null)[] | null;

  // AUTO-010 — root cause clusters.
  rootCauses?: RootCauseCluster[] | null;

  // Quality gates.
  gateResult?: unknown | null;
  webVitalsResult?: unknown | null;
  qualityAnalytics?: unknown | null;

  // Retry telemetry.
  retryCount?: number;
  failedAfterRetry?: number;
}

/**
 * One execution result row inside `run.results[]`. Data-driven tests emit one
 * row per iteration; the `iterationIndex` + `fixtureRow` snapshot make
 * row-level failures attributable (CAP-001).
 */
export interface RunResult {
  testId: string;
  status: "passed" | "failed" | "warning" | "skipped";
  error?: string | null;
  durationMs?: number;
  retryCount?: number;
  failedAfterRetry?: boolean;

  // CAP-001 — data-driven iteration attribution.
  iterationIndex?: number;
  fixtureRow?: Record<string, unknown>;

  // CAP-002 — shard attribution. Used by `purgeShardResults` /
  // `filterShardRetrySurvivors` to scope retry wipes to the failing shard
  // without erasing sibling-shard rows.
  _shardIndex?: number;

  // AUTO-001 / AUTO-004 — skip kinds preserved across retries.
  skipReason?: "over_budget" | "skipped_no_impact";
}

/**
 * One cluster emitted by `pipeline/failureClusterer.js` `clusterFailures()`.
 * Persisted as JSON in `runs.rootCauses`. The internal `_seenTestIds` Set
 * used for O(1) dedup is stripped before persist — this is the public shape.
 */
export interface RootCauseCluster {
  fingerprint: string;
  /** Deduplicated set of distinct test IDs in the cluster. */
  affectedTestIds: string[];
  sharedUrl: string | null;
  sharedSelector: string | null;
  errorPattern: string;
  /** Total failed-result rows (includes data-driven iterations). */
  size: number;
}

/**
 * Normalised shard config returned by `utils/shardConfig.js`
 * `normalizeShardConfig()`. `shardCount` and `parallelWorkers` are
 * intentionally independent — see that module's JSDoc for BUG-0001.
 */
export interface ShardConfig {
  shardCount: number;
  parallelWorkers: number;
  maxWorkers: number;
}

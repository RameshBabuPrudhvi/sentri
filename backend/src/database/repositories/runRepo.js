/**
 * @module database/repositories/runRepo
 * @description Run CRUD backed by SQLite.
 *
 * JSON columns: tests, results, testQueue, generateInput, promptAudit,
 * pipelineStats, feedbackLoop, videoSegments, qualityAnalytics,
 * changedPages, removedPages, changedFiles, impactAnalysis, githubCheck.
 *
 * Log lines are stored in the `run_logs` table (ENH-008) — not in a
 * `logs` JSON column.  {@link getById} hydrates `run.logs` from
 * `run_logs` automatically so callers see no API change.
 *
 * All read queries filter `WHERE deletedAt IS NULL` by default.
 * Hard deletes are replaced with soft-deletes: `deletedAt = datetime('now')`.
 * Use {@link getDeletedByProjectId} / {@link restore} for recycle-bin operations.
 *
 * ### Pagination
 * {@link getByProjectIdPaged} returns
 * `{ data: Run[], meta: { total, page, pageSize, hasMore } }`.
 */

import { getDatabase, getDatabaseDialect } from "../sqlite.js";
import { parsePagination } from "../../utils/pagination.js";
import * as runLogRepo from "./runLogRepo.js";
// Task 2 — per-agent SSE events. Hydrated alongside `logs` on `getById` so
// a reconnecting SSE client receives the full per-agent narrative replay
// on the initial snapshot, not just events that arrived post-connect.
import * as runAgentEventRepo from "./runAgentEventRepo.js";
import { filterShardRetrySurvivors, countShardRetrySurvivors } from "../../utils/shardRetryFilter.js";
import { runsTotal as metricsRunsTotal } from "../../utils/metrics.js"; // INF-007 — bump on every run-row creation.

export { parsePagination };

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────

// `logs` is intentionally excluded — log lines live in the `run_logs` table
// (ENH-008).  The `runs` table still has a `logs` column for backwards
// compatibility with existing databases, but all new writes bypass it.
const JSON_FIELDS = [
  "tests", "results", "testQueue", "generateInput",
  "promptAudit", "pipelineStats", "feedbackLoop", "videoSegments",
  "qualityAnalytics", "pages", "gateResult", "webVitalsResult",
  "changedPages", "removedPages", // AUTO-002: diff-aware crawl page-change summary
  "changedFiles", "impactAnalysis", // AUTO-004: git-diff impact analysis summary
  "githubCheck", // INT-002: GitHub Check Run metadata
  "tracePaths", // CAP-002 Phase 2: per-shard trace zip paths (migration 026)
  "rootCauses", // AUTO-010: deterministic root-cause clustering output (migration 027)
  "coverageSummary", // AUTO-009: aggregated per-run JS coverage summary (migration 038)
  "shardCoverageSummaries", // AUTO-009f: per-shard pre-aggregated coverage (migration 042) — sparse array indexed by shardIndex; merged into `coverageSummary` by the boundary-crossing finalizer.
  "changedFileRanges", // AUTO-009d: per-file head-side line ranges from the PR diff (migration 044)
  "prCoverageDiff", // AUTO-009d: PR-scoped coverage diff output from computePrCoverage (migration 044)
];

// Fields whose canonical empty shape is an array, not null. Keeping them as
// `[]` on legacy / pre-migration rows avoids null-guard boilerplate at every
// consumer (e.g. external API callers reading `run.rootCauses.length` should
// never blow up on a pre-AUTO-010 run). Hoisted to module scope so bulk
// reads (e.g. `getWithResultsByProjectIds` on the dashboard) don't allocate
// a fresh Set per row.
const ARRAY_DEFAULT_FIELDS = new Set(["tests", "results", "videoSegments", "pages", "rootCauses"]);

function rowToRun(row) {
  if (!row) return undefined;
  const obj = { ...row };
  for (const f of JSON_FIELDS) {
    if (obj[f]) {
      try { obj[f] = JSON.parse(obj[f]); }
      catch { obj[f] = ARRAY_DEFAULT_FIELDS.has(f) ? [] : null; }
    } else {
      obj[f] = ARRAY_DEFAULT_FIELDS.has(f) ? [] : null;
    }
  }
  // Always initialise logs as an empty array; callers that need the full
  // log history should call getById() which hydrates from run_logs.
  if (!Array.isArray(obj.logs)) obj.logs = [];
  return obj;
}

function runToRow(r) {
  const row = { ...r };
  for (const f of JSON_FIELDS) {
    if (row[f] != null && typeof row[f] === "object") {
      row[f] = JSON.stringify(row[f]);
    }
  }
  // Never serialise the in-memory logs array back to the runs table —
  // log lines are stored in run_logs exclusively.
  delete row.logs;
  // CAP-003: SQLite has no native boolean; better-sqlite3 rejects JS booleans.
  // The orchestrator sets `run.secretScanBlocked = true`; coerce to 0/1 here so
  // both create() and update()/save() paths persist it cleanly.
  if (typeof row.secretScanBlocked === "boolean") {
    row.secretScanBlocked = row.secretScanBlocked ? 1 : 0;
  }
  return row;
}

const INSERT_COLS = [
  "id", "projectId", "type", "status", "startedAt", "finishedAt",
  "duration", "error", "errorCategory", "passed", "failed", "total",
  "pagesFound", "parallelWorkers", "tracePath", "videoPath", "videoSegments",
  "tests", "results", "testQueue", "generateInput", "promptAudit",
  "pipelineStats", "feedbackLoop", "currentStep",
  "rateLimitError", "qualityAnalytics", "workspaceId", "pages",
  "browser", // DIF-002: chromium | firefox | webkit
  "retryCount", "failedAfterRetry", // AUTO-005: aggregated retry telemetry
  "networkCondition", // AUTO-006: fast | slow3g | offline (migration 012)
  "gateResult", // AUTO-012: quality gate pass/fail summary
  "webVitalsResult", // AUTO-017: web vitals budget pass/fail summary
  "secretScanBlocked", // CAP-003: set when post-generation secret scanner rejects any test (migration 015)
  "changedPages", "removedPages", // AUTO-002: diff-aware crawl page-change summary (migration 020)
  "changedFiles", "impactAnalysis", // AUTO-004: git-diff impact analysis summary (migration 022)
  "githubCheck", // INT-002: GitHub Check Run metadata (migration 021)
  "budgetMinutes", // AUTO-001: wall-clock budget applied to dispatch queue (migration 021)
  "environmentId", // DIF-012: optional project environment scope (migration 024)
  "shardCount", "shardsCompleted", // CAP-002: distributed shard telemetry (migration 025)
  "tracePaths", // CAP-002 Phase 2: per-shard trace zip paths (migration 026)
  "rootCauses", // AUTO-010: deterministic root-cause clustering output (migration 027)
  "coverageSummary", // AUTO-009: aggregated per-run JS coverage summary (migration 038)
  "shardCoverageSummaries", // AUTO-009f: per-shard pre-aggregated coverage (migration 042)
  "changedFileRanges", // AUTO-009d: PR diff hunk ranges (migration 044)
  "prCoverageDiff", // AUTO-009d: PR-scoped coverage diff (migration 044)
];

const INSERT_SQL = `INSERT INTO runs (${INSERT_COLS.join(", ")})
  VALUES (${INSERT_COLS.map(c => "@" + c).join(", ")})`;

// ─── Lean column sets (skip heavy JSON) ───────────────────────────────────────

const LEAN_COLS = [
  "id", "projectId", "type", "status", "startedAt", "finishedAt",
  "duration", "error", "errorCategory", "passed", "failed", "total",
  "pagesFound", "parallelWorkers", "currentStep", "rateLimitError",
  "browser", // DIF-002 — surfaces browser badge on runs list without a second query
  "networkCondition", // AUTO-006 — surfaces network-condition badge on runs list without a second query
  "gateResult", // AUTO-012 — surfaces gate badge on runs list without a second query
  "webVitalsResult", // AUTO-017 — surfaces vitals status without second query
  "environmentId", // DIF-012 — environment badge on runs list
  "shardCount", "shardsCompleted", // CAP-002 — shard progress on run list/detail
].join(", ");

const LEAN_WITH_FEEDBACK_COLS = `${LEAN_COLS}, feedbackLoop, pipelineStats`;

/**
 * Parse the lightweight JSON columns (feedbackLoop, pipelineStats) on a lean
 * row in-place.  Both are small objects — safe to include in listing queries.
 * @param {Object} row
 * @returns {Object} The same row with JSON columns deserialized.
 */
function parseLeanJson(row) {
  if (row.feedbackLoop) {
    try { row.feedbackLoop = JSON.parse(row.feedbackLoop); } catch { row.feedbackLoop = null; }
  } else {
    row.feedbackLoop = null;
  }
  if (row.pipelineStats) {
    try { row.pipelineStats = JSON.parse(row.pipelineStats); } catch { row.pipelineStats = null; }
  } else {
    row.pipelineStats = null;
  }
  // AUTO-012: gateResult is a small JSON object ({ passed, violations[] }) stored
  // in the lean column set so the Runs list / ProjectDetail Runs tab can render
  // <GateBadge> without a second query. Parse here when present.
  if ("gateResult" in row) {
    if (row.gateResult) {
      try { row.gateResult = JSON.parse(row.gateResult); } catch { row.gateResult = null; }
    } else {
      row.gateResult = null;
    }
  }
  if ("webVitalsResult" in row) {
    if (row.webVitalsResult) {
      try { row.webVitalsResult = JSON.parse(row.webVitalsResult); } catch { row.webVitalsResult = null; }
    } else {
      row.webVitalsResult = null;
    }
  }
  return row;
}

// ─── Read queries (non-deleted) ───────────────────────────────────────────────

/**
 * Get all non-deleted runs with results + feedbackLoop columns (for failure/analytics).
 * Prefer {@link getWithResultsByProjectIds} for workspace-scoped queries.
 * @returns {Object[]}
 */
export function getAllWithResults() {
  const db = getDatabase();
  return db.prepare(`SELECT ${LEAN_COLS}, results, feedbackLoop FROM runs WHERE deletedAt IS NULL`).all().map(parseResultsAndLean);
}

/**
 * Get non-deleted runs with results + feedbackLoop for a set of project IDs.
 * Workspace-scoped alternative to {@link getAllWithResults} — queries only the
 * rows belonging to the given projects instead of loading the entire table.
 *
 * @param {string[]} projectIds
 * @returns {Object[]}
 */
export function getWithResultsByProjectIds(projectIds) {
  if (!projectIds || projectIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT ${LEAN_COLS}, results, feedbackLoop FROM runs WHERE projectId IN (${placeholders}) AND deletedAt IS NULL`
  ).all(...projectIds).map(parseResultsAndLean);
}

/**
 * Parse results JSON + lean JSON columns on a row.
 * Shared by {@link getAllWithResults} and {@link getWithResultsByProjectIds}.
 * @param {Object} row
 * @returns {Object}
 */
function parseResultsAndLean(row) {
  if (row.results) {
    try { row.results = JSON.parse(row.results); } catch { row.results = []; }
  } else {
    row.results = [];
  }
  return parseLeanJson(row);
}

/**
 * Get non-deleted runs for a specific project, sorted by startedAt descending.
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM runs WHERE projectId = ? AND deletedAt IS NULL ORDER BY startedAt DESC"
  ).all(projectId).map(rowToRun);
}


/**
 * Find a non-deleted run that was launched from a specific GitHub webhook
 * delivery. Used to make duplicate PR webhooks idempotent (INT-002).
 *
 * GitHub stamps every webhook delivery with a unique UUID in the
 * `X-GitHub-Delivery` header and retries the same UUID with exponential
 * backoff for up to 24h on non-2xx responses. The delivery ID — not the
 * commit SHA — is the correct idempotency key:
 *
 *   - Two deliveries for the same SHA but different delivery IDs are
 *     **distinct events** (e.g. PR opened, then `check_suite.rerequested`
 *     after a user clicks "Re-run"). Each deserves a fresh Check Run.
 *   - Two deliveries for the *same* delivery ID are GitHub retrying the
 *     same event. We must produce the same `checkRunId` and not launch
 *     a duplicate run.
 *
 * The previous repo+SHA-based lookup conflated these two cases — a
 * legitimate `rerequested` event for the same commit would silently
 * reuse the prior check and overwrite its conclusion, which is
 * surprising behaviour for an industry-standard QA platform.
 *
 * Implementation note — cross-dialect lookup via `LIKE`:
 * The natural query here is `WHERE json_extract(githubCheck, '$.deliveryId') = ?`,
 * but `json_extract()` is SQLite-specific and the Postgres adapter
 * (`backend/src/database/adapters/postgres-adapter.js`) has no translation
 * rule for it — so the query would crash on every webhook retry on Postgres
 * deployments. We instead use a `LIKE` pre-filter against the serialized
 * JSON column (matching the established pattern in
 * `backend/src/database/repositories/activityRepo.js:206`, which also avoids
 * `json_extract` for the same reason) and verify the parsed `deliveryId`
 * field in JS. The pre-filter narrows long-lived PRs to a tiny candidate
 * set; the JS-side check is the source of truth and rejects accidental
 * substring matches in unrelated JSON fields.
 *
 * @param {string} projectId
 * @param {string} deliveryId — value of the `X-GitHub-Delivery` header.
 * @returns {Object|undefined}
 */
export function findByGithubDeliveryId(projectId, deliveryId) {
  if (!deliveryId) return undefined;
  const db = getDatabase();
  // The delivery ID is embedded as `"deliveryId":"<uuid>"` in the JSON-serialized
  // githubCheck column. We escape SQL LIKE wildcards in the user-supplied
  // delivery ID before interpolating into the pattern, so a malicious /
  // malformed UUID can't broaden the match.
  const safeDeliveryId = String(deliveryId).replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%"deliveryId":"${safeDeliveryId}"%`;
  const rows = db.prepare(
    `SELECT * FROM runs
     WHERE projectId = ? AND deletedAt IS NULL
       AND githubCheck IS NOT NULL
       AND githubCheck LIKE ? ESCAPE '\\'
     ORDER BY startedAt DESC LIMIT 10`
  ).all(projectId, pattern);
  for (const row of rows) {
    const run = rowToRun(row);
    if (run?.githubCheck?.deliveryId === deliveryId) return run;
  }
  return undefined;
}

/**
 * Lean accessor for the recorder's Start-URL dropdown
 * (`GET /api/v1/projects/:id/pages`). Returns only the URLs persisted on the
 * most recent crawl or recorder run that has a non-empty `pages` JSON array,
 * deduplicated and oldest-first within the run.
 *
 * Avoids the heavy `SELECT *` + per-row `rowToRun()` JSON parse fan-out of
 * {@link getByProjectId} — the dropdown is fetched on every recorder modal
 * open, so loading every run's `results` / `tests` / `promptAudit` /
 * `qualityAnalytics` blob just to read one column would scale poorly on
 * projects with long run history. We `LIMIT 1` to the most recent qualifying
 * run since the previous in-process implementation already only used the
 * latest match.
 *
 * @param {string} projectId
 * @returns {string[]} URLs from the latest crawl/record run, or `[]` when
 *   no run has discovered pages yet.
 */
export function getLatestDiscoveredPageUrls(projectId) {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT pages FROM runs
     WHERE projectId = ? AND deletedAt IS NULL
       AND type IN ('crawl', 'record')
       AND pages IS NOT NULL AND pages != '[]'
     ORDER BY startedAt DESC LIMIT 1`
  ).get(projectId);
  if (!row?.pages) return [];
  let parsed;
  try { parsed = JSON.parse(row.pages); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((p) => p?.url).filter((u) => typeof u === "string" && u);
}

/**
 * Count non-deleted runs for a set of project IDs.
 * @param {string[]} projectIds
 * @returns {number}
 */
export function countByProjectIds(projectIds) {
  if (!projectIds || projectIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT COUNT(*) as cnt FROM runs WHERE projectId IN (${placeholders}) AND deletedAt IS NULL`
  ).get(...projectIds).cnt;
}

/**
 * Get non-deleted runs for a project with lean columns, paginated.
 * @param {string}        projectId
 * @param {number|string} [page=1]
 * @param {number|string} [pageSize=DEFAULT_PAGE_SIZE]
 * @returns {{ data: Object[], meta: { total: number, page: number, pageSize: number, hasMore: boolean } }}
 */
export function getByProjectIdPaged(projectId, page, pageSize) {
  const db = getDatabase();
  const { page: p, pageSize: ps, offset } = parsePagination(page, pageSize);
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM runs WHERE projectId = ? AND deletedAt IS NULL"
  ).get(projectId).cnt;
  const data = db.prepare(
    `SELECT ${LEAN_WITH_FEEDBACK_COLS} FROM runs WHERE projectId = ? AND deletedAt IS NULL ORDER BY startedAt DESC LIMIT ? OFFSET ?`
  ).all(projectId, ps, offset).map(parseLeanJson);
  return { data, meta: { total, page: p, pageSize: ps, hasMore: offset + data.length < total } };
}

/**
 * Get a non-deleted run by ID.
 * Hydrates `run.logs` from the `run_logs` table (ENH-008).
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM runs WHERE id = ? AND deletedAt IS NULL").get(id);
  if (!row) return undefined;
  const run = rowToRun(row);
  // Hydrate logs from run_logs table (ENH-008).  Fall back to the legacy
  // runs.logs JSON column for runs created before migration 002 that still
  // have their log history stored inline.
  const newLogs = runLogRepo.getMessagesByRunId(id);
  if (newLogs.length > 0) {
    run.logs = newLogs;
  } else if (row.logs) {
    try { run.logs = JSON.parse(row.logs); } catch { /* keep [] from rowToRun */ }
  }
  // Task 2 — hydrate per-agent SSE event history. `data` lands as a JSON
  // string in the DB; parse here so SSE-snapshot consumers don't have to
  // care about the storage shape. Missing/malformed rows degrade to null,
  // matching the JSON_FIELDS pattern used above for rowToRun.
  run.agentEvents = runAgentEventRepo.getByRunId(id).map(parseAgentEventRow);
  return run;
}

/**
 * Parse the `data` JSON column on a single agent-event row. Hoisted to
 * module scope so both `getById` + `getByIdIncludeDeleted` share one
 * implementation and the SSE snapshot builder can call it directly.
 *
 * @param {Object} row
 * @returns {Object}
 */
function parseAgentEventRow(row) {
  if (row.data) {
    try { row.data = JSON.parse(row.data); }
    catch { row.data = null; }
  }
  return row;
}

/**
 * Get a run by ID including soft-deleted (for restore and abort operations).
 * Hydrates `run.logs` from the `run_logs` table (ENH-008).
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getByIdIncludeDeleted(id) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!row) return undefined;
  const run = rowToRun(row);
  // Same legacy fallback as getById — see comment above.
  const newLogs = runLogRepo.getMessagesByRunId(id);
  if (newLogs.length > 0) {
    run.logs = newLogs;
  } else if (row.logs) {
    try { run.logs = JSON.parse(row.logs); } catch { /* keep [] from rowToRun */ }
  }
  // Task 2 — mirror the agent-event hydration from getById so restore /
  // abort paths surface the same per-agent narrative replay.
  run.agentEvents = runAgentEventRepo.getByRunId(id).map(parseAgentEventRow);
  return run;
}

/**
 * Get recent completed test runs with only the columns needed for flaky score
 * computation.  Returns at most `limit` rows, sorted newest-first, with only
 * `id`, `type`, `status`, `startedAt`, and `results` — avoiding the heavy
 * JSON blobs (`testQueue`, `generateInput`, `promptAudit`, `qualityAnalytics`).
 *
 * @param {string} projectId
 * @param {number} [limit=20]
 * @returns {Object[]}
 */
export function getRecentCompletedWithResults(projectId, limit = 20) {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, type, status, startedAt, results FROM runs
     WHERE projectId = ? AND deletedAt IS NULL
       AND type IN ('test_run', 'run') AND status = 'completed'
       AND results IS NOT NULL AND results != '[]'
     ORDER BY startedAt DESC LIMIT ?`
  ).all(projectId, limit);
  return rows.map(row => {
    if (row.results) {
      try { row.results = JSON.parse(row.results); } catch { row.results = []; }
    } else {
      row.results = [];
    }
    return row;
  });
}

/**
 * AUTO-009 / AUTO-009k: Lean accessor for runs that carry a persisted
 * `coverageSummary` JSON blob. Used by the dashboard's 30-day coverage
 * trend (and the per-run granularity surface for AUTO-009c) so the trend
 * can read `coveragePct`, `branchPct`, `functionPct` without bloating
 * `LEAN_COLS` — `coverageSummary` is potentially multi-KB JSON and the
 * rest of the dashboard payload doesn't need it.
 *
 * Selects only the columns the trend consumer reads:
 *   - `id`, `projectId`, `startedAt`, `type` — windowing / grouping
 *   - `coverageSummary` — parsed below
 *
 * Workspace-scoped via the same `projectIds` set the dashboard already
 * resolves; never reads cross-workspace rows.
 *
 * **SQL-side bounds** (added per Lifeguard ANALYSIS-0011):
 *   - `windowDays` (default 60) applies a `startedAt >= cutoff` filter so
 *     long-lived projects don't load every historical coverage row —
 *     previously we read every non-deleted coverage row and the JS layer
 *     sliced to the last 30, paying full O(n) JSON.parse cost on each.
 *     60d is wider than the dashboard's 30d trend window so the same
 *     accessor can serve callers that need additional headroom (e.g.
 *     the regression detector at `testRunner.js:957` walks history newest-
 *     last looking for the most recent prior coverage run — bounded by
 *     60d still gives ~2 months of priors before the lookup returns null).
 *   - `limit` (default 200) caps the absolute row count at the SQL layer
 *     too, defending against a SUT that emits hundreds of coverage-
 *     enabled runs per day within the window. Bound is per-query, not
 *     per-project, but since the dashboard's per-project slice in
 *     `routes/dashboard.js#coverageTrend` then caps at 30 per project,
 *     the practical visible payload stays bounded.
 *
 * Filters `coverageSummary IS NOT NULL` at the SQL layer so projects that
 * never enabled capture never round-trip an empty column.
 *
 * @param {string[]} projectIds
 * @param {Object}   [opts]
 * @param {number}   [opts.windowDays=60] - SQL-side `startedAt >= now-N days` cutoff.
 *   Set to `0` to disable the time filter (use sparingly — only when a caller
 *   genuinely needs the full history).
 * @param {number}   [opts.limit=200]     - Absolute row-count cap at the SQL layer.
 * @returns {Object[]} Newest-last (chronological), `coverageSummary` parsed.
 */
export function getRunsWithCoverage(projectIds, { windowDays = 60, limit = 200 } = {}) {
  if (!projectIds || projectIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  const params = [...projectIds];
  let dateFilter = "";
  if (Number.isFinite(windowDays) && windowDays > 0) {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    dateFilter = " AND startedAt >= ?";
    params.push(cutoff);
  }
  // ORDER BY DESC + LIMIT is portable; reverse client-side to preserve
  // the documented "newest-last (chronological)" contract callers depend on
  // (dashboard's per-project bucketing relies on chronological-asc order so
  // `slice(-N)` keeps the most recent N points per project).
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  params.push(safeLimit);
  const rows = db.prepare(
    `SELECT id, projectId, startedAt, type, coverageSummary FROM runs
     WHERE projectId IN (${placeholders})
       AND deletedAt IS NULL
       AND coverageSummary IS NOT NULL
       AND type IN ('test_run', 'run')${dateFilter}
     ORDER BY startedAt DESC LIMIT ?`
  ).all(...params);
  // SELECT was DESC for LIMIT correctness; reverse to chronological asc here.
  rows.reverse();
  return rows.map((row) => {
    if (row.coverageSummary) {
      try { row.coverageSummary = JSON.parse(row.coverageSummary); }
      catch { row.coverageSummary = null; }
    } else {
      row.coverageSummary = null;
    }
    return row;
  });
}

/**
 * INT-002: Lean accessor for recent completed test runs that posted a GitHub
 * Check Run. Used by `concludeGithubCheck` to find a green base run for
 * regressed-test diff rendering without loading every project run's heavy
 * JSON columns (`testQueue`, `promptAudit`, `qualityAnalytics`, …).
 *
 * Selects only the columns `findGreenBaseRun` reads
 * (`backend/src/utils/runResultFormatters.js`):
 *   - `id`, `type`, `status`, `failed` — eligibility filtering
 *   - `githubCheck` — repo/sha match
 *   - `results` — green-test set for the diff
 *
 * The lookback is bounded by `limit` (default 25, matching
 * `BASE_LOOKBACK_RUNS` in the formatter) so a project with thousands of
 * historical runs doesn't trigger an O(n) deserialize on every check
 * completion.
 *
 * @param {string} projectId
 * @param {number} [limit=25]
 * @returns {Object[]} Newest-first, parsed `githubCheck` + `results`.
 */
export function getRecentTestRunsForGithubBase(projectId, limit = 25) {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, type, status, failed, githubCheck, results FROM runs
     WHERE projectId = ? AND deletedAt IS NULL
       AND type IN ('test_run', 'run') AND status = 'completed'
       AND githubCheck IS NOT NULL
     ORDER BY startedAt DESC LIMIT ?`
  ).all(projectId, limit);
  return rows.map((row) => {
    if (row.githubCheck) {
      try { row.githubCheck = JSON.parse(row.githubCheck); } catch { row.githubCheck = null; }
    }
    if (row.results) {
      try { row.results = JSON.parse(row.results); } catch { row.results = []; }
    } else {
      row.results = [];
    }
    return row;
  });
}

/**
 * AUTO-001: Lean accessor for the most recent crawl run that produced a
 * non-empty `changedPages[]` summary. Used by the risk-scoring path in
 * `routes/runs.js` and `routes/trigger.js` so a project with hundreds of
 * historical runs doesn't have to deserialize every row's heavy JSON columns
 * just to read the latest crawl's diff payload. Selects only `id`,
 * `startedAt`, `changedPages` and bounds the SQL with `LIMIT 1`.
 *
 * Returns the parsed `{ id, startedAt, changedPages }` shape or `null` when
 * no crawl has produced a non-empty changedPages array yet.
 *
 * @param {string} projectId
 * @returns {{ id: string, startedAt: string, changedPages: Array }|null}
 */
export function getLatestCrawlWithChangedPages(projectId) {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT id, startedAt, changedPages FROM runs
     WHERE projectId = ? AND deletedAt IS NULL
       AND type = 'crawl'
       AND changedPages IS NOT NULL AND changedPages != '[]'
     ORDER BY startedAt DESC LIMIT 1`
  ).get(projectId);
  if (!row?.changedPages) return null;
  let parsed;
  try { parsed = JSON.parse(row.changedPages); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return { id: row.id, startedAt: row.startedAt, changedPages: parsed };
}

// ─── Write operations ─────────────────────────────────────────────────────────

/**
 * Create a run.
 * Note: `run.logs` is intentionally not written to `runs.logs` — log lines
 * are persisted via {@link runLogRepo.appendLog} in runLogger.js (ENH-008).
 * @param {Object} run
 */
export function create(run) {
  const db = getDatabase();
  const row = runToRow(run);
  const params = {};
  for (const col of INSERT_COLS) {
    params[col] = row[col] !== undefined ? row[col] : null;
  }
  if (params.tests == null) params.tests = "[]";
  if (params.results == null) params.results = "[]";
  // AUTO-005: migration 011 declares these columns NOT NULL DEFAULT 0.
  // Coerce undefined/null to 0 so create() works for callers (e.g. crawl/
  // generate runs) that never set retry telemetry.
  if (params.retryCount == null) params.retryCount = 0;
  if (params.failedAfterRetry == null) params.failedAfterRetry = 0;
  // CAP-003: migration 015 declares secretScanBlocked NOT NULL DEFAULT 0.
  // Coerce undefined/null to 0 for runs without secret-scan findings
  // (runToRow already normalised any boolean value to 0/1).
  if (params.secretScanBlocked == null) params.secretScanBlocked = 0;
  db.prepare(INSERT_SQL).run(params);
  // INF-007: bump the Prometheus counter for every persisted run row, labelled
  // by run type so dashboards can split crawl vs. test_run vs. generate vs.
  // record volume. `run.type` is set by every route that builds a run record;
  // fall back to "unknown" as defence-in-depth so a future write path without
  // a type doesn't pollute the series with `undefined`. Wrapped in try/catch
  // so a metrics-registry hiccup never fails the actual run creation — the
  // counter is observability, not load-bearing.
  try { metricsRunsTotal.inc({ type: run?.type || "unknown" }); } catch { /* best-effort */ }
}

// Set of valid column names for filtering unknown properties in update().
const VALID_COLS = new Set(INSERT_COLS);

/**
 * Update specific fields on a run (full replacement of provided fields).
 * Unknown properties (not in the runs table) are silently skipped.
 * @param {string} id
 * @param {Object} fields
 */
export function update(id, fields) {
  const db = getDatabase();
  const row = runToRow(fields);
  const sets = [];
  const params = { id };
  for (const [key, val] of Object.entries(row)) {
    if (key === "id") continue;
    if (!VALID_COLS.has(key)) continue;
    sets.push(`${key} = @${key}`);
    params[key] = val;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * CAP-002 Phase 2 — Atomic append of one or more result objects to a run's
 * `results` JSON column in a single SQL statement.
 *
 * Why this exists: `save(run)` writes every column from an in-memory JS
 * snapshot, so N concurrent shard workers calling `save(run)` would silently
 * lose results to last-write-wins. This primitive performs a single-statement
 * `UPDATE` that splices new elements into the serialized JSON in place — no
 * read, no JS-side modify, no write-back. The SQL engine serializes
 * concurrent UPDATEs against the same row (better-sqlite3 journal lock on
 * SQLite, row-level lock on Postgres), so each statement is the
 * linearization point — verified by `backend/tests/run-storage-concurrency.test.js`.
 *
 * Cross-dialect strategy: rather than reach for SQLite's `json_patch()` or
 * Postgres' `jsonb_set` (which the adapter's `translateSql` does *not*
 * bridge — see `backend/src/database/adapters/postgres-adapter.js`), we
 * operate on the column as raw JSON TEXT. `substr` (1-indexed, length-based)
 * and `||` (string concat) are spelled identically in both dialects, so the
 * statement runs unmodified through the adapter's translation layer. The
 * column is only ever written by `JSON.stringify(...)` via `runToRow`, so
 * the canonical format produces a closing `]` as the final character — the
 * `rtrim(...)` calls below are defensive insurance against a future writer
 * (or direct DB migration) that pretty-prints or appends trailing
 * whitespace, which would otherwise corrupt the splice into malformed JSON.
 *
 * Strategy: build the new chunk client-side as `JSON.stringify(newResults)`
 * (always shaped `[...]`), then in SQL:
 *   - if `results` is NULL or `'[]'` → overwrite with the new chunk
 *   - otherwise → trim trailing whitespace, then
 *     `substr(rtrim(results), 1, length(rtrim(results)) - 1) || ',' || substr(newChunk, 2)`
 *     i.e. drop the existing trailing `]`, append `,`, then append the new
 *     chunk's interior `…]`.
 *
 * No-ops cleanly when `newResults` is empty or not an array.
 *
 * @param {string}   runId
 * @param {Object[]} newResults — Result objects to append. Each element must
 *   be JSON-serialisable (no functions, no cycles). Empty array → no-op.
 * @returns {number} Number of elements actually appended.
 */
export function appendRunResults(runId, newResults) {
  if (!Array.isArray(newResults) || newResults.length === 0) return 0;
  const db = getDatabase();
  const newChunk = JSON.stringify(newResults); // e.g. `[{...},{...}]`
  // CASE handles three states without a read-modify-write:
  //   1. NULL              → overwrite with newChunk
  //   2. '[]' (empty)      → overwrite with newChunk
  //   3. existing [...]    → splice: drop trailing `]`, append `,<interior>]`
  // The interior of newChunk is `substr(newChunk, 2)` — skips the leading `[`.
  // SQLite `length()` returns characters; Postgres `length()` on TEXT returns
  // characters too (vs `octet_length()` for bytes) so the indexes match.
  // `rtrim(...)` is portable across SQLite and Postgres (no adapter
  // translation required) and defends the splice against a column written
  // with trailing whitespace by any future writer / migration. When the
  // column is canonical (no trailing whitespace), rtrim is a no-op.
  db.prepare(
    `UPDATE runs SET results = CASE
       WHEN results IS NULL OR rtrim(results) = '[]' THEN ?
       ELSE substr(rtrim(results), 1, length(rtrim(results)) - 1) || ',' || substr(?, 2)
     END
     WHERE id = ?`
  ).run(newChunk, newChunk, runId);
  return newResults.length;
}

/**
 * CAP-002 Phase 2 — Atomic increment of `shardsCompleted`, capped at
 * `shardCount` so a buggy double-fire (e.g. coordinator + worker both
 * marking a shard done) can't push the counter past the total. Sibling of
 * {@link appendRunResults}; same row-lock-per-UPDATE concurrency contract.
 *
 * Cross-dialect: `CASE WHEN … THEN x + 1 ELSE x END` works identically on
 * SQLite and Postgres. Avoids `MIN()` (aggregate-only on Postgres) and
 * `LEAST()` (not in SQLite). `COALESCE` handles pre-migration rows where
 * `shardsCompleted` may be NULL.
 *
 * @param {string} runId
 * @returns {number} `1` if a row was updated, `0` otherwise (run not found
 *   or already at the cap).
 */
export function incrementShardsCompleted(runId) {
  const db = getDatabase();
  // Atomic increment + boundary detection in a single transaction so a
  // concurrent sibling shard on another Postgres process can never read
  // the same post-increment value and fire a duplicate finalizer.
  //
  // The transaction wraps UPDATE + SELECT so on SQLite (BEGIN IMMEDIATE
  // serialises writers) and Postgres (the UPDATE's row lock holds until
  // COMMIT) the returned `newValue` is the authoritative post-increment
  // counter — no interleaving window between the write and the read.
  //
  // Returns `{ advanced: 0|1, newValue: number }`.
  //   - `advanced === 0` → row not found OR already at cap (no-op).
  //   - `advanced === 1` → counter incremented; `newValue` is the new
  //     `shardsCompleted`. The caller checks `newValue === shardCount`
  //     to decide whether to finalize — no separate `getById` needed.
  let advanced = 0;
  let newValue = 0;
  db.transaction(() => {
    const info = db.prepare(
      `UPDATE runs
          SET shardsCompleted = COALESCE(shardsCompleted, 0) + 1
        WHERE id = ?
          AND COALESCE(shardsCompleted, 0) < COALESCE(shardCount, 1)`
    ).run(runId);
    advanced = info.changes || 0;
    if (advanced === 1) {
      const row = db.prepare(
        "SELECT shardsCompleted FROM runs WHERE id = ?"
      ).get(runId);
      newValue = row?.shardsCompleted ?? 0;
    }
  })();
  return { advanced, newValue };
}

/**
 * CAP-002 Phase 2 (Prerequisite #6) — Mark a run `failed` with first-writer-
 * wins semantics. When N shard jobs crash near-simultaneously, only the
 * first one to land its UPDATE actually writes the failure reason; the
 * predicate `WHERE id = ? AND status = 'running'` makes every subsequent
 * caller a no-op. Without this, a later shard's classified error would
 * overwrite the first (and arguably most-informative) failure message,
 * and the audit trail would lose track of which shard actually caused the
 * cascade.
 *
 * Sibling of {@link appendRunResults} / {@link incrementShardsCompleted}
 * — same single-statement-UPDATE concurrency contract (better-sqlite3
 * journal lock on SQLite, row-level lock on Postgres). `shardsCompleted`
 * is deliberately NOT touched here: a partial completion (`< shardCount`)
 * is the correct surface for the failure badge, and any successful shards
 * that landed before the crash have already bumped the counter via
 * {@link incrementShardsCompleted}.
 *
 * @param {string} runId
 * @param {Object} fields
 * @param {string} fields.error         - Classified error message.
 * @param {string} [fields.errorCategory] - Error category from `errorClassifier.js`.
 * @returns {boolean} `true` when this caller actually performed the update
 *   (i.e. it was the first writer); `false` when the row was already
 *   terminal (a sibling shard beat us to it, or the run was aborted).
 */
export function markRunFailedFirstWriterWins(runId, { error, errorCategory } = {}) {
  if (!runId) return false;
  const db = getDatabase();
  // Use a JS-side ISO 8601 timestamp (`new Date().toISOString()`) rather than
  // SQL `datetime('now')` so the `finishedAt` column format stays consistent
  // across dialects. On Postgres, the adapter translates `datetime('now')`
  // to `NOW()` which renders as `2025-01-15 10:30:00.123456+00` — a different
  // shape from the `2025-01-15T10:30:00.123Z` ISO 8601 string every other
  // code path uses. Mixing formats in one column breaks downstream
  // `new Date(finishedAt)` parsing on Postgres deployments.
  const now = new Date().toISOString();
  const info = db.prepare(
    `UPDATE runs
       SET status = 'failed',
           error = COALESCE(error, ?),
           errorCategory = COALESCE(errorCategory, ?),
           finishedAt = COALESCE(finishedAt, ?)
     WHERE id = ? AND status = 'running'`
  ).run(error || "Shard failed", errorCategory || "unknown", now, runId);
  return (info.changes || 0) > 0;
}

/**
 * CAP-002 Phase 2 — Mark a run `completed` with first-writer-wins semantics.
 * The sibling primitive of {@link markRunFailedFirstWriterWins}: the
 * `WHERE id = ? AND status = 'running'` predicate makes any caller
 * arriving after the run has already transitioned terminal (e.g. the
 * user clicked Abort between the finalizer's `getById` snapshot and its
 * status-transition UPDATE) a clean no-op. Without this, the late
 * finalizer would overwrite an `aborted` status with `completed`,
 * silently masking the user's cancellation.
 *
 * The race is real but tiny: shard N's `incrementShardsCompleted`
 * returns 1 → `getById` reads `status: "running"` → user aborts (route
 * writes `status: "aborted"`) → finalizer continues, calls
 * `finalizeRunIfNotAborted` which only looks at the in-memory `run`
 * object (not the live DB) and proceeds to write `status: "completed"`.
 * The atomic predicate here is the DB-side enforcement that catches the
 * mid-flight abort even when the in-memory snapshot is stale.
 *
 * Sibling-shard concurrency contract: same single-statement-UPDATE
 * row-lock guarantee as the rest of the CAP-002 primitives. Sets
 * `finishedAt` and `duration` atomically with the status flip so a
 * consumer reading the row never sees `status: "completed"` with a
 * `finishedAt: NULL` interim state.
 *
 * @param {string} runId
 * @param {Object} fields
 * @param {string} [fields.finishedAt]       - ISO timestamp; defaults to `datetime('now')` in SQL.
 * @param {number} [fields.duration]         - Wall-clock duration in ms.
 * @param {Object} [fields.qualityAnalytics] - Feedback-loop output (JSON-stringified before persist).
 * @returns {boolean} `true` when this caller actually performed the update
 *   (i.e. it was the first writer); `false` when the row was already
 *   terminal (an abort beat the finalizer, or a sibling already
 *   finalized — defence-in-depth even though `incrementShardsCompleted`
 *   guarantees exactly one finalizer).
 */
export function markRunCompletedFirstWriterWins(runId, { finishedAt, duration, qualityAnalytics } = {}) {
  if (!runId) return false;
  const db = getDatabase();
  const qa = qualityAnalytics && typeof qualityAnalytics === "object"
    ? JSON.stringify(qualityAnalytics)
    : null;
  // ISO 8601 fallback for `finishedAt` — see rationale in
  // `markRunFailedFirstWriterWins`. Most callers pass `finishedAt` explicitly,
  // so this only matters when the caller relied on the SQL default.
  const fallbackFinishedAt = finishedAt || new Date().toISOString();
  const info = db.prepare(
    `UPDATE runs
       SET status = 'completed',
           finishedAt = COALESCE(?, finishedAt, ?),
           duration = COALESCE(?, duration),
           qualityAnalytics = COALESCE(?, qualityAnalytics)
     WHERE id = ? AND status = 'running'`
  ).run(finishedAt || null, fallbackFinishedAt, duration ?? null, qa, runId);
  return (info.changes || 0) > 0;
}

/**
 * CAP-002 Phase 2 — Atomic accumulator for per-shard stats deltas. Composes
 * sibling-shard contributions onto the same parent `runs` row without the
 * read-modify-write race that `runRepo.save(run)` would lose under N
 * concurrent workers. Sibling of {@link appendRunResults} /
 * {@link incrementShardsCompleted}; same single-statement-UPDATE
 * concurrency contract (better-sqlite3 journal lock on SQLite, row-level
 * lock on Postgres).
 *
 * Cross-dialect: `COALESCE(x, 0) + ?` is spelled identically on SQLite and
 * Postgres — no adapter translation required. `total` is mutable because
 * data-driven tests expand N input rows into K iterations at execution
 * time; each shard's totalDelta = (executedIterations - originalSliceSize)
 * so the parent run's total reflects what actually dispatched rather than
 * what was originally queued.
 *
 * @param {string} runId
 * @param {Object} deltas
 * @param {number} [deltas.passedDelta=0]
 * @param {number} [deltas.failedDelta=0]
 * @param {number} [deltas.totalDelta=0]
 * @returns {number} `1` if a row was updated, `0` otherwise.
 */
export function incrementRunStats(runId, { passedDelta = 0, failedDelta = 0, totalDelta = 0 } = {}) {
  if (!runId) return 0;
  if (!passedDelta && !failedDelta && !totalDelta) return 0;
  const db = getDatabase();
  const info = db.prepare(
    `UPDATE runs
        SET passed = COALESCE(passed, 0) + ?,
            failed = COALESCE(failed, 0) + ?,
            total  = COALESCE(total,  0) + ?
      WHERE id = ?`
  ).run(passedDelta, failedDelta, totalDelta, runId);
  return info.changes || 0;
}

/**
 * CAP-002 Phase 2 — Atomically write a per-shard trace path into the
 * sparse `tracePaths` JSON array. Each shard writes its own slot exactly
 * once at trace-flush time, so contention is bounded to N writes total
 * per run (vs the O(tests) contention of result writes). The transaction
 * wrapper covers the read+write so a concurrent sibling shard's update
 * to a different slot can't be lost.
 *
 * Cross-dialect note: SQLite's `json_set` and Postgres' `jsonb_set` have
 * incompatible signatures and the postgres-adapter doesn't bridge either,
 * so we use a portable SELECT+UPDATE inside `db.transaction(...)`. SQLite
 * `transaction()` uses BEGIN IMMEDIATE which serializes against other
 * write transactions; Postgres uses row-level locks via the implicit
 * row lock on UPDATE within the transaction. Either way, two shards
 * writing different indices on the same row are linearized.
 *
 * @param {string} runId
 * @param {number} shardIndex - 0-based shard index.
 * @param {string} path       - Public artifact URL for this shard's trace.
 */
/**
 * AUTO-009f / AUTO-009k — Atomically write a per-shard pre-aggregated
 * coverage summary into the sparse `shardCoverageSummaries` JSON array.
 *
 * Each shard calls this at the runTests-tail (`testRunner.js`, shard mode)
 * with the output of `pipeline/finalizeCoverage.js#aggregateShardCoverage` —
 * a compact mergeable payload containing per-bundle covered-id arrays
 * (`Set<"s:id"|"b:id:arm"|"f:id">` projected to sorted strings), per-source
 * line-set arrays, server-side diffs, and the shard's per-test deltas.
 * The boundary-crossing finalizer (`runWorker.js#finalizeShardedRun`)
 * reads `runs.shardCoverageSummaries` and calls
 * `pipeline/finalizeCoverage.js#mergeShardSummaries` to take set union
 * across shards — matching the industry pattern (c8 / nyc / Istanbul
 * `libCoverage.createCoverageMap().merge()` / Codecov upload-then-merge).
 *
 * Naively summing per-shard count totals is wrong (proven counter-example:
 * shard 0 covers lines [1,2,3], shard 1 covers lines [3,4,5] → naive
 * 3+3=6 vs true union 5). The merge consumer's set-union semantics is what
 * makes this correct; see `coverage-shard-merge.test.js` for the proof.
 *
 * **Concurrency contract:** mirrors `setShardTracePath` — transaction-
 * wrapped read-modify-write with a dialect-conditional `FOR UPDATE` lock
 * on Postgres so two concurrent shards writing different array slots
 * cannot lose each other's writes. Best-effort by contract: a write
 * failure must be swallowed by the caller so coverage capture never
 * fails a run (the finalizer's AUTO-009f fallback path re-aggregates
 * from raw `runs.results` when this column is partial / null).
 *
 * @param {string} runId
 * @param {number} shardIndex - 0-based shard index.
 * @param {Object} summary    - This shard's `aggregateShardCoverage` output.
 */
export function setShardCoverageSummary(runId, shardIndex, summary) {
  if (!runId || shardIndex == null || !summary || typeof summary !== "object") return;
  const db = getDatabase();
  const lockClause = getDatabaseDialect() === "postgres" ? " FOR UPDATE" : "";
  db.transaction(() => {
    const row = db.prepare(`SELECT shardCoverageSummaries FROM runs WHERE id = ?${lockClause}`).get(runId);
    if (!row) return;
    let arr = [];
    if (row.shardCoverageSummaries) {
      try { arr = JSON.parse(row.shardCoverageSummaries) || []; } catch { arr = []; }
    }
    if (!Array.isArray(arr)) arr = [];
    arr[shardIndex] = summary;
    db.prepare("UPDATE runs SET shardCoverageSummaries = ? WHERE id = ?").run(JSON.stringify(arr), runId);
  })();
}

export function setShardTracePath(runId, shardIndex, path) {
  if (!runId || shardIndex == null || typeof path !== "string") return;
  const db = getDatabase();
  // Dialect-conditional row lock on the SELECT: SQLite's `transaction()` uses
  // BEGIN IMMEDIATE which already serialises write transactions, so a bare
  // SELECT is sufficient. Postgres defaults to READ COMMITTED — without
  // `FOR UPDATE`, two concurrent shards can both read the same stale row,
  // modify different array slots in JS, then the second UPDATE silently
  // overwrites the first (classic lost-update). `FOR UPDATE` takes a row
  // exclusive lock so the second SELECT blocks until the first transaction
  // commits, then sees the post-write value.
  const lockClause = getDatabaseDialect() === "postgres" ? " FOR UPDATE" : "";
  db.transaction(() => {
    const row = db.prepare(`SELECT tracePaths FROM runs WHERE id = ?${lockClause}`).get(runId);
    if (!row) return;
    let arr = [];
    if (row.tracePaths) {
      try { arr = JSON.parse(row.tracePaths) || []; } catch { arr = []; }
    }
    if (!Array.isArray(arr)) arr = [];
    arr[shardIndex] = path;
    db.prepare("UPDATE runs SET tracePaths = ? WHERE id = ?").run(JSON.stringify(arr), runId);
  })();
}

/**
 * CAP-002 Phase 2 — Atomic shard-scoped results purge for the BullMQ retry
 * path. Reads the live `results` column under a dialect-appropriate lock,
 * filters out rows belonging to `shardIndex` (keeping non-executed skips
 * and sibling-shard rows verbatim), and writes the filtered array back —
 * all inside a single transaction so concurrent sibling-shard
 * `appendRunResults` calls cannot lose writes through this path.
 *
 * Why this exists: the worker's non-final-attempt retry block previously
 * called `runRepo.save(run)` after filtering the in-memory results, which
 * was a full-column overwrite. Sibling shards atomically appending to the
 * same column between this shard's job-start snapshot and the save would
 * be silently truncated. This primitive replaces the read-modify-write on
 * a stale snapshot with a transactional read-modify-write on the live
 * column — guaranteed not to lose sibling-shard rows.
 *
 * Shape contract — survivors are kept when ANY of:
 *   - `isNonExecutedSkip(r)` returns true (over_budget / skipped_no_impact)
 *   - `r._shardIndex != null && r._shardIndex !== shardIndex` (sibling row)
 *
 * Returns the recomputed `{ passed, failed }` aggregate from survivors so
 * the caller can update its in-memory mirror and persist via the same
 * transactional write. Single-shard / legacy callers (`shardIndex == null`)
 * must NOT call this — they keep using `runRepo.save(run)` which is
 * bit-for-bit unchanged.
 *
 * @param {string}   runId
 * @param {number}   shardIndex     - 0-based shard index whose rows to purge.
 * @param {Function} isNonExecutedSkip - Predicate from `utils/skipReasons.js`
 *   passed in to avoid a runtime import cycle (this module is loaded very
 *   early; `skipReasons.js` is a tiny utility but importing it here would
 *   pull every result-processing helper through the dependency graph).
 * @returns {{ passed: number, failed: number }} re-derived from survivors.
 */
export function purgeShardResults(runId, shardIndex, isNonExecutedSkip) {
  if (!runId || shardIndex == null || typeof isNonExecutedSkip !== "function") {
    return { passed: 0, failed: 0 };
  }
  const db = getDatabase();
  const lockClause = getDatabaseDialect() === "postgres" ? " FOR UPDATE" : "";
  let survivors = [];
  db.transaction(() => {
    const row = db.prepare(`SELECT results FROM runs WHERE id = ?${lockClause}`).get(runId);
    if (!row) return;
    let arr = [];
    if (row.results) {
      try { arr = JSON.parse(row.results) || []; } catch { arr = []; }
    }
    if (!Array.isArray(arr)) arr = [];
    // Shared survivor filter — single source of truth, mirrored by
    // `runWorker.js`'s legacy single-shard catch block and the test fixture.
    survivors = filterShardRetrySurvivors(arr, shardIndex, isNonExecutedSkip);
    db.prepare("UPDATE runs SET results = ? WHERE id = ?").run(JSON.stringify(survivors), runId);
  })();
  return countShardRetrySurvivors(survivors);
}

/**
 * CAP-002 Phase 2 — Reset run-level transient fields for a BullMQ retry,
 * guarded by `status = 'running'` so a sibling shard that already
 * transitioned the row to a terminal state (`failed` via
 * {@link markRunFailedFirstWriterWins}, `aborted` via the abort route,
 * or `completed` via {@link markRunCompletedFirstWriterWins}) is not
 * silently un-terminalised by the retry path.
 *
 * Sibling of {@link markRunFailedFirstWriterWins} /
 * {@link markRunCompletedFirstWriterWins} — same single-statement-UPDATE
 * row-lock concurrency contract and same `WHERE status = 'running'`
 * predicate so a TOCTOU race between check-and-write is impossible.
 *
 * Returns the same boolean shape as the other first-writer-wins primitives
 * so callers can use it as a gate: when it returns `false`, the run is
 * already terminal and the caller MUST skip any further destructive
 * cleanup (e.g. `purgeShardResults`, `runLogRepo.deleteByRunId`) — those
 * would wipe rows belonging to a sibling shard's successful completion
 * or to the audit trail of a user-initiated abort.
 *
 * Note: `status = 'running'` is the *expected* current value (the retry
 * keeps the row running while a fresh attempt executes), so this is an
 * identity update on the status column. The other fields (`error`,
 * `errorCategory`, `finishedAt`, `pagesFound`) are reset so the retry
 * starts clean. `results` is NOT touched here — shard-mode callers handle
 * that via {@link purgeShardResults} after this primitive returns `true`.
 *
 * @param {string} runId
 * @returns {boolean} `true` when the row was still running and was reset;
 *   `false` when the row had already transitioned terminal (caller must
 *   abort the retry-prep sequence — see `runWorker.js` non-final-attempt
 *   block for the canonical use site).
 */
export function resetRunForRetryIfStillRunning(runId) {
  if (!runId) return false;
  const db = getDatabase();
  const info = db.prepare(
    `UPDATE runs
       SET status = 'running',
           error = NULL,
           errorCategory = NULL,
           finishedAt = NULL,
           pagesFound = 0
     WHERE id = ? AND status = 'running'`
  ).run(runId);
  return (info.changes || 0) > 0;
}

/**
 * Save the entire run object (upsert-style update of all known columns).
 * Used by pipeline code that mutates the run in-memory and then flushes.
 *
 * Pipeline code accumulates non-column properties on the run object
 * (e.g. snapshots, pages, testsGenerated). These are filtered out so
 * the generated SQL only references actual table columns.
 *
 * @param {Object} run — Full run object with `id`.
 */
export function save(run) {
  const fields = {};
  for (const col of INSERT_COLS) {
    if (col !== "id" && col in run) fields[col] = run[col];
  }
  if (Object.keys(fields).length === 0) return;
  update(run.id, fields);
}

/**
 * Find an active (non-deleted, non-finished) run for a project.
 * @param {string}   projectId
 * @param {string[]} [types] — Run types to check (default: crawl, test_run, generate).
 * @returns {Object|undefined}
 */
export function findActiveByProjectId(projectId, types) {
  const db = getDatabase();
  const typeList = types || ["crawl", "test_run", "generate"];
  const placeholders = typeList.map(() => "?").join(", ");
  return rowToRun(
    db.prepare(
      `SELECT * FROM runs WHERE projectId = ? AND status = 'running' AND type IN (${placeholders}) AND deletedAt IS NULL LIMIT 1`
    ).get(projectId, ...typeList)
  );
}

/**
 * Soft-delete all runs for a project.
 * @param {string} projectId
 * @returns {string[]} IDs of newly soft-deleted runs.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare(
    "SELECT id FROM runs WHERE projectId = ? AND deletedAt IS NULL"
  ).all(projectId).map(r => r.id);
  if (ids.length > 0) {
    db.prepare(
      "UPDATE runs SET deletedAt = datetime('now') WHERE projectId = ? AND deletedAt IS NULL"
    ).run(projectId);
  }
  return ids;
}

/**
 * Hard-delete all runs for a project (permanent — for project purge).
 * Also purges all associated log rows from `run_logs`.
 * @param {string} projectId
 * @returns {string[]} IDs of all deleted runs.
 */
export function hardDeleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare("SELECT id FROM runs WHERE projectId = ?").all(projectId).map(r => r.id);
  if (ids.length > 0) {
    runLogRepo.deleteByRunIds(ids);
    // Task 2 — cascade into run_agent_events on project-level purge
    // (mirrors the run_logs batch cascade so storage stays consistent).
    runAgentEventRepo.deleteByRunIds(ids);
    db.prepare("DELETE FROM runs WHERE projectId = ?").run(projectId);
  }
  return ids;
}

/**
 * Find the most recent non-deleted run result for a specific test ID.
 *
 * Uses a LIKE pre-filter on the JSON results column to narrow down candidate
 * rows, then parses and searches in JS. Only selects id, startedAt, results
 * to avoid deserializing heavy columns.
 *
 * @param {string} testId — e.g. "TC-1"
 * @returns {Object|null} The matching result object with `runId`, or null.
 */
export function findLatestResultForTest(testId) {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, startedAt, results FROM runs
     WHERE results LIKE ? AND results != '[]' AND deletedAt IS NULL
     ORDER BY startedAt DESC LIMIT 20`
  ).all(`%${testId}%`);

  for (const row of rows) {
    try {
      const results = JSON.parse(row.results);
      const match = results.find(r => r.testId === testId);
      if (match) return { ...match, runId: row.id };
    } catch { /* skip malformed JSON */ }
  }
  return null;
}

/**
 * Mark all "running" non-deleted runs as "interrupted" (orphan recovery on startup).
 * @returns {number} Number of runs marked.
 */
export function markOrphansInterrupted() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const info = db.prepare(
    `UPDATE runs SET status = 'interrupted', finishedAt = COALESCE(finishedAt, ?),
     error = 'Server restarted while run was in progress'
     WHERE status = 'running' AND deletedAt IS NULL`
  ).run(now);
  return info.changes;
}

// ─── Recycle bin ─────────────────────────────────────────────────────────────

/**
 * Get soft-deleted runs for a project.
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getDeletedByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    `SELECT ${LEAN_WITH_FEEDBACK_COLS}, deletedAt FROM runs WHERE projectId = ? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC`
  ).all(projectId).map(parseLeanJson);
}

/**
 * Get all soft-deleted runs.
 * @returns {Object[]}
 */
export function getDeletedAll() {
  const db = getDatabase();
  return db.prepare(
    `SELECT ${LEAN_WITH_FEEDBACK_COLS}, deletedAt FROM runs WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC`
  ).all().map(parseLeanJson);
}

/**
 * Hard-delete a run by ID (permanent — use only for purge operations).
 * Also purges all associated log rows from `run_logs`.
 * @param {string} id
 */
export function hardDeleteById(id) {
  const db = getDatabase();
  runLogRepo.deleteByRunId(id);
  // Task 2 — cascade into run_agent_events so a purge removes the per-agent
  // narrative replay alongside the run + log rows.
  runAgentEventRepo.deleteByRunId(id);
  db.prepare("DELETE FROM runs WHERE id = ?").run(id);
}

/**
 * Restore a soft-deleted run (clears deletedAt).
 * @param {string} id
 * @returns {boolean} Whether the run was found and restored.
 */
export function restore(id) {
  const db = getDatabase();
  const info = db.prepare("UPDATE runs SET deletedAt = NULL WHERE id = ? AND deletedAt IS NOT NULL").run(id);
  return info.changes > 0;
}

/**
 * Restore soft-deleted runs for a project that were deleted at or after a
 * given timestamp. Used by project cascade-restore to avoid restoring items
 * that were individually deleted before the project.
 * @param {string} projectId
 * @param {string} deletedAfter — ISO timestamp (inclusive lower bound).
 * @returns {number} Number of runs restored.
 */
/**
 * AUTO-009j — Retention sweep: null out every coverage-related JSON column
 * on runs older than `days` days. Preserves the lightweight `coveragePct`
 * in the dashboard trend via `getRunsWithCoverage` (which reads the column
 * before this sweep clears it — the trend query's `IS NOT NULL` filter
 * means cleared rows drop out of the trend naturally on the next dashboard
 * load).
 *
 * ### Columns cleared
 *
 * - `coverageSummary` (migration 038) — the public aggregate (multi-KB JSON
 *   carrying `perTest[]` + `topUncoveredFiles[]`).
 * - `prCoverageDiff` (migration 044) — PR-scoped coverage diff
 *   (`uncoveredChangedLines[]` capped at 200, but still per-file rows).
 * - `shardCoverageSummaries` (migration 042) — per-shard mergeable
 *   pre-aggregated payloads (per-bundle covered-id arrays, per-source line
 *   arrays, server diffs). Tens-of-MB on large-bundle SUTs × N shards;
 *   ONLY read by `finalizeShardedRun` so safe to purge once the run is
 *   terminal. Previously left behind → storage-leak bug surfaced by
 *   Lifeguard ANALYSIS-0001 (`backend/src/database/repositories/runRepo.js:1293`).
 * - `changedFileRanges` (migration 044) — PR diff hunk ranges. ONLY read
 *   by `finalizeCoverage` during the post-run tail; never read again
 *   after the run completes. Same storage-leak rationale.
 *
 * The `WHERE coverageSummary IS NOT NULL` predicate keeps the sweep
 * indexable on the most common column (coverage-enabled runs always have
 * a non-null summary if AUTO-009f / AUTO-009k landed); we also clear
 * `shardCoverageSummaries` / `changedFileRanges` on the same row whether
 * or not THEY are non-null, which is cheap (idempotent UPDATE to NULL).
 *
 * Returns the number of rows cleared. Best-effort — a failure must never
 * block the scheduler.
 *
 * @param {number} days
 * @returns {number}
 */
export function purgeCoverageSummaryOlderThan(days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const info = db.prepare(
    `UPDATE runs
        SET coverageSummary = NULL,
            prCoverageDiff = NULL,
            shardCoverageSummaries = NULL,
            changedFileRanges = NULL
      WHERE coverageSummary IS NOT NULL
        AND startedAt < ?
        AND deletedAt IS NULL`
  ).run(cutoff);
  return info.changes || 0;
}

export function restoreByProjectIdAfter(projectId, deletedAfter) {
  const db = getDatabase();
  const info = db.prepare(
    "UPDATE runs SET deletedAt = NULL WHERE projectId = ? AND deletedAt IS NOT NULL AND deletedAt >= ?"
  ).run(projectId, deletedAfter);
  return info.changes;
}

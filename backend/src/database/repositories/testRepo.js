/**
 * @module database/repositories/testRepo
 * @description Test CRUD backed by SQLite.
 *
 * JSON columns: steps, tags (arrays stored as JSON strings).
 * Boolean columns: isJourneyTest, assertionEnhanced, isApiTest (stored as 0/1).
 *
 * All read queries filter `WHERE deletedAt IS NULL` by default.
 * Hard deletes are replaced with soft-deletes: `deletedAt = datetime('now')`.
 * Use {@link getDeletedByProjectId} / {@link restore} for recycle-bin operations.
 *
 * ### Pagination
 * {@link getByProjectIdPaged} and {@link getAllPagedByProjectIds} return
 * `{ data: Test[], meta: { total, page, pageSize, hasMore } }`.
 */

import { getDatabase } from "../sqlite.js";
import { parsePagination } from "../../utils/pagination.js";

export { parsePagination };

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────

const JSON_FIELDS = ["steps", "tags", "qualityScoreFactors"];
const BOOL_FIELDS = ["isJourneyTest", "assertionEnhanced", "isApiTest", "isStale"];

function rowToTest(row) {
  if (!row) return undefined;
  const obj = { ...row };
  for (const f of JSON_FIELDS) {
    obj[f] = obj[f] ? JSON.parse(obj[f]) : (f === "steps" || f === "tags" || f === "qualityScoreFactors" ? [] : null);
  }
  for (const f of BOOL_FIELDS) {
    obj[f] = obj[f] === 1 ? true : obj[f] === 0 ? false : obj[f];
  }
  return obj;
}

function testToRow(t, { fillDefaults = false } = {}) {
  const row = { ...t };
  for (const f of JSON_FIELDS) {
    if (Array.isArray(row[f])) row[f] = JSON.stringify(row[f]);
    else if (f in row && row[f] == null) row[f] = fillDefaults ? "[]" : row[f];
    else if (!(f in row) && fillDefaults) row[f] = "[]";
  }
  for (const f of BOOL_FIELDS) {
    if (typeof row[f] === "boolean") row[f] = row[f] ? 1 : 0;
    else if (f in row && row[f] == null) row[f] = null;
  }
  return row;
}

// All columns in insertion order for the INSERT statement
const INSERT_COLS = [
  "id", "projectId", "name", "description", "steps", "playwrightCode",
  "playwrightCodePrev", "priority", "type", "sourceUrl", "pageTitle",
  "createdAt", "updatedAt", "lastResult", "lastRunAt", "qualityScore", "qualityScoreFactors",
  "isJourneyTest", "journeyType", "assertionEnhanced", "reviewStatus",
  "reviewedAt", "promptVersion", "modelUsed", "linkedIssueKey", "tags",
  "generatedFrom", "isApiTest", "scenario", "codeRegeneratedAt",
  "aiFixAppliedAt", "codeVersion", "workspaceId", "isStale", "flakyScore",
  "confidenceScore", "approvalSource", "approvalThreshold", "approvedAt", "approvedBy",
  "reviewComment", // migration 054 — free-text "why is this draft?" explainer
];

const INSERT_SQL = `INSERT INTO tests (${INSERT_COLS.join(", ")})
  VALUES (${INSERT_COLS.map(c => "@" + c).join(", ")})`;

// ─── Tag filter helpers ──────────────────────────────────────────────────────

/**
 * Build a `tags LIKE` pattern for a single tag value, escaping the SQL LIKE
 * metacharacters (`%`, `_`) and the escape char itself (`\`) so user-supplied
 * tags like `"50%_off"` don't match unrelated rows. The returned pattern MUST
 * be used with a `LIKE ? ESCAPE '\\'` clause — see {@link TAG_LIKE_ESCAPE}.
 *
 * Tags are persisted as a JSON-encoded array, so the pattern wraps the value
 * in `"…"` quotes to anchor on the JSON-string boundary; embedded `"` chars
 * in the tag value are escaped with `\"` to match `JSON.stringify` output.
 *
 * @param {string} tag
 * @returns {string} LIKE pattern
 */
function buildTagLikePattern(tag) {
  // Two-stage encoding:
  //   1. Mirror what `JSON.stringify` does to the tag value when it's
  //      persisted into the `tags` TEXT column — `"` and `\` get
  //      backslash-escaped, so a tag value `needs "review"` is stored
  //      on disk as the bytes `needs \"review\"`.
  //   2. Then escape SQL LIKE metacharacters (`%`, `_`) and the LIKE
  //      escape char itself (`\`) so user-supplied tags like `"50%_off"`
  //      don't match unrelated rows. The output MUST be used with a
  //      `LIKE ? ESCAPE '\\'` clause — see {@link TAG_LIKE_ESCAPE}.
  //
  // Order matters: stage 1 must run BEFORE stage 2's `\` escape, so the
  // backslashes introduced by JSON-encoding get themselves escaped for
  // the LIKE engine. Otherwise a JSON-stored `\"` in the row would only
  // match a pattern of `\"` in the SQL, but ESCAPE='\\' would consume
  // that backslash and leave just `"`, missing the row entirely.
  const jsonEncoded = String(tag)
    .replace(/\\/g, "\\\\")
    .replace(/"/g,  '\\"');
  const likeEscaped = jsonEncoded
    .replace(/\\/g, "\\\\")
    .replace(/%/g,  "\\%")
    .replace(/_/g,  "\\_");
  return `%"${likeEscaped}"%`;
}

/** SQL fragment appended to every `tags LIKE ?` clause to honour the
 *  backslash escapes produced by {@link buildTagLikePattern}. SQLite has no
 *  default LIKE escape, so this is required for the metacharacter escapes
 *  to take effect; PostgreSQL accepts the same syntax. */
const TAG_LIKE_ESCAPE = " ESCAPE '\\'";

// ─── Read queries ─────────────────────────────────────────────────────────────

/**
 * Get all non-deleted tests.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM tests WHERE deletedAt IS NULL").all().map(rowToTest);
}

/**
 * Get all non-deleted tests belonging to the given project IDs.
 * Used by the workspace-scoped GET /api/tests endpoint (ACL-001).
 * @param {string[]} projectIds
 * @returns {Object[]}
 */
export function getAllByProjectIds(projectIds) {
  if (!projectIds || projectIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT * FROM tests WHERE projectId IN (${placeholders}) AND deletedAt IS NULL`
  ).all(...projectIds).map(rowToTest);
}

/**
 * Get all test IDs (including soft-deleted) for the given project IDs.
 * Used by data-management cleanup endpoints that need to clear derived data
 * (e.g. healing history) for ALL tests, not just live ones.
 * @param {string[]} projectIds
 * @returns {string[]}
 */
export function getAllIdsByProjectIdsIncludeDeleted(projectIds) {
  if (!projectIds || projectIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT id FROM tests WHERE projectId IN (${placeholders})`
  ).all(...projectIds).map((r) => r.id);
}

/**
 * Count non-deleted tests for a set of project IDs.
 * @param {string[]} projectIds
 * @returns {number}
 */
export function countByProjectIds(projectIds) {
  if (!projectIds || projectIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT COUNT(*) as cnt FROM tests WHERE projectId IN (${placeholders}) AND deletedAt IS NULL`
  ).get(...projectIds).cnt;
}

/**
 * Count tests by review status for a set of project IDs.
 * @param {string[]} projectIds
 * @param {"approved"|"draft"} reviewStatus
 * @returns {number}
 */
function countByProjectIdsAndStatus(projectIds, reviewStatus) {
  if (!projectIds || projectIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT COUNT(*) as cnt FROM tests WHERE projectId IN (${placeholders}) AND deletedAt IS NULL AND reviewStatus = ?`
  ).get(...projectIds, reviewStatus).cnt;
}

/**
 * Count approved tests for a set of project IDs.
 * @param {string[]} projectIds
 * @returns {number}
 */
export function countApprovedByProjectIds(projectIds) {
  return countByProjectIdsAndStatus(projectIds, "approved");
}

/**
 * Count draft tests for a set of project IDs.
 * @param {string[]} projectIds
 * @returns {number}
 */
export function countDraftByProjectIds(projectIds) {
  return countByProjectIdsAndStatus(projectIds, "draft");
}

/**
 * Per-status test counts across a set of project IDs, with the same filter
 * shape as {@link getAllPagedByProjectIds}. Powers the Review Queue's tab
 * badges in a single COUNT-aggregated query — replaces the previous trio
 * of `pageSize: 1` paginated probes (one per tab) which produced three
 * concurrent round-trips on every filter / page change.
 *
 * The aggregate uses `SUM(CASE WHEN ...)` so the `WHERE` filters apply to
 * every status uniformly — switching the project filter or the search
 * input updates all three counts in lock-step.
 *
 * @param {string[]} projectIds
 * @param {Object}   [filters]   - Same shape as `getAllPagedByProjectIds`'s
 *                                 `filters` arg, minus `reviewStatus` (which
 *                                 is partitioned in the SUM, not filtered).
 * @returns {{ draft: number, approved: number, rejected: number, total: number }}
 */
export function countReviewQueueByProjectIds(projectIds, filters = {}) {
  if (!projectIds || projectIds.length === 0) {
    return { draft: 0, approved: 0, rejected: 0, total: 0 };
  }

  // Mirror the ACL-scoped projectId narrowing from getAllPagedByProjectIds —
  // a `projectId` outside the workspace set is silently ignored, never
  // widens scope.
  let scopedIds = projectIds;
  if (filters.projectId && projectIds.includes(filters.projectId)) {
    scopedIds = [filters.projectId];
  }

  const db = getDatabase();
  const placeholders = scopedIds.map(() => "?").join(", ");
  const conditions = [`projectId IN (${placeholders})`, "deletedAt IS NULL"];
  const params = [...scopedIds];

  if (filters.category === "api") {
    conditions.push("generatedFrom IN ('api_har_capture', 'api_user_described')");
  } else if (filters.category === "ui") {
    conditions.push("(generatedFrom IS NULL OR generatedFrom NOT IN ('api_har_capture', 'api_user_described'))");
  } else if (filters.category === "journey") {
    conditions.push("isJourneyTest = 1");
  }
  if (filters.stale) {
    conditions.push("isStale = 1");
  }
  if (filters.search) {
    conditions.push("(name LIKE ? OR sourceUrl LIKE ?)");
    const like = `%${filters.search}%`;
    params.push(like, like);
  }
  // Tag filter — kept in lock-step with getAllPagedByProjectIds so the tab
  // counts reflect the same row set the paginated list shows.
  if (Array.isArray(filters.tags) && filters.tags.length > 0) {
    const tagClauses = filters.tags.map(() => `tags LIKE ?${TAG_LIKE_ESCAPE}`).join(" OR ");
    conditions.push(`(${tagClauses})`);
    for (const tag of filters.tags) {
      params.push(buildTagLikePattern(tag));
    }
  }

  const where = conditions.join(" AND ");
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN reviewStatus = 'draft'    THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN reviewStatus = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN reviewStatus = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      COUNT(*)                                                   AS total
    FROM tests
    WHERE ${where}
  `).get(...params);

  return {
    draft:    row?.draft    || 0,
    approved: row?.approved || 0,
    rejected: row?.rejected || 0,
    total:    row?.total    || 0,
  };
}

/**
 * Get all non-deleted tests belonging to the given project IDs with pagination.
 * Used by the workspace-scoped GET /api/tests endpoint (ACL-001).
 * @param {string[]} projectIds
 * @param {number|string} [page=1]
 * @param {number|string} [pageSize=DEFAULT_PAGE_SIZE]
 * @returns {PagedResult}
 */
/**
 * Cross-project paginated list with optional filters.
 *
 * Mirrors `getByProjectIdPaged`'s filter shape so the cross-project Review
 * Queue can server-paginate without forcing the client to fetch every test
 * in the workspace and filter in memory.
 *
 * @param {string[]} projectIds  - Workspace-scoped project IDs (ACL gate).
 * @param {number}   page
 * @param {number}   pageSize
 * @param {Object}   [filters]
 * @param {string}   [filters.reviewStatus]  - "draft" | "approved" | "rejected"
 * @param {string}   [filters.category]      - "api" | "ui" | "journey"
 *                                             ("journey" matches `isJourneyTest = 1`,
 *                                             orthogonal to api/ui — same column
 *                                             contract as `getByProjectIdPaged`.)
 * @param {string}   [filters.search]        - LIKE match against name + sourceUrl
 * @param {boolean}  [filters.stale]
 * @param {string}   [filters.projectId]     - Narrow to a single project; ignored
 *                                             if the project isn't in `projectIds`.
 * @param {string}   [filters.sortBy]        - "newest" (default) | "oldest" |
 *                                             "quality" | "name". Applied
 *                                             server-side BEFORE the LIMIT/OFFSET
 *                                             so a global sort can span pages —
 *                                             a client-side sort over the
 *                                             current page would only reorder
 *                                             the rows already in hand.
 */
export function getAllPagedByProjectIds(projectIds, page, pageSize, filters = {}) {
  if (!projectIds || projectIds.length === 0) {
    const { page: p, pageSize: ps } = parsePagination(page, pageSize);
    return { data: [], meta: { total: 0, page: p, pageSize: ps, hasMore: false } };
  }

  // Honour the optional `projectId` filter — but only if it falls inside the
  // ACL-scoped set. Never let the param widen scope beyond `projectIds`.
  let scopedIds = projectIds;
  if (filters.projectId && projectIds.includes(filters.projectId)) {
    scopedIds = [filters.projectId];
  }

  const db = getDatabase();
  const { page: p, pageSize: ps, offset } = parsePagination(page, pageSize);
  const placeholders = scopedIds.map(() => "?").join(", ");

  const conditions = [`projectId IN (${placeholders})`, "deletedAt IS NULL"];
  const params = [...scopedIds];

  if (filters.reviewStatus) {
    conditions.push("reviewStatus = ?");
    params.push(filters.reviewStatus);
  }
  if (filters.category === "api") {
    conditions.push("generatedFrom IN ('api_har_capture', 'api_user_described')");
  } else if (filters.category === "ui") {
    conditions.push("(generatedFrom IS NULL OR generatedFrom NOT IN ('api_har_capture', 'api_user_described'))");
  } else if (filters.category === "journey") {
    // Journeys are an orthogonal axis to api/ui (a journey is always a UI test
    // today, but the column is reserved for future cross-cutting types).
    // Backed by the `isJourneyTest` boolean column — `1` after testToRow's
    // boolean→int coercion, so the comparison stays a literal `= 1`.
    conditions.push("isJourneyTest = 1");
  }
  if (filters.stale) {
    conditions.push("isStale = 1");
  }
  if (filters.search) {
    conditions.push("(name LIKE ? OR sourceUrl LIKE ?)");
    const like = `%${filters.search}%`;
    params.push(like, like);
  }
  // Tag filter — OR semantics across the supplied list (industry standard for
  // tag pickers: "show tests matching ANY of these tags"). Tags are stored as
  // a JSON-encoded array string on the row, so a `tags LIKE '%"tag"%'` probe
  // matches the canonical JSON.stringify output portably across SQLite and
  // PostgreSQL adapters — no dialect-specific JSON functions required.
  if (Array.isArray(filters.tags) && filters.tags.length > 0) {
    const tagClauses = filters.tags.map(() => `tags LIKE ?${TAG_LIKE_ESCAPE}`).join(" OR ");
    conditions.push(`(${tagClauses})`);
    for (const tag of filters.tags) {
      params.push(buildTagLikePattern(tag));
    }
  }

  const where = conditions.join(" AND ");
  // Resolve sortBy to a fixed ORDER BY clause. The mapping is hardcoded
  // (no string interpolation of caller input) so this can never be a SQL
  // injection vector even though SQLite doesn't bind ORDER BY values.
  // `qualityScore IS NULL` ordering puts un-scored tests last when sorting
  // by quality desc — without it NULLs would float to the top in SQLite.
  // Guard against inherited prototype keys (`__proto__`, `constructor`,
  // `toString`, …) — a plain `SORT_BY_CLAUSES[key] || …` lookup would return
  // truthy values from `Object.prototype` for those keys and bypass the
  // fallback, producing invalid SQL like `ORDER BY [object Object]`.
  // `Object.hasOwn` keeps the whitelist limited to declared own keys.
  const orderBy = Object.hasOwn(SORT_BY_CLAUSES, filters.sortBy)
    ? SORT_BY_CLAUSES[filters.sortBy]
    : SORT_BY_CLAUSES.newest;
  const total = db.prepare(
    `SELECT COUNT(*) as cnt FROM tests WHERE ${where}`
  ).get(...params).cnt;
  const data = db.prepare(
    `SELECT * FROM tests WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params, ps, offset).map(rowToTest);
  return { data, meta: { total, page: p, pageSize: ps, hasMore: offset + data.length < total } };
}

// Whitelist of allowed ORDER BY clauses. Keys are the public `sortBy` values
// the API exposes; values are the literal SQL fragment substituted into the
// query. Adding a new sort = add an entry here. Never interpolate caller
// input directly — even without bind support for ORDER BY this stays safe.
const SORT_BY_CLAUSES = {
  newest:  "createdAt DESC",
  oldest:  "createdAt ASC",
  quality: "qualityScore IS NULL, qualityScore DESC, createdAt DESC",
  name:    "LOWER(name) ASC, createdAt DESC",
};

/**
 * Get non-deleted tests for a specific project.
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM tests WHERE projectId = ? AND deletedAt IS NULL").all(projectId).map(rowToTest);
}

/**
 * Get non-deleted tests for a project with pagination and optional filters.
 * @param {string}        projectId
 * @param {number|string} [page=1]
 * @param {number|string} [pageSize=DEFAULT_PAGE_SIZE]
 * @param {Object}        [filters]
 * @param {string}        [filters.reviewStatus] — "draft", "approved", "rejected", or undefined for all.
 * @param {string}        [filters.category]     — "api", "ui", "journey", or undefined for all.
 *                                                  ("journey" matches `isJourneyTest = 1` —
 *                                                  orthogonal to api/ui.)
 * @param {string}        [filters.search]       — free-text search against name and sourceUrl.
 * @returns {PagedResult}
 */
export function getByProjectIdPaged(projectId, page, pageSize, filters = {}) {
  const db = getDatabase();
  const { page: p, pageSize: ps, offset } = parsePagination(page, pageSize);

  const conditions = ["projectId = ?", "deletedAt IS NULL"];
  const params = [projectId];

  if (filters.reviewStatus) {
    conditions.push("reviewStatus = ?");
    params.push(filters.reviewStatus);
  }
  if (filters.category === "api") {
    conditions.push("generatedFrom IN ('api_har_capture', 'api_user_described')");
  } else if (filters.category === "ui") {
    conditions.push("(generatedFrom IS NULL OR generatedFrom NOT IN ('api_har_capture', 'api_user_described'))");
  } else if (filters.category === "journey") {
    conditions.push("isJourneyTest = 1");
  }
  if (filters.stale) {
    conditions.push("isStale = 1");
  }
  if (filters.search) {
    conditions.push("(name LIKE ? OR sourceUrl LIKE ?)");
    const like = `%${filters.search}%`;
    params.push(like, like);
  }
  if (Array.isArray(filters.tags) && filters.tags.length > 0) {
    const tagClauses = filters.tags.map(() => `tags LIKE ?${TAG_LIKE_ESCAPE}`).join(" OR ");
    conditions.push(`(${tagClauses})`);
    for (const tag of filters.tags) {
      params.push(buildTagLikePattern(tag));
    }
  }

  const where = conditions.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM tests WHERE ${where}`).get(...params).cnt;
  const data = db.prepare(
    `SELECT * FROM tests WHERE ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`
  ).all(...params, ps, offset).map(rowToTest);
  return { data, meta: { total, page: p, pageSize: ps, hasMore: offset + data.length < total } };
}

/**
 * Get a non-deleted test by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return rowToTest(db.prepare("SELECT * FROM tests WHERE id = ? AND deletedAt IS NULL").get(id));
}

/**
 * Get a test by ID including soft-deleted (needed for restore operations).
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getByIdIncludeDeleted(id) {
  const db = getDatabase();
  return rowToTest(db.prepare("SELECT * FROM tests WHERE id = ?").get(id));
}

// ─── Write operations ─────────────────────────────────────────────────────────

/**
 * Create a test.
 * @param {Object} test
 */
export function create(test) {
  const db = getDatabase();
  const row = testToRow(test, { fillDefaults: true });
  const params = {};
  for (const col of INSERT_COLS) {
    params[col] = row[col] !== undefined ? row[col] : null;
  }
  if (params.name == null) params.name = "";
  if (params.description == null) params.description = "";
  if (params.steps == null) params.steps = "[]";
  if (params.tags == null) params.tags = "[]";
  if (params.isJourneyTest == null) params.isJourneyTest = 0;
  if (params.assertionEnhanced == null) params.assertionEnhanced = 0;
  if (params.reviewStatus == null) params.reviewStatus = "draft";
  if (params.priority == null) params.priority = "medium";
  if (params.codeVersion == null) params.codeVersion = 0;
  if (params.isStale == null) params.isStale = 0;
  if (params.flakyScore == null) params.flakyScore = 0;
  db.prepare(INSERT_SQL).run(params);
}

// Set of valid column names for filtering unknown properties in update().
const VALID_COLS = new Set(INSERT_COLS);

/**
 * Update specific fields on a test.
 * @param {string} id
 * @param {Object} fields — Partial test fields to update.
 */
export function update(id, fields) {
  const db = getDatabase();
  const row = testToRow(fields);
  const sets = [];
  const params = { id };
  for (const [key, val] of Object.entries(row)) {
    if (key === "id") continue;
    if (!VALID_COLS.has(key)) continue;
    sets.push(`${key} = @${key}`);
    params[key] = val;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE tests SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Soft-delete a test by ID (sets deletedAt to now).
 * @param {string} id
 */
export function deleteById(id) {
  const db = getDatabase();
  db.prepare("UPDATE tests SET deletedAt = datetime('now') WHERE id = ? AND deletedAt IS NULL").run(id);
}

/**
 * Hard-delete a test by ID (permanent — use only for purge operations).
 * @param {string} id
 */
export function hardDeleteById(id) {
  const db = getDatabase();
  db.prepare("DELETE FROM tests WHERE id = ?").run(id);
}

/**
 * Soft-delete all tests for a project.
 * Returns IDs of the tests that were just soft-deleted (excludes already-deleted).
 * @param {string} projectId
 * @returns {string[]} IDs of newly soft-deleted tests.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare(
    "SELECT id FROM tests WHERE projectId = ? AND deletedAt IS NULL"
  ).all(projectId).map(r => r.id);
  if (ids.length > 0) {
    db.prepare(
      "UPDATE tests SET deletedAt = datetime('now') WHERE projectId = ? AND deletedAt IS NULL"
    ).run(projectId);
  }
  return ids;
}

/**
 * Hard-delete all tests for a project (permanent — for project purge).
 * @param {string} projectId
 * @returns {string[]} IDs of all deleted tests.
 */
export function hardDeleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare("SELECT id FROM tests WHERE projectId = ?").all(projectId).map(r => r.id);
  if (ids.length > 0) {
    db.prepare("DELETE FROM tests WHERE projectId = ?").run(projectId);
  }
  return ids;
}

/**
 * Atomic revoke (AUTO-003b): clear `reviewStatus` + provenance ONLY IF the
 * row is currently `approved`. Returns `true` on success, `false` if the
 * row was already in a different state.
 *
 * Why a dedicated function instead of `update()`: revoke is the canonical
 * concurrent-write target — two reviewers can hit `POST /tests/:id/revoke`
 * at the same time, and we need exactly one to win. The route handler
 * does a read-then-write pair (`getById` → check `reviewStatus === 'approved'`
 * → `update`), which is safe on better-sqlite3 (synchronous, single-connection)
 * but races on PostgreSQL where the pool can serve both reads from the same
 * pre-revoke snapshot. Baking the check into the UPDATE's `WHERE` clause
 * makes the operation atomic on every adapter — only the request whose
 * UPDATE actually flips a row from `approved` to `draft` succeeds; the
 * second request's `UPDATE … WHERE reviewStatus = 'approved'` matches zero
 * rows and we return `false`.
 *
 * Caller is responsible for the 400/404 mapping: the route returns
 * `400 "only approved tests can be revoked"` when this returns `false`,
 * matching the existing read-then-write semantics.
 *
 * @param {string} id
 * @returns {boolean} `true` if the row transitioned approved → draft.
 */
export function revokeApprovalIfApproved(id) {
  const db = getDatabase();
  const info = db.prepare(
    `UPDATE tests SET
       reviewStatus = 'draft',
       reviewedAt = NULL,
       approvalSource = NULL,
       approvalThreshold = NULL,
       approvedAt = NULL,
       approvedBy = NULL
     WHERE id = ? AND reviewStatus = 'approved' AND deletedAt IS NULL`
  ).run(id);
  return info.changes > 0;
}

/**
 * Bulk update review status for a list of test IDs within a project.
 * Only applies to non-deleted tests.
 *
 * AUTO-003b: optional `extraFields` are applied in the SAME UPDATE statement
 * as `reviewStatus` / `reviewedAt`, inside the same transaction. This keeps
 * `reviewStatus` and provenance columns (`approvalSource`, `approvedBy`,
 * `approvedAt`, `approvalThreshold`) atomic — the previous two-phase pattern
 * (bulk status update, then per-row provenance writes) could leave tests
 * approved with null provenance if the request was aborted between phases,
 * which would miscount as human-approved on the approval-stats endpoint.
 *
 * `extraFields` keys are filtered through `VALID_COLS` so caller-supplied
 * keys can never inject column names. Values are bound via parameters.
 *
 * @param {string[]}    testIds
 * @param {string}      projectId
 * @param {string}      reviewStatus
 * @param {string|null} reviewedAt
 * @param {Object}      [extraFields]  - Additional column→value pairs to set
 *                                       in the same UPDATE (e.g. provenance).
 * @returns {Object[]} Updated test objects (re-read after the UPDATE so the
 *                     response reflects all fields, not just reviewStatus).
 */
export function bulkUpdateReviewStatus(testIds, projectId, reviewStatus, reviewedAt, extraFields = {}) {
  const db = getDatabase();
  const updated = [];

  // Filter extraFields to known columns + bake them into the UPDATE so the
  // whole write is a single atomic statement per test. Using SET fragments
  // built from the validated key list (not raw caller keys) keeps this safe
  // from SQL injection — only whitelisted column names ever land in the SQL.
  const row = testToRow(extraFields);
  const extraEntries = Object.entries(row).filter(([k]) => VALID_COLS.has(k) && k !== "id");
  const extraSets = extraEntries.map(([k]) => `${k} = ?`).join(", ");
  const sql = `UPDATE tests SET reviewStatus = ?, reviewedAt = ?${extraSets ? ", " + extraSets : ""}`
    + " WHERE id = ? AND projectId = ? AND deletedAt IS NULL";
  const stmt = db.prepare(sql);
  const extraValues = extraEntries.map(([, v]) => v);

  const txn = db.transaction(() => {
    for (const tid of testIds) {
      const info = stmt.run(reviewStatus, reviewedAt, ...extraValues, tid, projectId);
      if (info.changes > 0) {
        const test = getById(tid);
        if (test) updated.push(test);
      }
    }
  });
  txn();
  return updated;
}

// ─── Recycle bin ─────────────────────────────────────────────────────────────

/**
 * Get soft-deleted tests for a project (recycle bin view).
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getDeletedByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM tests WHERE projectId = ? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC"
  ).all(projectId).map(rowToTest);
}

/**
 * Get all soft-deleted tests across all projects.
 * @returns {Object[]}
 */
export function getDeletedAll() {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM tests WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC"
  ).all().map(rowToTest);
}

/**
 * Restore a soft-deleted test (clears deletedAt).
 * @param {string} id
 * @returns {boolean} Whether the test was found and restored.
 */
export function restore(id) {
  const db = getDatabase();
  const info = db.prepare("UPDATE tests SET deletedAt = NULL WHERE id = ? AND deletedAt IS NOT NULL").run(id);
  return info.changes > 0;
}

/**
 * Restore soft-deleted tests for a project that were deleted at or after a
 * given timestamp. Used by project cascade-restore to avoid restoring items
 * that were individually deleted before the project.
 * @param {string} projectId
 * @param {string} deletedAfter — ISO timestamp (inclusive lower bound).
 * @returns {number} Number of tests restored.
 */
export function restoreByProjectIdAfter(projectId, deletedAfter) {
  const db = getDatabase();
  const info = db.prepare(
    "UPDATE tests SET deletedAt = NULL WHERE projectId = ? AND deletedAt IS NOT NULL AND deletedAt >= ?"
  ).run(projectId, deletedAfter);
  return info.changes;
}

// ─── Stale test detection (AUTO-013) ──────────────────────────────────────────

/**
 * Find non-deleted tests that have not been run in the last N days.
 * @param {string[]} projectIds — Scope to these projects.
 * @param {number}   staleDays  — Days since last run to consider stale.
 * @returns {string[]} Test IDs.
 */
export function findStaleByAge(projectIds, staleDays) {
  if (!projectIds || projectIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(
    `SELECT id FROM tests
     WHERE projectId IN (${placeholders})
       AND deletedAt IS NULL
       AND (lastRunAt IS NULL OR lastRunAt < ?)
       AND reviewStatus = 'approved'`
  ).all(...projectIds, cutoff).map(r => r.id);
}

/**
 * Bulk-set the isStale flag for a list of test IDs.
 * @param {string[]} testIds
 * @param {boolean}  isStale
 */
export function bulkSetStale(testIds, isStale) {
  if (!testIds || testIds.length === 0) return;
  const db = getDatabase();
  const val = isStale ? 1 : 0;
  const stmt = db.prepare("UPDATE tests SET isStale = ? WHERE id = ?");
  const txn = db.transaction(() => {
    for (const id of testIds) stmt.run(val, id);
  });
  txn();
}

/**
 * Clear the isStale flag on all tests for the given project IDs.
 * Called before re-evaluating staleness so previously-stale tests that
 * have since been run are unflagged.
 * @param {string[]} projectIds
 * @returns {number} Number of tests that had their stale flag cleared.
 */
export function clearStaleByProjectIds(projectIds) {
  if (!projectIds || projectIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  const info = db.prepare(
    `UPDATE tests SET isStale = 0 WHERE projectId IN (${placeholders}) AND isStale = 1 AND deletedAt IS NULL`
  ).run(...projectIds);
  return info.changes;
}

// ─── Counts ───────────────────────────────────────────────────────────────────

/**
 * Count tests by review status + approval source for a project (AUTO-003b).
 *
 * Splits approved tests into `human` (reviewer-driven) and `auto` (machine-
 * driven) buckets based on the `approvalSource` column. Used by the project
 * approval-stats endpoint to render the calibration line
 * `N auto-approved · N human · N draft`.
 *
 * Done as a single `SUM(CASE WHEN ...)` aggregate so the query cost is
 * O(index lookup) instead of the previous O(n) in-JS scan over every row
 * in the project. Matches the existing {@link countByReviewStatus}
 * pattern — both are portable across the SQLite and PostgreSQL adapters
 * (INF-001) because they use only vanilla `CASE WHEN`, no dialect-specific
 * JSON or date functions.
 *
 * `auto` matches `approvalSource = 'auto'` exactly; `human` matches
 * `approved` with any other source (`'human'` on new rows, NULL on legacy
 * rows approved before migration 017). This preserves the invariant
 * `auto + human == approved` without a separate LEFT JOIN.
 *
 * @param {string} projectId
 * @returns {{ human: number, auto: number, draft: number, rejected: number, total: number }}
 */
export function countApprovalSplitByProjectId(projectId) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN reviewStatus = 'approved' AND approvalSource = 'auto'                              THEN 1 ELSE 0 END) AS auto,
      SUM(CASE WHEN reviewStatus = 'approved' AND (approvalSource IS NULL OR approvalSource <> 'auto') THEN 1 ELSE 0 END) AS human,
      SUM(CASE WHEN reviewStatus = 'draft'                                                             THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN reviewStatus = 'rejected'                                                          THEN 1 ELSE 0 END) AS rejected,
      COUNT(*)                                                                                                            AS total
    FROM tests
    WHERE projectId = ? AND deletedAt IS NULL
  `).get(projectId);
  return {
    human:    row?.human    || 0,
    auto:     row?.auto     || 0,
    draft:    row?.draft    || 0,
    rejected: row?.rejected || 0,
    total:    row?.total    || 0,
  };
}

/**
 * Count tests by review status for a project (non-deleted only).
 * Also returns last-result breakdown (passed/failed) for approved tests
 * and category breakdown (api/ui) across all statuses — so the frontend
 * can display accurate stats without fetching all rows.
 * @param {string} projectId
 * @returns {{ draft: number, approved: number, rejected: number, passed: number, failed: number, api: number, ui: number }}
 */
export function countByReviewStatus(projectId) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN reviewStatus = 'draft'    THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN reviewStatus = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN reviewStatus = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN reviewStatus = 'approved' AND lastResult = 'passed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN reviewStatus = 'approved' AND lastResult = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN generatedFrom IN ('api_har_capture', 'api_user_described') THEN 1 ELSE 0 END) AS api
    FROM tests
    WHERE projectId = ? AND deletedAt IS NULL
  `).get(projectId);
  // Stale count (AUTO-013) — separate query to avoid breaking the main aggregate
  // on databases that haven't run migration 006 yet.
  let stale = 0;
  try {
    const staleRow = db.prepare(
      "SELECT COUNT(*) AS cnt FROM tests WHERE projectId = ? AND deletedAt IS NULL AND isStale = 1"
    ).get(projectId);
    stale = staleRow?.cnt || 0;
  } catch { /* isStale column may not exist yet */ }

  return {
    draft:    row.draft    || 0,
    approved: row.approved || 0,
    rejected: row.rejected || 0,
    passed:   row.passed   || 0,
    failed:   row.failed   || 0,
    api:      row.api      || 0,
    ui:       (row.draft || 0) + (row.approved || 0) + (row.rejected || 0) - (row.api || 0),
    stale,
  };
}

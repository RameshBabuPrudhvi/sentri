/**
 * @module database/repositories/searchRepo
 * @description Workspace-scoped fuzzy search across projects, tests, and runs.
 * Backs `GET /api/v1/search` (GAP-001 — audit).
 *
 * Centralises the LIKE-based two-pass ranking SQL so route handlers stay thin
 * per AGENTS.md §117 ("Do not write raw SQL in route handlers — always go
 * through repository modules in `database/repositories/`").
 *
 * ### Ranking
 * Two passes per entity type:
 *   1. **Prefix match** on the primary searchable column — a query of `"check"`
 *      matches `"Checkout flow"` before `"Stock check"`.
 *   2. **Substring match** on the remaining columns, excluding ids already
 *      returned by the prefix pass.
 *
 * No FTS5 dependency: keeps the implementation portable between SQLite and
 * PostgreSQL adapters (INF-001).
 *
 * ### LIKE escaping
 * Caller-supplied text is passed through {@link escapeLike} so a search for
 * `"50%_off"` doesn't match unrelated rows. Every `LIKE` clause uses
 * `ESCAPE '\\'`. Mirrors the pattern in `testRepo.buildTagLikePattern` minus
 * the JSON-encoding stage — we search `name` / `id` / `url` columns, not
 * JSON-encoded `tags` blobs.
 */

import { getDatabase } from "../sqlite.js";

const LIKE_ESCAPE = " ESCAPE '\\'";

/**
 * Escape SQL `LIKE` metacharacters so user input matches literally.
 * The returned string MUST be used with a `LIKE ? ESCAPE '\\'` clause.
 * @param {string} s
 * @returns {string}
 */
export function escapeLike(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Two-pass project search scoped to a set of project ids.
 * @param {string[]} projectIds — Workspace's project set (caller-resolved).
 * @param {string} query — Already-trimmed user query.
 * @param {number} maxResults — Hard cap on rows returned.
 * @returns {Array<{id: string, name: string, url: string}>}
 */
export function searchProjects(projectIds, query, maxResults) {
  if (projectIds.length === 0) return [];
  const db = getDatabase();
  const likeEscaped = escapeLike(query);
  const prefixPattern = `${likeEscaped}%`;
  const substringPattern = `%${likeEscaped}%`;
  const placeholders = projectIds.map(() => "?").join(", ");

  // Pass 1: prefix-on-name.
  const prefixRows = db.prepare(
    `SELECT id, name, url FROM projects
     WHERE id IN (${placeholders})
       AND deletedAt IS NULL
       AND name LIKE ?${LIKE_ESCAPE}
     ORDER BY LENGTH(name) ASC
     LIMIT ?`
  ).all(...projectIds, prefixPattern, maxResults);

  // Pass 2: substring-on-(name|url) for the remainder.
  const remaining = maxResults - prefixRows.length;
  if (remaining <= 0) return prefixRows;
  const excludeIds = prefixRows.map((r) => r.id);
  const excludeClause = excludeIds.length
    ? ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`
    : "";
  const substringRows = db.prepare(
    `SELECT id, name, url FROM projects
     WHERE id IN (${placeholders})
       AND deletedAt IS NULL
       AND (name LIKE ?${LIKE_ESCAPE} OR url LIKE ?${LIKE_ESCAPE})${excludeClause}
     ORDER BY LENGTH(name) ASC
     LIMIT ?`
  ).all(...projectIds, substringPattern, substringPattern, ...excludeIds, remaining);

  return [...prefixRows, ...substringRows];
}

/**
 * Two-pass test search scoped to a set of project ids. Matches against
 * `name` (primary) + `id` (so a paste of `"TC-42"` jumps straight to the test).
 * @param {string[]} projectIds
 * @param {string} query
 * @param {number} maxResults
 * @returns {Array<{id: string, name: string, projectId: string, reviewStatus: string}>}
 */
export function searchTests(projectIds, query, maxResults) {
  if (projectIds.length === 0) return [];
  const db = getDatabase();
  const likeEscaped = escapeLike(query);
  const prefixPattern = `${likeEscaped}%`;
  const substringPattern = `%${likeEscaped}%`;
  const placeholders = projectIds.map(() => "?").join(", ");

  const prefixRows = db.prepare(
    `SELECT id, name, projectId, reviewStatus FROM tests
     WHERE projectId IN (${placeholders})
       AND deletedAt IS NULL
       AND name LIKE ?${LIKE_ESCAPE}
     ORDER BY LENGTH(name) ASC
     LIMIT ?`
  ).all(...projectIds, prefixPattern, maxResults);

  const remaining = maxResults - prefixRows.length;
  if (remaining <= 0) return prefixRows;
  const excludeIds = prefixRows.map((r) => r.id);
  const excludeClause = excludeIds.length
    ? ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`
    : "";
  const substringRows = db.prepare(
    `SELECT id, name, projectId, reviewStatus FROM tests
     WHERE projectId IN (${placeholders})
       AND deletedAt IS NULL
       AND (name LIKE ?${LIKE_ESCAPE} OR id LIKE ?${LIKE_ESCAPE})${excludeClause}
     ORDER BY LENGTH(name) ASC
     LIMIT ?`
  ).all(...projectIds, substringPattern, substringPattern, ...excludeIds, remaining);

  return [...prefixRows, ...substringRows];
}

/**
 * Substring search across runs scoped to a set of project ids. Runs have no
 * `name` column — match on `id` only. Primary use case: operators paste run
 * IDs from CI logs / Slack notifications.
 * @param {string[]} projectIds
 * @param {string} query
 * @param {number} maxResults
 * @returns {Array<{id: string, projectId: string, type: string, status: string, startedAt: string}>}
 */
export function searchRuns(projectIds, query, maxResults) {
  if (projectIds.length === 0) return [];
  const db = getDatabase();
  const substringPattern = `%${escapeLike(query)}%`;
  const placeholders = projectIds.map(() => "?").join(", ");

  // `startedAt IS NULL` first in the ORDER BY pushes queued / aborted runs
  // (which have no start timestamp) to the bottom of the result set —
  // SQLite's default `ORDER BY ... DESC` puts NULLs FIRST, which would
  // otherwise surface unstarted runs above completed ones. Equivalent to
  // `NULLS LAST` in PostgreSQL but portable to SQLite (which doesn't
  // support the NULLS LAST syntax until 3.30).
  return db.prepare(
    `SELECT id, projectId, type, status, startedAt FROM runs
     WHERE projectId IN (${placeholders})
       AND deletedAt IS NULL
       AND id LIKE ?${LIKE_ESCAPE}
     ORDER BY startedAt IS NULL, startedAt DESC
     LIMIT ?`
  ).all(...projectIds, substringPattern, maxResults);
}

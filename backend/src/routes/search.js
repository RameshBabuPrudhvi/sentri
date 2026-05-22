/**
 * @module routes/search
 * @description GAP-001 (audit) — Global data search across tests, projects,
 * and runs. Mounted at `/api/v1` (INF-005).
 *
 * Powers the ⌘K command palette's data-search layer so power users can find
 * "the test named checkout flow" or "run abc123" without drilling through
 * Projects → ProjectDetail → Tests. The audit calls this out as Critical /
 * P1 (M effort) in `docs/roadmap/sentri-ux-audit-22May2026.md`.
 *
 * ### Endpoint
 * | Method | Path                  | Description                              |
 * |--------|-----------------------|-------------------------------------------|
 * | `GET`  | `/api/v1/search?q=…`  | Workspace-scoped fuzzy search results    |
 *
 * ### Design
 * - ACL-001: resolves the workspace's project set first via `projectRepo.getAll`
 *   then intersects every subsequent test/run query against that set.
 *   Cross-workspace IDOR is impossible by construction.
 * - Ranking: SQL `LIKE` with two passes per entity type — prefix-match first
 *   (a query of "check" matches "Checkout flow" before "Stock check"), then
 *   substring-match for the remainder. No FTS5: keeps the implementation
 *   portable between SQLite + PostgreSQL adapters (INF-001).
 * - Result cap: 5 per type, 15 total. Bounded so a 100k-test workspace
 *   doesn't ship a megabyte payload to the palette.
 * - `q.length < 2` returns an empty result set (not an error) — matches
 *   the Linear / Notion / Vercel convention.
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import { getDatabase } from "../database/sqlite.js";

const router = Router();

const MAX_PER_TYPE = 5;
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 200;

/**
 * Escape SQL `LIKE` metacharacters in caller-supplied text so a search for
 * `"50%_off"` doesn't match unrelated rows. The returned string MUST be used
 * with a `LIKE ? ESCAPE '\\'` clause. Mirrors the pattern from
 * `testRepo.buildTagLikePattern` (`backend/src/database/repositories/testRepo.js:83`)
 * minus the JSON-encoding stage — we're searching `name` / `id` / `url`
 * columns, not JSON-encoded `tags` blobs.
 */
function escapeLike(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

const LIKE_ESCAPE = " ESCAPE '\\'";

router.get("/search", (req, res) => {
  try {
    const rawQuery = String(req.query.q || "").trim();

    // Too short → empty result (not an error). The palette renders a
    // "type to search" hint until the user crosses the minimum length.
    if (rawQuery.length < MIN_QUERY_LEN) {
      return res.json({
        query: rawQuery,
        groups: { projects: [], tests: [], runs: [] },
        totalCount: 0,
        truncated: false,
      });
    }
    // Cap query length so a malicious caller can't push a megabyte of LIKE
    // pattern at the SQL engine. Real palette queries are 1–30 chars.
    if (rawQuery.length > MAX_QUERY_LEN) {
      return res.status(400).json({
        error: `Query must be ${MAX_QUERY_LEN} characters or fewer.`,
      });
    }

    // ACL-001: workspace's project set first. Every subsequent query
    // intersects against this list so a stray projectId can't widen scope.
    const projects = projectRepo.getAll(req.workspaceId);
    const projectIds = projects.map((p) => p.id);
    const projectsById = {};
    for (const p of projects) projectsById[p.id] = p;

    const likeEscaped = escapeLike(rawQuery);
    const prefixPattern = `${likeEscaped}%`;
    const substringPattern = `%${likeEscaped}%`;
    const db = getDatabase();

    // ── Projects ──────────────────────────────────────────────────────────
    // Match against `name` (primary) + `url` (so "github.com" finds the
    // wired-up repo). Two-pass ranking: prefix-on-name first (highest
    // signal), then substring-on-(name|url) for the remainder.
    const projectMatches = [];
    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => "?").join(", ");
      const prefixRows = db.prepare(
        `SELECT id, name, url FROM projects
         WHERE id IN (${placeholders})
           AND deletedAt IS NULL
           AND name LIKE ?${LIKE_ESCAPE}
         ORDER BY LENGTH(name) ASC
         LIMIT ?`
      ).all(...projectIds, prefixPattern, MAX_PER_TYPE);
      const remaining = MAX_PER_TYPE - prefixRows.length;
      let substringRows = [];
      if (remaining > 0) {
        const excludeIds = prefixRows.map((r) => r.id);
        const excludeClause = excludeIds.length
          ? ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`
          : "";
        substringRows = db.prepare(
          `SELECT id, name, url FROM projects
           WHERE id IN (${placeholders})
             AND deletedAt IS NULL
             AND (name LIKE ?${LIKE_ESCAPE} OR url LIKE ?${LIKE_ESCAPE})${excludeClause}
           ORDER BY LENGTH(name) ASC
           LIMIT ?`
        ).all(...projectIds, substringPattern, substringPattern, ...excludeIds, remaining);
      }
      projectMatches.push(...prefixRows, ...substringRows);
    }

    // ── Tests ─────────────────────────────────────────────────────────────
    // Match against `name` + `id` (so a paste of "TC-42" jumps straight to
    // the test). Scoped to the workspace's project set.
    const testMatches = [];
    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => "?").join(", ");
      const prefixRows = db.prepare(
        `SELECT id, name, projectId, reviewStatus FROM tests
         WHERE projectId IN (${placeholders})
           AND deletedAt IS NULL
           AND name LIKE ?${LIKE_ESCAPE}
         ORDER BY LENGTH(name) ASC
         LIMIT ?`
      ).all(...projectIds, prefixPattern, MAX_PER_TYPE);
      const remaining = MAX_PER_TYPE - prefixRows.length;
      let substringRows = [];
      if (remaining > 0) {
        const excludeIds = prefixRows.map((r) => r.id);
        const excludeClause = excludeIds.length
          ? ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`
          : "";
        substringRows = db.prepare(
          `SELECT id, name, projectId, reviewStatus FROM tests
           WHERE projectId IN (${placeholders})
             AND deletedAt IS NULL
             AND (name LIKE ?${LIKE_ESCAPE} OR id LIKE ?${LIKE_ESCAPE})${excludeClause}
           ORDER BY LENGTH(name) ASC
           LIMIT ?`
        ).all(...projectIds, substringPattern, substringPattern, ...excludeIds, remaining);
      }
      for (const r of [...prefixRows, ...substringRows]) {
        testMatches.push({
          id: r.id,
          name: r.name,
          projectId: r.projectId,
          projectName: projectsById[r.projectId]?.name || null,
          reviewStatus: r.reviewStatus,
        });
      }
    }

    // ── Runs ──────────────────────────────────────────────────────────────
    // Runs have no `name` column — match on `id` only. Primary use case:
    // operators paste run IDs from CI logs / Slack notifications.
    const runMatches = [];
    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => "?").join(", ");
      const rows = db.prepare(
        `SELECT id, projectId, type, status, startedAt FROM runs
         WHERE projectId IN (${placeholders})
           AND deletedAt IS NULL
           AND id LIKE ?${LIKE_ESCAPE}
         ORDER BY startedAt DESC
         LIMIT ?`
      ).all(...projectIds, substringPattern, MAX_PER_TYPE);
      for (const r of rows) {
        runMatches.push({
          id: r.id,
          projectId: r.projectId,
          projectName: projectsById[r.projectId]?.name || null,
          type: r.type,
          status: r.status,
          startedAt: r.startedAt,
        });
      }
    }

    const totalCount = projectMatches.length + testMatches.length + runMatches.length;
    // `truncated` flags the palette that there may be more matches the user
    // can find via the full list page. We can't know the true total without
    // a COUNT(*) per type, which would double the query cost for a signal
    // that's only useful when MAX_PER_TYPE was actually hit.
    const truncated =
      projectMatches.length >= MAX_PER_TYPE ||
      testMatches.length >= MAX_PER_TYPE ||
      runMatches.length >= MAX_PER_TYPE;

    return res.json({
      query: rawQuery,
      groups: {
        projects: projectMatches,
        tests: testMatches,
        runs: runMatches,
      },
      totalCount,
      truncated,
    });
  } catch (err) {
    // Mirror the dashboard route's pattern — log + 500 rather than letting
    // the request hang on an unhandled rejection (Express 4 doesn't await
    // route handlers).
    // eslint-disable-next-line no-console
    console.error(`[search] ${err?.stack || err?.message || err}`);
    return res.status(500).json({ error: "Search unavailable." });
  }
});

export default router;

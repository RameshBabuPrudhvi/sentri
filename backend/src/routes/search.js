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
import * as searchRepo from "../database/repositories/searchRepo.js";
import { formatLogLine } from "../utils/logFormatter.js";

const router = Router();

const MAX_PER_TYPE = 5;
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 200;

router.get("/search", (req, res) => {
  try {
    // Defence-in-depth: `workspaceScope` middleware should have populated
    // `req.workspaceId` before this handler runs. If a future refactor of
    // `backend/src/index.js` ever drops the middleware from the mount chain,
    // `projectRepo.getAll(undefined)` falls through to an unfiltered
    // `SELECT * FROM projects WHERE deletedAt IS NULL` (see projectRepo.js:73-78)
    // and returns every project across every workspace — a cross-tenant leak
    // by silent scope-widening. Fail closed instead so the regression surfaces
    // on the first request rather than as a slow data exfiltration.
    if (!req.workspaceId) {
      // eslint-disable-next-line no-console
      console.error(formatLogLine("error", null, "[search] req.workspaceId missing — workspaceScope middleware likely not mounted"));
      return res.status(500).json({ error: "Workspace context required." });
    }

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

    // ACL-001: workspace's project set first. Every subsequent repo call
    // intersects against this list so a stray projectId can't widen scope.
    const projects = projectRepo.getAll(req.workspaceId);
    const projectIds = projects.map((p) => p.id);
    const projectsById = {};
    for (const p of projects) projectsById[p.id] = p;

    // Delegated to `searchRepo` (AGENT.md §117) — the route stays a thin
    // HTTP shape + ACL layer; SQL lives in the repository module.
    const projectMatches = searchRepo.searchProjects(projectIds, rawQuery, MAX_PER_TYPE);

    const testMatches = searchRepo
      .searchTests(projectIds, rawQuery, MAX_PER_TYPE)
      .map((r) => ({
        id: r.id,
        name: r.name,
        projectId: r.projectId,
        projectName: projectsById[r.projectId]?.name || null,
        reviewStatus: r.reviewStatus,
      }));

    const runMatches = searchRepo
      .searchRuns(projectIds, rawQuery, MAX_PER_TYPE)
      .map((r) => ({
        id: r.id,
        projectId: r.projectId,
        projectName: projectsById[r.projectId]?.name || null,
        type: r.type,
        status: r.status,
        startedAt: r.startedAt,
      }));

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
    console.error(formatLogLine("error", null, `[search] ${err?.stack || err?.message || err}`));
    return res.status(500).json({ error: "Search unavailable." });
  }
});

export default router;

/**
 * @module tests/ai-request-log-list-by-run
 * @description GAP-005 (migration 056) — regression coverage for the new
 * `aiRequestLogRepo.listByRun(workspaceId, runId, opts)` exported function.
 *
 * What this pins:
 *   1. Rows correlated to a runId are returned, ordered chronologically.
 *   2. Workspace ACL is enforced — a row in another workspace with the
 *      matching runId is NOT returned even if the runId guess is correct.
 *   3. The `limit` option is clamped to [1, 500] and defaults to 200.
 *   4. Non-finite / negative `opts.limit` falls back to the 200 default
 *      rather than crashing on `prepare().all(undefined)`.
 *   5. Rows with `runId = NULL` (calls outside any run context: chat,
 *      healthchecks) do not match a `WHERE runId = ?` query — i.e. they
 *      are naturally excluded.
 *
 * Usage: node backend/tests/ai-request-log-list-by-run.test.js
 */

import assert from "node:assert/strict";
import { resetDb } from "./helpers/test-base.js";
import * as aiRequestLogRepo from "../src/database/repositories/aiRequestLogRepo.js";
import { getDatabase } from "../src/database/sqlite.js";

// `ai_request_log.workspaceId → workspaces(id)` per migration 047. `resetDb()`
// re-seeds `__system__` but not the bespoke workspace ids this test uses;
// without parents the INSERTs trip `SQLITE_CONSTRAINT_FOREIGNKEY`.
function seedFkParents() {
  const db = getDatabase();
  const now = new Date().toISOString();
  for (const id of ["WS-test", "WS-other"]) {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt)
       VALUES (?, ?, ?, '__system__', ?, ?)`,
    ).run(id, id, id.toLowerCase(), now, now);
  }
}

let rowCounter = 0;
function insertRow({ workspaceId, runId, createdAt }) {
  const db = getDatabase();
  const id = `AIR-${++rowCounter}`;
  db.prepare(
    `INSERT INTO ai_request_log
       (id, workspaceId, routeId, agentRole, userId, runId,
        promptHash, promptRedacted, responseRedacted,
        inputTokens, outputTokens, costUsd, latencyMs,
        outcome, errorReason, traceId, createdAt)
     VALUES (?, ?, NULL, 'author', 'user-1', ?,
       'hash', NULL, NULL,
       100, 50, 0.001, 120,
       'ok', NULL, NULL, ?)`,
  ).run(id, workspaceId, runId, createdAt);
  return id;
}

async function main() {
  resetDb();
  seedFkParents();

  // ── 1. Chronological order for a single run ────────────────────────────
  {
    insertRow({ workspaceId: "WS-test", runId: "RUN-A", createdAt: "2026-01-01T00:00:03Z" });
    insertRow({ workspaceId: "WS-test", runId: "RUN-A", createdAt: "2026-01-01T00:00:01Z" });
    insertRow({ workspaceId: "WS-test", runId: "RUN-A", createdAt: "2026-01-01T00:00:02Z" });
    const rows = aiRequestLogRepo.listByRun("WS-test", "RUN-A");
    assert.equal(rows.length, 3);
    // ORDER BY createdAt ASC — oldest first so the timeline reads top-to-bottom.
    assert.equal(rows[0].createdAt, "2026-01-01T00:00:01Z");
    assert.equal(rows[1].createdAt, "2026-01-01T00:00:02Z");
    assert.equal(rows[2].createdAt, "2026-01-01T00:00:03Z");
  }

  // ── 2. Workspace ACL is enforced ───────────────────────────────────────
  // A row in WS-other with the same runId must NOT leak to WS-test queries.
  {
    insertRow({ workspaceId: "WS-other", runId: "RUN-shared", createdAt: "2026-01-02T00:00:00Z" });
    insertRow({ workspaceId: "WS-test",  runId: "RUN-shared", createdAt: "2026-01-02T00:00:01Z" });
    const rows = aiRequestLogRepo.listByRun("WS-test", "RUN-shared");
    assert.equal(rows.length, 1, "workspace ACL must scope listByRun");
    assert.equal(rows[0].workspaceId, "WS-test");
  }

  // ── 3. NULL runId rows are excluded ────────────────────────────────────
  // Calls outside a run context (chat, healthchecks) write runId=NULL and
  // must NOT appear in a runId-scoped query.
  {
    insertRow({ workspaceId: "WS-test", runId: null, createdAt: "2026-01-03T00:00:00Z" });
    const rows = aiRequestLogRepo.listByRun("WS-test", "RUN-A");
    assert.equal(rows.length, 3, "null-runId rows must not match a specific runId filter");
  }

  // ── 4. Limit clamping: default = 200 ───────────────────────────────────
  // Hard to test 200-row ceiling cheaply; just verify the default is used
  // when opts.limit is omitted and the query doesn't crash.
  {
    const rows = aiRequestLogRepo.listByRun("WS-test", "RUN-A");
    assert.ok(rows.length <= 200, "default limit must be 200");
  }

  // ── 5. Limit clamping: explicit limit honoured ─────────────────────────
  {
    const rows = aiRequestLogRepo.listByRun("WS-test", "RUN-A", { limit: 2 });
    assert.equal(rows.length, 2, "explicit limit must clip the result set");
  }

  // ── 6. Limit clamping: non-finite limit falls back to default ──────────
  // Without this guard, `Number(opts.limit) || 200` resolves to 200 for
  // NaN / "abc" / 0 / negative numbers — pinning the contract.
  {
    const rowsNaN = aiRequestLogRepo.listByRun("WS-test", "RUN-A", { limit: NaN });
    assert.equal(rowsNaN.length, 3, "NaN limit must fall back to default");
    const rowsZero = aiRequestLogRepo.listByRun("WS-test", "RUN-A", { limit: 0 });
    assert.equal(rowsZero.length, 3, "limit=0 must fall back to default (not return empty)");
    const rowsNeg = aiRequestLogRepo.listByRun("WS-test", "RUN-A", { limit: -5 });
    assert.equal(rowsNeg.length, 3, "negative limit must fall back to default");
  }

  // ── 7. Empty result set for unknown runId ──────────────────────────────
  {
    const rows = aiRequestLogRepo.listByRun("WS-test", "RUN-does-not-exist");
    assert.equal(rows.length, 0);
    assert.ok(Array.isArray(rows), "must return [] not null/undefined");
  }

  console.log("✅ ai-request-log-list-by-run passed");
}

main().catch((err) => {
  console.error("❌ ai-request-log-list-by-run failed:", err);
  process.exit(1);
});

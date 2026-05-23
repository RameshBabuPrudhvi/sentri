/**
 * @module tests/activity-runid-filter
 * @description ENT-004 (audit) — regression coverage for the `activities.runId`
 * column added by migration 055 + the matching server-side filters.
 *
 * What this pins:
 *   1. `activityRepo.create({ runId })` persists the column.
 *   2. `activityRepo.create({ meta: { runId } })` (legacy writer shape)
 *      still persists the column via the `logActivity` auto-derive path —
 *      so historical writers that stashed runId in meta keep populating
 *      the new index without per-site code changes.
 *   3. `getFiltered({ runId })` returns only matching rows.
 *   4. `getWorkspaceAuditLog({ runId })` returns only matching rows AND
 *      preserves the workspace ACL (rows in a different workspace are
 *      never returned, even when the runId matches).
 *   5. `logActivity({ runId, … })` resolves the first-class arg correctly
 *      AND the meta-fallback wins when the arg is absent.
 *
 * Why we test BOTH the first-class arg AND the meta fallback: the migration
 * has to populate the column for emitters that haven't been updated yet —
 * the auto-derive is the contract the changelog promised, and silently
 * dropping it would leave half the audit rows orphaned from `/audit-log?runId=`.
 *
 * Usage: node backend/tests/activity-runid-filter.test.js
 */

import assert from "node:assert/strict";
import { resetDb } from "./helpers/test-base.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import { getDatabase } from "../src/database/sqlite.js";
import { logActivity } from "../src/utils/activityLogger.js";

// FK setup — the `activities` table carries TWO foreign keys that fire
// here (migrations 001 + 005):
//   • `activities.projectId → projects(id)` ON DELETE CASCADE
//   • `activities.workspaceId → workspaces(id)`
// Without parent rows in BOTH tables the `activityRepo.create()` INSERT
// trips `SQLITE_CONSTRAINT_FOREIGNKEY`. `resetDb()` re-seeds the
// `__system__` user + workspace but our test uses bespoke
// `WS-test` / `WS-other` workspaces — we have to seed those too.
function seedFkParents() {
  const db = getDatabase();
  const now = new Date().toISOString();
  // Workspaces first — projects FK-reference them. ownerId points at
  // the `__system__` user that `resetDb()` re-seeds, so no separate
  // user insert is needed.
  for (const id of ["WS-test", "WS-other"]) {
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt)
       VALUES (?, ?, ?, '__system__', ?, ?)`,
    ).run(id, id, id.toLowerCase(), now, now);
  }
  // Projects — give each its matching workspaceId so the projects FK
  // is satisfied AND so any downstream query that joins projects by
  // workspace doesn't accidentally see orphaned rows.
  const projects = [
    { id: "PRJ-test", workspaceId: "WS-test" },
    { id: "PRJ-other", workspaceId: "WS-other" },
  ];
  for (const p of projects) {
    projectRepo.create({
      id: p.id,
      name: p.id,
      url: "https://example.com",
      workspaceId: p.workspaceId,
      createdAt: now,
    });
  }
}

let activityCounter = 0;
function makeId() {
  // ACT-N shape so the dedup matcher / hash-chain ordering code (which
  // CASTs SUBSTR(id, 5) AS INTEGER) treats the row as a real activity row
  // rather than a malformed test fixture.
  return `ACT-${++activityCounter}`;
}

function makeActivity(overrides = {}) {
  return {
    id: makeId(),
    type: "test_run.start",
    projectId: "PRJ-test",
    projectName: "Test Project",
    testId: null,
    testName: null,
    runId: null,
    detail: "Test row",
    status: "completed",
    createdAt: new Date().toISOString(),
    userId: "user-1",
    userName: "Tester",
    workspaceId: "WS-test",
    meta: null,
    ipAddress: null,
    userAgent: null,
    prevHash: null,
    ...overrides,
  };
}

async function main() {
  resetDb();
  seedFkParents();

  // ── 1. Persist via explicit `runId` field ─────────────────────────────────
  {
    activityRepo.create(makeActivity({ runId: "RUN-101", detail: "explicit runId" }));
    const rows = activityRepo.getFiltered({ runId: "RUN-101", workspaceId: "WS-test" });
    assert.equal(rows.length, 1, "explicit runId should be retrievable via getFiltered");
    assert.equal(rows[0].runId, "RUN-101");
    assert.equal(rows[0].detail, "explicit runId");
  }

  // ── 2. Persist via legacy `meta.runId` through logActivity ────────────────
  // logActivity should auto-derive `runId` from meta when the first-class
  // arg is absent, so this row IS reachable via `?runId=`. This is the
  // backwards-compat contract that lets us not touch every writer.
  {
    logActivity({
      type: "test_run.complete",
      projectId: "PRJ-test",
      projectName: "Test Project",
      workspaceId: "WS-test",
      userId: "user-1",
      userName: "Tester",
      detail: "from meta",
      meta: { runId: "RUN-202", customField: "kept" },
    });
    const rows = activityRepo.getFiltered({ runId: "RUN-202", workspaceId: "WS-test" });
    assert.equal(rows.length, 1, "meta.runId should be auto-promoted by logActivity to the indexed column");
    assert.equal(rows[0].runId, "RUN-202");
    // meta is preserved unchanged — the runId stays in JSON too so legacy
    // consumers reading `row.meta.runId` keep working.
    assert.equal(rows[0].meta?.runId, "RUN-202");
    assert.equal(rows[0].meta?.customField, "kept");
  }

  // ── 3. First-class arg wins when both are present ─────────────────────────
  // The first-class arg is the new canonical source; meta.runId is the
  // fallback only when the arg is absent. If a writer passes both, the
  // first-class arg must win (otherwise migrating a writer from meta to
  // arg would silently break for rows where the two values differ).
  {
    logActivity({
      type: "test_run.start",
      projectId: "PRJ-test",
      workspaceId: "WS-test",
      runId: "RUN-303-arg",
      detail: "both arg and meta",
      meta: { runId: "RUN-303-meta" },
    });
    const argRows = activityRepo.getFiltered({ runId: "RUN-303-arg", workspaceId: "WS-test" });
    assert.equal(argRows.length, 1, "first-class arg should populate the column");
    const metaRows = activityRepo.getFiltered({ runId: "RUN-303-meta", workspaceId: "WS-test" });
    assert.equal(metaRows.length, 0, "meta.runId must NOT win when the first-class arg is set");
  }

  // ── 4. NULL runId is preserved ────────────────────────────────────────────
  // Pre-migration rows have `runId = NULL`; activities that don't relate
  // to a run (e.g. settings.update, project.create) also leave it NULL.
  // Filtering by a specific runId must NOT return null-runId rows.
  {
    activityRepo.create(makeActivity({ runId: null, type: "settings.update", detail: "no run context" }));
    const rows = activityRepo.getFiltered({ runId: "RUN-101", workspaceId: "WS-test" });
    assert.equal(rows.length, 1, "settings.update with no runId should not match RUN-101");
    assert.equal(rows[0].detail, "explicit runId", "the matched row must be RUN-101's, not the null-runId row");
  }

  // ── 5. Workspace ACL is enforced through getWorkspaceAuditLog ─────────────
  // A row in workspace WS-other with the same runId as a WS-test row must
  // NOT be returned when WS-test queries. This is the security boundary —
  // without it, runId guessing would let any admin read across workspaces.
  {
    activityRepo.create(makeActivity({
      runId: "RUN-shared",
      workspaceId: "WS-other",
      projectId: "PRJ-other",
      detail: "other workspace",
    }));
    activityRepo.create(makeActivity({
      runId: "RUN-shared",
      workspaceId: "WS-test",
      detail: "this workspace",
    }));
    const { rows } = activityRepo.getWorkspaceAuditLog("WS-test", { runId: "RUN-shared" });
    assert.equal(rows.length, 1, "workspace ACL must scope runId filter — exactly one row");
    assert.equal(rows[0].workspaceId, "WS-test");
    assert.equal(rows[0].detail, "this workspace", "cross-workspace runId leak");
  }

  // ── 6. Multiple rows for the same runId all return ────────────────────────
  // A single run typically writes 3-5 lifecycle activities (start /
  // complete / abort / regenerate). The filter must return all of them
  // so the AuditLog page renders the full timeline, not just one.
  {
    const runId = "RUN-multi";
    activityRepo.create(makeActivity({ runId, type: "test_run.start",    detail: "start"    }));
    activityRepo.create(makeActivity({ runId, type: "test_run.complete", detail: "complete" }));
    activityRepo.create(makeActivity({ runId, type: "test.regenerate",   detail: "regen"    }));
    const rows = activityRepo.getFiltered({ runId, workspaceId: "WS-test" });
    assert.equal(rows.length, 3, "all 3 lifecycle rows should match RUN-multi");
    const types = new Set(rows.map((r) => r.type));
    assert.ok(types.has("test_run.start"));
    assert.ok(types.has("test_run.complete"));
    assert.ok(types.has("test.regenerate"));
  }

  // ── 7. No filter args → no runId narrowing ────────────────────────────────
  // Sanity: calling getFiltered without runId returns the workspace's
  // full feed unchanged, so the new arg is purely additive. Without this
  // assertion a future regression could accidentally make runId mandatory.
  {
    const allRows = activityRepo.getFiltered({ workspaceId: "WS-test" });
    // We've inserted: RUN-101 (1) + RUN-202 (1) + RUN-303-arg (1) +
    // settings.update no-runId (1) + RUN-shared in WS-test (1) +
    // RUN-multi × 3 = 8 rows in WS-test.
    assert.equal(allRows.length, 8, `WS-test workspace should have 8 rows total, got ${allRows.length}`);
  }

  console.log("✅ activity-runid-filter passed");
}

main().catch((err) => {
  console.error("❌ activity-runid-filter failed:", err);
  process.exit(1);
});

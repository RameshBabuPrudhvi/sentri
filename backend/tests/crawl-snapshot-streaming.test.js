/**
 * @module tests/crawl-snapshot-streaming
 * @description B1.3 (AUDIT-ROADMAP Bundle 1) — snapshot streaming + repo contract.
 *
 * Locks in the contracts the crawler relies on once `crawlBrowser.js` and
 * `stateExplorer.js` stream each page's snapshot to `crawl_snapshots`
 * instead of accumulating in heap:
 *
 *   1. `save()` → `getByRunId()` round-trips snapshot JSON cleanly.
 *   2. `save()` is idempotent on (runId, url) — re-crawling a URL is a
 *      no-op (`INSERT OR IGNORE`), not an error.
 *   3. `getUrlsByRunId()` is the cheap projection — does not deserialise
 *      snapshot JSON.
 *   4. `getLoadTimesByRunId()` returns only rows with non-null `loadMs`,
 *      which Bundle 2's adaptive timeout consumes for p95 math.
 *   5. `deleteByRunId()` / `deleteByRunIds()` clean up the purge path.
 *   6. `countByRunId()` is the lean "snapshotCount" surface for run responses.
 */

import assert from "node:assert/strict";
import { getDatabase, getDatabaseDialect } from "../src/database/sqlite.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as crawlSnapshotRepo from "../src/database/repositories/crawlSnapshotRepo.js";

let _ctr = 7000;
const uid = (prefix) => `${prefix}-CSS-${++_ctr}`;

function makeProject() {
  return {
    id: uid("PRJ"),
    name: "Snapshot Streaming Project",
    url: "https://example.com",
    createdAt: new Date().toISOString(),
    status: "idle",
  };
}

function makeRun(projectId, overrides = {}) {
  return {
    id: uid("RUN"),
    projectId,
    type: "crawl",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    tests: [],
    results: [],
    passed: 0,
    failed: 0,
    total: 0,
    shardCount: 1,
    shardsCompleted: 0,
    ...overrides,
  };
}

function makeSnapshot(url, extra = {}) {
  return {
    url,
    title: `Page ${url}`,
    elements: [
      { tag: "button", text: "Submit", visible: true },
      { tag: "input", type: "text", placeholder: "Name", visible: true },
    ],
    ...extra,
  };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM crawl_snapshots WHERE runId LIKE 'RUN-CSS-%'");
  db.exec("DELETE FROM runs            WHERE id    LIKE 'RUN-CSS-%'");
  db.exec("DELETE FROM projects        WHERE id    LIKE 'PRJ-CSS-%'");
}

import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const runner = t.createTestRunner();

async function main() {
  resetDb();
  const project = makeProject();
  projectRepo.create(project);

  // ── save + getByRunId round-trip ───────────────────────────────────────
  await runner.test("save + getByRunId: snapshot JSON + loadMs round-trip cleanly", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    const snap = makeSnapshot("https://example.com/page-a");
    crawlSnapshotRepo.save(run.id, snap.url, snap, { loadMs: 1234 });

    const rows = crawlSnapshotRepo.getByRunId(run.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "https://example.com/page-a");
    assert.equal(rows[0].loadMs, 1234);
    assert.equal(rows[0].fromIframe, false);
    assert.equal(rows[0].iframeSrc, null);
    assert.equal(rows[0].snapshot.title, "Page https://example.com/page-a");
    assert.equal(rows[0].snapshot.elements.length, 2);
    runRepo.hardDeleteById(run.id);
  });

  // ── INSERT OR IGNORE: re-saving same (runId, url) is a no-op ───────────
  await runner.test("save: idempotent on (runId, url) — re-crawl is a no-op", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    const snap = makeSnapshot("https://example.com/dup");
    crawlSnapshotRepo.save(run.id, snap.url, snap, { loadMs: 100 });
    // Re-save with a different loadMs and snapshot payload — the UNIQUE
    // constraint must reject silently rather than throw or overwrite.
    crawlSnapshotRepo.save(run.id, snap.url, { ...snap, title: "Different" }, { loadMs: 999 });
    assert.equal(crawlSnapshotRepo.countByRunId(run.id), 1,
      "second save of the same (runId, url) must not create a duplicate row");
    const rows = crawlSnapshotRepo.getByRunId(run.id);
    assert.equal(rows[0].loadMs, 100, "first-write-wins on duplicate URL");
    assert.equal(rows[0].snapshot.title, "Page https://example.com/dup");
    runRepo.hardDeleteById(run.id);
  });

  // ── save is best-effort on invalid input ───────────────────────────────
  await runner.test("save: invalid input (missing runId / url / snapshot) is silently ignored", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    // Each missing-arg call must early-return without throwing.
    crawlSnapshotRepo.save(null, "u", makeSnapshot("u"));
    crawlSnapshotRepo.save(run.id, "", makeSnapshot("u"));
    crawlSnapshotRepo.save(run.id, "https://example.com/x", null);
    assert.equal(crawlSnapshotRepo.countByRunId(run.id), 0,
      "invalid inputs must not produce rows");
    runRepo.hardDeleteById(run.id);
  });

  // ── getUrlsByRunId is the cheap projection ─────────────────────────────
  await runner.test("getUrlsByRunId: returns URLs in insertion order without deserialising JSON", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    const urls = [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ];
    for (const u of urls) {
      crawlSnapshotRepo.save(run.id, u, makeSnapshot(u), { loadMs: 50 });
    }
    const fetched = crawlSnapshotRepo.getUrlsByRunId(run.id);
    assert.deepEqual(fetched, urls);
    runRepo.hardDeleteById(run.id);
  });

  // ── getLoadTimesByRunId feeds B2's adaptive timeout ────────────────────
  await runner.test("getLoadTimesByRunId: excludes NULL loadMs rows for percentile math", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    crawlSnapshotRepo.save(run.id, "https://example.com/fast",  makeSnapshot("https://example.com/fast"),  { loadMs: 100 });
    crawlSnapshotRepo.save(run.id, "https://example.com/slow",  makeSnapshot("https://example.com/slow"),  { loadMs: 5000 });
    // No loadMs — this row must NOT appear in the load-times array.
    crawlSnapshotRepo.save(run.id, "https://example.com/blank", makeSnapshot("https://example.com/blank"));
    const times = crawlSnapshotRepo.getLoadTimesByRunId(run.id);
    assert.equal(times.length, 2, "NULL loadMs rows must be excluded");
    assert.ok(times.includes(100));
    assert.ok(times.includes(5000));
    runRepo.hardDeleteById(run.id);
  });

  // ── iframe metadata round-trip ─────────────────────────────────────────
  await runner.test("save: iframe metadata (fromIframe + iframeSrc) round-trips", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    crawlSnapshotRepo.save(
      run.id,
      "https://example.com/with-iframe",
      makeSnapshot("https://example.com/with-iframe"),
      { loadMs: 200, fromIframe: true, iframeSrc: "https://widget.example.com/embed" },
    );
    const rows = crawlSnapshotRepo.getByRunId(run.id);
    assert.equal(rows[0].fromIframe, true);
    assert.equal(rows[0].iframeSrc, "https://widget.example.com/embed");
    runRepo.hardDeleteById(run.id);
  });

  // ── deleteByRunId on the purge path ────────────────────────────────────
  await runner.test("deleteByRunId: removes every row for a run", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    for (let i = 0; i < 5; i++) {
      const u = `https://example.com/del-${i}`;
      crawlSnapshotRepo.save(run.id, u, makeSnapshot(u), { loadMs: 50 });
    }
    assert.equal(crawlSnapshotRepo.countByRunId(run.id), 5);
    const deleted = crawlSnapshotRepo.deleteByRunId(run.id);
    assert.equal(deleted, 5);
    assert.equal(crawlSnapshotRepo.countByRunId(run.id), 0);
    runRepo.hardDeleteById(run.id);
  });

  // ── deleteByRunIds: batch purge across multiple runs ───────────────────
  await runner.test("deleteByRunIds: batch delete across multiple runs", () => {
    // Each run needs its own project — `idx_runs_one_active_per_project`
    // (partial UNIQUE index from migration 002) enforces at most one
    // status='running' run per projectId, so two `running` runs against
    // the shared `project` would trip the constraint.
    const p1 = makeProject();
    const p2 = makeProject();
    projectRepo.create(p1);
    projectRepo.create(p2);
    const r1 = makeRun(p1.id);
    const r2 = makeRun(p2.id);
    runRepo.create(r1);
    runRepo.create(r2);
    crawlSnapshotRepo.save(r1.id, "https://example.com/r1-a", makeSnapshot("https://example.com/r1-a"));
    crawlSnapshotRepo.save(r1.id, "https://example.com/r1-b", makeSnapshot("https://example.com/r1-b"));
    crawlSnapshotRepo.save(r2.id, "https://example.com/r2-a", makeSnapshot("https://example.com/r2-a"));
    assert.equal(crawlSnapshotRepo.deleteByRunIds([r1.id, r2.id]), 3);
    assert.equal(crawlSnapshotRepo.countByRunId(r1.id), 0);
    assert.equal(crawlSnapshotRepo.countByRunId(r2.id), 0);
    // Empty-input guard: must not throw or run a malformed SQL statement.
    assert.equal(crawlSnapshotRepo.deleteByRunIds([]), 0);
    runRepo.hardDeleteById(r1.id);
    runRepo.hardDeleteById(r2.id);
  });

  resetDb();
  runner.summary("crawl-snapshot-streaming");
}

main().catch((err) => {
  console.error("❌ crawl-snapshot-streaming failed:", err);
  process.exit(1);
});

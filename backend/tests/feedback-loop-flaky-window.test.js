/**
 * Bundle-A fix #10 — `detectFlakyTests` must bound its scan to the most
 * recent N runs (default 50) instead of walking the entire project
 * history every call. Pre-fix the O(runs × results) loop scanned every
 * non-deleted run for the project, spiking CPU on long-lived projects.
 *
 * Strategy: seed > 50 runs for a fresh project, with the OLDEST 51 runs
 * containing a flip-flop (pass + fail of testId `t-old`) and the NEWEST
 * 50 runs all-passing. The capped scan must NOT see `t-old` as flaky;
 * the uncapped escape hatch (`maxRuns: 0`) must see it.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();

const { detectFlakyTests } = await import("../src/pipeline/feedbackLoop.js");

const PROJECT_ID = "PRJ-FLAKY-WINDOW";

// Seed `runs` rows directly (bypass repo helpers — we need precise control
// over `startedAt` ordering). `runs.results` is a JSON-stringified array
// of `{ testId, status }` rows.
function seedRun({ id, daysAgo, results }) {
  const db = getDatabase();
  const startedAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
  db.prepare(
    `INSERT INTO runs (id, projectId, type, status, startedAt, results, retryCount, failedAfterRetry, secretScanBlocked)
     VALUES (?, ?, 'test_run', 'completed', ?, ?, 0, 0, 0)`,
  ).run(id, PROJECT_ID, startedAt, JSON.stringify(results));
}

// Clean slate so prior tests' seeded rows don't pollute results.
getDatabase().prepare("DELETE FROM runs WHERE projectId = ?").run(PROJECT_ID);
// Seed project rows so the FK on runs.projectId is satisfied.
// projects table (migration 001) has: id, name, url, credentials, status, createdAt, deletedAt.
// No updatedAt or workspaceId in the base schema — those are added by later migrations
// but as nullable columns, so omitting them is safe.
try {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT OR IGNORE INTO projects (id, name, url, createdAt)
     VALUES (?, ?, ?, ?)`,
  ).run(PROJECT_ID, "Flaky Window Test Project", "http://app.example.test", now);
  getDatabase().prepare(
    `INSERT OR IGNORE INTO projects (id, name, url, createdAt)
     VALUES (?, ?, ?, ?)`,
  ).run("PRJ-FLAKY-WINDOW-SMALL", "Small Project", "http://app.example.test", now);
} catch { /* may already exist from a prior test run */ }

// 51 OLD runs (days 51..101): `t-old` flip-flops (alternates pass/fail).
for (let i = 0; i < 51; i += 1) {
  const status = i % 2 === 0 ? "passed" : "failed";
  seedRun({
    id: `RUN-OLD-${i}`,
    daysAgo: 51 + i, // 51, 52, …, 101
    results: [{ testId: "t-old", status }],
  });
}
// 50 NEW runs (days 0..49): all passes for both `t-old` AND `t-new`.
// `t-new` only appears in the new window so it's irrelevant to flakiness
// — included to prove the function still counts new-window tests.
for (let i = 0; i < 50; i += 1) {
  seedRun({
    id: `RUN-NEW-${i}`,
    daysAgo: i, // 0, 1, …, 49 — all newer than every OLD run.
    results: [
      { testId: "t-old", status: "passed" },
      { testId: "t-new", status: "passed" },
    ],
  });
}

test("detectFlakyTests respects the default 50-run cap (old flakiness invisible)", () => {
  const flaky = detectFlakyTests(PROJECT_ID);
  // `t-old` flip-flopped only in the OLDEST 51 runs. With the default
  // 50-run cap, the scan window only sees all-pass results for `t-old`,
  // so it is NOT classified as flaky.
  assert.equal(
    flaky.has("t-old"),
    false,
    `t-old should NOT be flaky inside the 50-run window; got ${JSON.stringify(Array.from(flaky.keys()))}`,
  );
});

test("detectFlakyTests with maxRuns=0 sees the full history (old flakiness visible)", () => {
  // Escape hatch — admin tools that need the unabridged view pass
  // `maxRuns: 0` (or any non-positive number). Pre-fix behaviour.
  const flaky = detectFlakyTests(PROJECT_ID, { maxRuns: 0 });
  assert.equal(
    flaky.has("t-old"),
    true,
    `t-old must be flaky when the cap is disabled (full history scan)`,
  );
  const entry = flaky.get("t-old");
  assert.ok(entry.passCount > 0, "passes counted");
  assert.ok(entry.failCount > 0, "fails counted");
});

test("detectFlakyTests with custom maxRuns surfaces flakiness at the boundary", () => {
  // Bump the cap past the all-pass window so the scan reaches the
  // OLDEST flip-flop runs. 50 newest + at least 1 old run is enough
  // to see a single fail; the OLDEST run at index 0 within the OLD
  // batch (daysAgo=51, status="passed") is hit at maxRuns=51 → not
  // enough. The first fail lands at OLD index 1 (daysAgo=52) so
  // maxRuns=52 reliably reaches it.
  const flaky = detectFlakyTests(PROJECT_ID, { maxRuns: 52 });
  assert.equal(flaky.has("t-old"), true, "t-old becomes flaky once the cap reaches the fail row");
});

test("detectFlakyTests bounds the scan even on fewer-than-cap projects", () => {
  // Negative-path / no-regression: a project with FEWER than `maxRuns`
  // runs scans all of them — the cap is an UPPER bound, not a fixed
  // window size.
  const SMALL = "PRJ-FLAKY-WINDOW-SMALL";
  const db = getDatabase();
  db.prepare("DELETE FROM runs WHERE projectId = ?").run(SMALL);
  const startedAt = new Date(Date.now() - 3 * 86400000).toISOString();
  db.prepare(
    `INSERT INTO runs (id, projectId, type, status, startedAt, results, retryCount, failedAfterRetry, secretScanBlocked)
     VALUES (?, ?, 'test_run', 'completed', ?, ?, 0, 0, 0)`,
  ).run("RUN-SMALL-1", SMALL, startedAt, JSON.stringify([{ testId: "t1", status: "passed" }]));
  db.prepare(
    `INSERT INTO runs (id, projectId, type, status, startedAt, results, retryCount, failedAfterRetry, secretScanBlocked)
     VALUES (?, ?, 'test_run', 'completed', ?, ?, 0, 0, 0)`,
  ).run("RUN-SMALL-2", SMALL, new Date(Date.now() - 86400000).toISOString(), JSON.stringify([{ testId: "t1", status: "failed" }]));

  const flaky = detectFlakyTests(SMALL); // default 50, but only 2 runs exist
  assert.equal(flaky.has("t1"), true, "two-run project with one pass + one fail is flaky regardless of cap");
});

console.log("✅ feedback-loop-flaky-window tests passed");

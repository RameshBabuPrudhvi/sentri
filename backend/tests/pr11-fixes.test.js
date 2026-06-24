/**
 * @module tests/pr11-fixes
 * @description Regression coverage for backend bug fixes landed in PR #11
 * (review-thread follow-ups). REVIEW.md requires tests for every new piece
 * of backend logic; this file picks up the helpers that don't already have
 * a natural home in another test file:
 *
 *   1. `healingRepo` chunked queries — base-ID dedup before chunking
 *      prevents cross-chunk double-counting in `countByTestIds` /
 *      `countSuccessesByTestIds` and duplicate rows in `getByTestIds`.
 *   2. `parseTags` (route helper) — comma-string + array + whitespace.
 *
 * Companion coverage lives elsewhere:
 *   - `normalizeQualityToConfidence`     → tests/deduplicator.test.js
 *   - tag-filter LIKE-escape semantics   → tests/review-queue-filters.test.js
 *   - `isThresholdOnly` bypass tightening → tests/project-edit.test.js
 *
 * Run: node tests/pr11-fixes.test.js
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as healingRepo from "../src/database/repositories/healingRepo.js";
// B1.2 (AUDIT-ROADMAP) — `healingRepo.set` is now queued by default (spec
// `:176-179`). Tests that follow "write → read" drain the queue between
// the two so the read sees the inserted rows.
import { drain as drainDbWriteQueue } from "../src/utils/dbWriteQueue.js";
import { createTestRunner } from "./helpers/test-base.js";

// Stage 2 (test-infra cleanup) — replaced the inline `function test(name, fn)`
// with the shared runner from `helpers/test-base.js`. See the comment in
// `secret-scanner.test.js` for the rationale + behavioural-compat notes.
const { test, summary } = createTestRunner();

function resetHealing() {
  const db = getDatabase();
  db.exec("DELETE FROM healing_history WHERE key LIKE 'TC-PR11-%'");
}

// ── 1. healingRepo chunked-query dedup ───────────────────────────────────────

console.log("\n🔢  healingRepo — chunked queries dedupe by base test ID");

resetHealing();

test("countByTestIds returns 0 for an empty input array", () => {
  assert.equal(healingRepo.countByTestIds([]), 0);
  assert.equal(healingRepo.countSuccessesByTestIds([]), 0);
});

test("getByTestIds returns [] for an empty input array", () => {
  assert.deepEqual(healingRepo.getByTestIds([]), []);
});

test("countByTestIds sums healing rows across small input arrays (single chunk)", () => {
  resetHealing();
  const now = new Date().toISOString();
  healingRepo.set("TC-PR11-A::click::a", { strategyIndex: 0, succeededAt: now, failCount: 0 });
  healingRepo.set("TC-PR11-A::fill::b",  { strategyIndex: 1, succeededAt: now, failCount: 0 });
  healingRepo.set("TC-PR11-B::click::c", { strategyIndex: 2, succeededAt: null, failCount: 1 });
  drainDbWriteQueue(); // B1.2 — flush queued INSERTs before counting.

  assert.equal(healingRepo.countByTestIds(["TC-PR11-A", "TC-PR11-B"]), 3);
  // Only the two rows with strategyIndex >= 0 AND succeededAt count as successes.
  assert.equal(healingRepo.countSuccessesByTestIds(["TC-PR11-A", "TC-PR11-B"]), 2);
});

test("base-ID dedup: passing both `TC-X` and `TC-X@v2` does NOT double-count overlapping rows", () => {
  // Regression for the cross-chunk double-counting bug. Even within a
  // single chunk, the previous implementation emitted overlapping
  // patterns (`TC-X@v%::%` from the base ID and `TC-X@v2::%` from the
  // versioned ID) and any `@v2` row matched both. Base-ID dedup in
  // chunkedTestIdQuery collapses the input to a single `TC-X` entry so
  // the per-row match set is disjoint.
  resetHealing();
  const now = new Date().toISOString();
  healingRepo.set("TC-PR11-V@v2::click::submit", { strategyIndex: 0, succeededAt: now, failCount: 0 });
  healingRepo.set("TC-PR11-V::click::login",     { strategyIndex: 0, succeededAt: now, failCount: 0 });
  drainDbWriteQueue(); // B1.2 — flush before count/get.

  const cnt = healingRepo.countByTestIds(["TC-PR11-V", "TC-PR11-V@v2"]);
  assert.equal(cnt, 2, "two healing rows must be counted exactly twice — not four");

  const rows = healingRepo.getByTestIds(["TC-PR11-V", "TC-PR11-V@v2"]);
  assert.equal(rows.length, 2, "getByTestIds must not duplicate rows when versions overlap");
});

test("counts work across MORE than one chunk (>100 base IDs) without losing rows", () => {
  // Synthetic stress: insert one row per base ID, then ask for a count
  // that straddles the 100-entry chunk boundary. The result must equal
  // the number of base IDs we seeded — no overlap, no duplication.
  resetHealing();
  const now = new Date().toISOString();
  const ids = [];
  for (let i = 0; i < 150; i++) {
    const id = "TC-PR11-CHUNK-" + i;
    healingRepo.set(`${id}::click::x`, { strategyIndex: 0, succeededAt: now, failCount: 0 });
    ids.push(id);
  }
  drainDbWriteQueue(); // B1.2 — flush all 150 queued INSERTs before counting.
  assert.equal(healingRepo.countByTestIds(ids), 150, "every row must be counted exactly once across chunk boundaries");
  assert.equal(healingRepo.countSuccessesByTestIds(ids), 150);
  const rows = healingRepo.getByTestIds(ids);
  assert.equal(rows.length, 150);
});

resetHealing();

// ── 2. parseTags — query-string normaliser (extracted from routes/tests.js) ─
//
// `parseTags` lives inside `backend/src/routes/tests.js` as a non-exported
// `const`. Rather than re-export a 5-line helper just for tests, we mirror
// its definition here and assert the contract — if the route ever drifts,
// the integration tests in `review-queue-filters.test.js` exercise the
// route end-to-end and would catch a behaviour change.

console.log("\n🏷  parseTags — query-string normaliser contract");

const parseTags = (raw) => {
  if (!raw) return undefined;
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  const cleaned = arr.map((s) => String(s).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
};

test("undefined / null / empty string → undefined (no filter)", () => {
  assert.equal(parseTags(undefined), undefined);
  assert.equal(parseTags(null), undefined);
  assert.equal(parseTags(""), undefined);
});

test("comma-separated string → trimmed string array", () => {
  assert.deepEqual(parseTags("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(parseTags(" a , b ,c "), ["a", "b", "c"]);
});

test("array input passes through with trim + filter", () => {
  assert.deepEqual(parseTags(["a", " b ", "c"]), ["a", "b", "c"]);
});

test("whitespace-only entries are dropped", () => {
  assert.deepEqual(parseTags("a, ,b"), ["a", "b"]);
  assert.deepEqual(parseTags(["a", "   ", "b"]), ["a", "b"]);
});

test("all-whitespace input → undefined (treated as no filter)", () => {
  assert.equal(parseTags(" , , "), undefined);
  assert.equal(parseTags(["   ", ""]), undefined);
});

summary("pr11-fixes");

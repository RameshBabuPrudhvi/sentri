/**
 * @module tests/command-palette
 * @description Unit tests for the command palette fuzzy-match utility.
 * Runs with plain Node.js (no framework) — matches project test convention.
 *
 * Usage: node frontend/tests/command-palette.test.js
 */

import assert from "node:assert/strict";

// ── Helpers ──────────────────────────────────────────────────────────────────
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705  ${name}`);
  } catch (err) {
    console.log(`  \u274C  ${name}`);
    console.log(`      ${err.message}`);
    process.exitCode = 1;
  }
}

// ── Import ───────────────────────────────────────────────────────────────────
import fuzzyMatch from "../src/utils/fuzzyMatch.js";

// ═══════════════════════════════════════════════════════════════════════════════
// fuzzyMatch — basic matching
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n\uD83E\uDDEA fuzzyMatch — basic matching");

test("empty query matches everything", () => {
  const r = fuzzyMatch("", "Go to Dashboard");
  assert.equal(r.match, true);
  assert.equal(r.score, 0);
  assert.deepEqual(r.ranges, []);
});

test("exact match returns true", () => {
  const r = fuzzyMatch("dashboard", "Dashboard");
  assert.equal(r.match, true);
});

test("case-insensitive matching", () => {
  const r = fuzzyMatch("DASH", "Go to Dashboard");
  assert.equal(r.match, true);
});

test("non-matching query returns false", () => {
  const r = fuzzyMatch("xyz", "Dashboard");
  assert.equal(r.match, false);
  assert.equal(r.score, Infinity);
  assert.deepEqual(r.ranges, []);
});

test("partial match fails when not all chars found", () => {
  const r = fuzzyMatch("dashz", "Dashboard");
  assert.equal(r.match, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// fuzzyMatch — scoring
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n\uD83E\uDDEA fuzzyMatch — scoring");

test("prefix match scores better than mid-string match", () => {
  const prefix = fuzzyMatch("go", "Go to Dashboard");
  const mid = fuzzyMatch("go", "Mongo Database");
  assert.ok(prefix.match);
  assert.ok(mid.match);
  assert.ok(prefix.score < mid.score, `prefix ${prefix.score} should be < mid ${mid.score}`);
});

test("exact substring match scores better than scattered chars", () => {
  const substr = fuzzyMatch("test", "Go to Tests");
  const scattered = fuzzyMatch("test", "The extra settings");
  assert.ok(substr.match);
  assert.ok(scattered.match);
  assert.ok(substr.score < scattered.score, `substr ${substr.score} should be < scattered ${scattered.score}`);
});

test("shorter text with same match scores better (less gap)", () => {
  const short = fuzzyMatch("set", "Settings");
  const long = fuzzyMatch("set", "Some extra things");
  assert.ok(short.match);
  assert.ok(long.match);
  assert.ok(short.score <= long.score, `short ${short.score} should be <= long ${long.score}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// fuzzyMatch — ranges for highlighting
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n\uD83E\uDDEA fuzzyMatch — highlight ranges");

test("contiguous match returns single range", () => {
  const r = fuzzyMatch("dash", "Dashboard");
  assert.equal(r.match, true);
  assert.deepEqual(r.ranges, [[0, 3]]);
});

test("scattered match returns multiple ranges", () => {
  const r = fuzzyMatch("gt", "Go to Tests");
  assert.equal(r.match, true);
  assert.ok(r.ranges.length >= 1, "Expected at least 1 range");
  // Verify ranges are within bounds
  for (const [s, e] of r.ranges) {
    assert.ok(s >= 0 && e < "Go to Tests".length, `Range [${s},${e}] out of bounds`);
    assert.ok(s <= e, `Range start ${s} should be <= end ${e}`);
  }
});

test("full-word match returns correct range", () => {
  const r = fuzzyMatch("settings", "Settings");
  assert.equal(r.match, true);
  assert.deepEqual(r.ranges, [[0, 7]]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// fuzzyMatch — edge cases
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n\uD83E\uDDEA fuzzyMatch — edge cases");

test("single character query", () => {
  const r = fuzzyMatch("d", "Dashboard");
  assert.equal(r.match, true);
  assert.deepEqual(r.ranges, [[0, 0]]);
});

test("query same length as text", () => {
  const r = fuzzyMatch("abc", "abc");
  assert.equal(r.match, true);
  assert.deepEqual(r.ranges, [[0, 2]]);
});

test("query longer than text fails", () => {
  const r = fuzzyMatch("abcdef", "abc");
  assert.equal(r.match, false);
});

test("special characters in query", () => {
  const r = fuzzyMatch("c++", "C++ Compiler");
  assert.equal(r.match, true);
});

test("spaces in query match spaces in text", () => {
  const r = fuzzyMatch("go to", "Go to Dashboard");
  assert.equal(r.match, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════
if (process.exitCode) {
  console.log("\n\u26A0\uFE0F  Some command palette tests failed");
  process.exit(1);
}
console.log("\n\uD83C\uDF89 All command palette tests passed");

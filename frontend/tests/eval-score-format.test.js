/**
 * @module tests/eval-score-format
 * @description Unit tests for AUTO-022's `formatScore` + `getScoreClass`
 * helpers (`frontend/src/utils/evalScoreFormat.js`).
 *
 * These helpers drive the `ScoreBadge` in `EvalPanel.jsx` — they pick the
 * green/amber/red colour-tier and format the percentage label. Bugs here
 * silently corrupt the very surface the AUTO-022 eval harness is supposed
 * to make trustworthy, so the tier-boundary assertions (0.8 / 0.5 cutoffs)
 * are intentionally exhaustive.
 *
 * Plain Node assertions, no framework — matches the existing convention
 * (see `automation-status.test.js`).
 *
 * Usage: node frontend/tests/eval-score-format.test.js
 */

import assert from "node:assert/strict";
import { formatScore, getScoreClass } from "../src/utils/evalScoreFormat.js";

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

// ── formatScore ──────────────────────────────────────────────────────────────
console.log("\n\uD83E\uDDEA formatScore");

test("formats 0.85 → '85.0%' (one-decimal, percent suffix)", () => {
  assert.equal(formatScore(0.85), "85.0%");
});
test("formats 1.0 → '100.0%' (upper bound)", () => {
  assert.equal(formatScore(1.0), "100.0%");
});
test("formats 0 → '0.0%' (lower bound, NOT em-dash)", () => {
  // Regression: a naive `if (!value)` would render 0 as the placeholder.
  // Eval scores can legitimately be exactly 0 when the generator emits no
  // matching tuples — that's signal, not absence.
  assert.equal(formatScore(0), "0.0%");
});
test("formats 0.123456 → '12.3%' (rounds to one decimal)", () => {
  assert.equal(formatScore(0.123456), "12.3%");
});
test("returns em-dash for null", () => {
  assert.equal(formatScore(null), "\u2014");
});
test("returns em-dash for undefined", () => {
  assert.equal(formatScore(undefined), "\u2014");
});
test("returns em-dash for NaN", () => {
  assert.equal(formatScore(Number.NaN), "\u2014");
});

// ── getScoreClass ────────────────────────────────────────────────────────────
console.log("\n\uD83E\uDDEA getScoreClass");

test("returns 'good' for 1.0 (top of range)", () => {
  assert.equal(getScoreClass(1.0), "dash-eval-score--good");
});
test("returns 'good' at the 0.8 boundary (inclusive)", () => {
  assert.equal(getScoreClass(0.8), "dash-eval-score--good");
});
test("returns 'warn' just below the good boundary (0.79)", () => {
  assert.equal(getScoreClass(0.79), "dash-eval-score--warn");
});
test("returns 'warn' at the 0.5 boundary (inclusive)", () => {
  assert.equal(getScoreClass(0.5), "dash-eval-score--warn");
});
test("returns 'bad' just below the warn boundary (0.49)", () => {
  assert.equal(getScoreClass(0.49), "dash-eval-score--bad");
});
test("returns 'bad' for 0 (lower bound — NOT 'none')", () => {
  // Regression: 0 is a valid score (pipeline emitted nothing matching).
  // Treating it as null would hide the worst-case signal.
  assert.equal(getScoreClass(0), "dash-eval-score--bad");
});
test("returns 'none' for null", () => {
  assert.equal(getScoreClass(null), "dash-eval-score--none");
});
test("returns 'none' for undefined", () => {
  assert.equal(getScoreClass(undefined), "dash-eval-score--none");
});
test("returns 'none' for NaN", () => {
  assert.equal(getScoreClass(Number.NaN), "dash-eval-score--none");
});

// ── Summary ──────────────────────────────────────────────────────────────────
if (process.exitCode) {
  console.log("\n\u26A0\uFE0F  Some eval-score-format tests failed");
  process.exit(1);
}
console.log("\n\uD83C\uDF89 All eval-score-format tests passed");

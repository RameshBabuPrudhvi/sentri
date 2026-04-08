/**
 * @module tests/self-healing
 * @description Regression checks for self-healing runtime selector handling.
 */

import assert from "node:assert/strict";
import { getSelfHealingHelperCode } from "../src/selfHealing.js";

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n🩹 self-healing runtime checks");

const helpers = getSelfHealingHelperCode({});

test("safeExpect uses exclusive locator-only path for selector-like text", () => {
  // When looksLikeSelector is true, strategies should be [p => p.locator(text)] only
  assert.match(helpers, /looksLikeSelector\(text\)\s*\n\s*\? \[p => p\.locator\(text\)\]/);
  // Should NOT use the spread pattern (which appends to the text-based waterfall)
  assert.doesNotMatch(helpers, /\.\.\.\(looksLikeSelector\(text\) \? \[p => p\.locator\(text\)\] : \[\]\)/);
});

test("safeFill uses exclusive locator-only path for selector-like text", () => {
  assert.match(helpers, /looksLikeSelector\(labelOrPlaceholder\)/);
  assert.match(helpers, /onlyFillable\(p\.locator\(labelOrPlaceholder\)\)/);
  // Should be exclusive branch, not spread into the text-based waterfall
  assert.match(helpers, /looksLikeSelector\(labelOrPlaceholder\)\s*\n\s*\? \[p => onlyFillable/);
});

test("safeClick uses exclusive locator-only path for selector-like text", () => {
  assert.match(helpers, /looksLikeSelector\(text\)\s*\n\s*\? \[p => p\.locator\(text\)\]\s*\n\s*:/);
});

test("selector heuristic does not use broad combinator match", () => {
  assert.doesNotMatch(helpers, /\|\| \/\\\[>~\+\]\/\.test\(s\)/);
});

test("findElement uses firstVisible instead of .first() to skip hidden elements", () => {
  assert.match(helpers, /async function firstVisible\(baseLocator, timeout\)/);
  assert.match(helpers, /await firstVisible\(strategies\[hintIdx\]\(page\), timeout\)/);
  assert.match(helpers, /await firstVisible\(strategies\[i\]\(page\), timeout\)/);
  // .first() should only appear inside firstVisible's fallback, not in findElement directly
  assert.doesNotMatch(helpers, /strategies\[(?:hintIdx|i)\]\(page\)\.first\(\)/);
});

if (process.exitCode) process.exit(1);
console.log("\n🎉 self-healing tests passed");

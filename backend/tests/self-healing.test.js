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

test("safeExpect handles selector-like text via page.locator", () => {
  assert.match(helpers, /\.\.\.\(looksLikeSelector\(text\) \? \[p => p\.locator\(text\)\] : \[\]\)/);
  assert.doesNotMatch(helpers, /if \(looksLikeSelector\(text\)\)\s*\{/);
});

test("safeFill prioritizes selector-like locator strategy", () => {
  assert.match(helpers, /looksLikeSelector\(labelOrPlaceholder\)/);
  assert.match(helpers, /onlyFillable\(p\.locator\(labelOrPlaceholder\)\)/);
});

test("safeClick prioritizes selector-like locator strategy", () => {
  assert.match(helpers, /looksLikeSelector\(text\) \? \[p => p\.locator\(text\)\] : \[\]/);
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

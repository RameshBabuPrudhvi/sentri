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
  assert.match(helpers, /if \(looksLikeSelector\(text\)\)/);
  assert.match(helpers, /page\.locator\(text\)\.first\(\)/);
});

test("safeFill prioritizes selector-like locator strategy", () => {
  assert.match(helpers, /looksLikeSelector\(labelOrPlaceholder\)/);
  assert.match(helpers, /onlyFillable\(p\.locator\(labelOrPlaceholder\)\)/);
});

test("safeClick prioritizes selector-like locator strategy", () => {
  assert.match(helpers, /looksLikeSelector\(text\) \? \[p => p\.locator\(text\)\] : \[\]/);
});

if (process.exitCode) process.exit(1);
console.log("\n🎉 self-healing tests passed");

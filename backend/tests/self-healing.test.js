/**
 * @module tests/self-healing
 * @description Regression checks for self-healing runtime selector handling.
 */

import assert from "node:assert/strict";
import { getSelfHealingHelperCode, SELF_HEALING_PROMPT_RULES } from "../src/selfHealing.js";

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

test("findElement uses tryStrategy wrapper to catch synchronous throws", () => {
  assert.match(helpers, /async function tryStrategy\(strategyFn, page, timeout\)/);
  assert.match(helpers, /await tryStrategy\(strategies\[hintIdx\], page, timeout\)/);
  assert.match(helpers, /await tryStrategy\(strategies\[i\], page, timeout\)/);
});

test("selector heuristic does not use broad combinator match", () => {
  assert.doesNotMatch(helpers, /\|\| \/\\\[>~\+\]\/\.test\(s\)/);
});

test("findElement uses firstVisible inside tryStrategy to skip hidden elements", () => {
  assert.match(helpers, /async function firstVisible\(baseLocator, timeout\)/);
  // firstVisible is called inside tryStrategy, not directly in findElement
  assert.match(helpers, /return await firstVisible\(locator, timeout\)/);
  // .first() should only appear inside firstVisible's fallback, not in findElement directly
  assert.doesNotMatch(helpers, /strategies\[(?:hintIdx|i)\]\(page\)\.first\(\)/);
});

// ── New runtime helpers: safeSelect, safeCheck, safeUncheck ──────────────────

console.log("\n🆕 new runtime helpers");

test("safeSelect function is defined in runtime code", () => {
  assert.match(helpers, /async function safeSelect\(page, labelOrText, value\)/);
});

test("safeCheck function is defined in runtime code", () => {
  assert.match(helpers, /async function safeCheck\(page, labelOrText\)/);
});

test("safeUncheck function is defined in runtime code", () => {
  assert.match(helpers, /async function safeUncheck\(page, labelOrText\)/);
});

test("safeSelect uses combobox and listbox strategies", () => {
  assert.match(helpers, /getByRole\('combobox', \{ name: labelOrText \}\)/);
  assert.match(helpers, /getByRole\('listbox', \{ name: labelOrText \}\)/);
});

test("safeCheck uses checkbox role strategy", () => {
  assert.match(helpers, /getByRole\('checkbox', \{ name: labelOrText \}\)/);
});

test("safeSelect preserves object/array values (no coercion)", () => {
  // The runtime code should have the typeof value === 'object' passthrough
  assert.match(helpers, /typeof value === 'object'/);
});

// ── FIRST_VISIBLE_WAIT_CAP constant ──────────────────────────────────────────

console.log("\n⏱️  FIRST_VISIBLE_WAIT_CAP");

test("FIRST_VISIBLE_WAIT_CAP constant is injected into runtime code", () => {
  assert.match(helpers, /const FIRST_VISIBLE_WAIT_CAP = \d+/);
});

test("firstVisible uses Math.min with FIRST_VISIBLE_WAIT_CAP", () => {
  assert.match(helpers, /Math\.min\(timeout, FIRST_VISIBLE_WAIT_CAP\)/);
});

// ── Healing hints injection ──────────────────────────────────────────────────

console.log("\n📝 healing hints injection");

test("getSelfHealingHelperCode injects provided hints as JSON", () => {
  const withHints = getSelfHealingHelperCode({ "click::Submit": 2, "fill::Email": 0 });
  assert.match(withHints, /"click::Submit":2/);
  assert.match(withHints, /"fill::Email":0/);
});

test("getSelfHealingHelperCode handles null gracefully", () => {
  const withNull = getSelfHealingHelperCode(null);
  assert.match(withNull, /__healingHints = \{\}/);
});

test("getSelfHealingHelperCode handles array gracefully", () => {
  const withArray = getSelfHealingHelperCode([1, 2, 3]);
  assert.match(withArray, /__healingHints = \{\}/);
});

// ── SELF_HEALING_PROMPT_RULES content ────────────────────────────────────────

console.log("\n📜 SELF_HEALING_PROMPT_RULES content");

test("SELF_HEALING_PROMPT_RULES mentions safeSelect", () => {
  assert.match(SELF_HEALING_PROMPT_RULES, /safeSelect/);
});

test("SELF_HEALING_PROMPT_RULES mentions safeCheck", () => {
  assert.match(SELF_HEALING_PROMPT_RULES, /safeCheck/);
});

test("SELF_HEALING_PROMPT_RULES mentions safeUncheck", () => {
  assert.match(SELF_HEALING_PROMPT_RULES, /safeUncheck/);
});

test("SELF_HEALING_PROMPT_RULES lists page.check as forbidden", () => {
  assert.match(SELF_HEALING_PROMPT_RULES, /page\.check/);
});

test("SELF_HEALING_PROMPT_RULES lists page.selectOption as forbidden", () => {
  assert.match(SELF_HEALING_PROMPT_RULES, /page\.selectOption/);
});

test("SELF_HEALING_PROMPT_RULES lists page.locator().check as forbidden", () => {
  assert.match(SELF_HEALING_PROMPT_RULES, /page\.locator\(\.\.\.\)\.check/);
});

if (process.exitCode) process.exit(1);
console.log("\n🎉 self-healing tests passed");

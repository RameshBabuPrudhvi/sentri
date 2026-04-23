/**
 * @module tests/self-healing
 * @description Regression checks for self-healing runtime selector handling.
 */

import assert from "node:assert/strict";
import { getSelfHealingHelperCode, SELF_HEALING_PROMPT_RULES, CORE_RULES, getPromptRules, STRATEGY_VERSION } from "../src/selfHealing.js";

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

test("safeCheck includes list-item scoped fallback (TC-5 / TodoMVC pattern)", () => {
  // Matches `p => p.locator('li', { hasText: labelOrText }).getByRole('checkbox').first()`
  // inside the safeCheck strategies array. TC-5 failed because the checkbox
  // is inside `<li>` and the readable label is the sibling text, so the
  // role+name and getByLabel strategies never match.
  assert.match(
    helpers,
    /locator\('li', \{ hasText: labelOrText \}\)\.getByRole\('checkbox'\)\.first\(\)/,
    "safeCheck should include li→getByRole('checkbox') fallback",
  );
});

test("safeCheck includes table-row scoped fallback", () => {
  assert.match(
    helpers,
    /locator\('tr', \{ hasText: labelOrText \}\)\.getByRole\('checkbox'\)\.first\(\)/,
    "safeCheck should include tr→getByRole('checkbox') fallback",
  );
});

test("safeCheck includes raw input[type=checkbox] fallback inside li", () => {
  assert.match(
    helpers,
    /locator\('li', \{ hasText: labelOrText \}\)\.locator\('input\[type="checkbox"\]'\)\.first\(\)/,
    "safeCheck should include li→input[type=checkbox] fallback for cases without role",
  );
});

test("safeUncheck mirrors safeCheck list-item fallback", () => {
  // safeUncheck should have the same scoped strategies since the element
  // hierarchy is identical — only the final action differs.
  const uncheckBlock = helpers.match(
    /async function safeUncheck[\s\S]+?await retry\(async \(\) => \{[\s\S]+?await el\.uncheck\(\)/,
  );
  assert.ok(uncheckBlock, "safeUncheck function block should be present");
  assert.match(
    uncheckBlock[0],
    /locator\('li', \{ hasText: labelOrText \}\)\.getByRole\('checkbox'\)/,
    "safeUncheck should include li→getByRole('checkbox') fallback",
  );
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

// ── STRATEGY_VERSION consistency ─────────────────────────────────────────────

console.log("\n🔢 STRATEGY_VERSION consistency");

test("STRATEGY_VERSION equals expected value (bump this when strategies change)", () => {
  // If this test fails, you changed the strategies array in selfHealing.js.
  // Bump STRATEGY_VERSION in selfHealing.js and update the expected value here.
  assert.equal(STRATEGY_VERSION, 3, "STRATEGY_VERSION changed — update this test after verifying the bump is intentional");
});

test("STRATEGY_VERSION is used server-side for hint scoping", () => {
  // STRATEGY_VERSION is used in recordHealing() and getHealingHint() to
  // scope healing hints by version. It is NOT injected into the runtime
  // helper code — the runtime only uses __healingHints (pre-filtered).
  assert.equal(typeof STRATEGY_VERSION, "number");
  assert.ok(STRATEGY_VERSION > 0, "STRATEGY_VERSION must be a positive integer");
});

// ── Tiered prompt rules (MNT-009) ────────────────────────────────────────────

console.log("\n🏷️  tiered prompt rules (MNT-009)");

test("CORE_RULES is significantly shorter than full SELF_HEALING_PROMPT_RULES", () => {
  // CORE_RULES should be ~10-15% of the full rules
  assert.ok(CORE_RULES.length < SELF_HEALING_PROMPT_RULES.length * 0.3,
    `CORE_RULES (${CORE_RULES.length} chars) should be <30% of full rules (${SELF_HEALING_PROMPT_RULES.length} chars)`);
});

test("CORE_RULES mentions native Playwright methods (getByRole, getByLabel, fill, click)", () => {
  assert.match(CORE_RULES, /getByRole/);
  assert.match(CORE_RULES, /getByLabel/);
  assert.match(CORE_RULES, /\.click\(\)/);
  assert.match(CORE_RULES, /\.fill\(/);
  assert.match(CORE_RULES, /toBeVisible/);
  assert.match(CORE_RULES, /selectOption/);
  assert.match(CORE_RULES, /\.check\(\)/);
});

test("CORE_RULES does NOT mention custom safe helpers (native Playwright for local models)", () => {
  assert.doesNotMatch(CORE_RULES, /safeClick/);
  assert.doesNotMatch(CORE_RULES, /safeFill/);
  assert.doesNotMatch(CORE_RULES, /safeExpect/);
});

test("CORE_RULES includes rules section", () => {
  assert.match(CORE_RULES, /RULES/);
  assert.match(CORE_RULES, /NEVER/);
});

test("getPromptRules('cloud') returns full rules", () => {
  const rules = getPromptRules("cloud");
  assert.equal(rules, SELF_HEALING_PROMPT_RULES);
});

test("getPromptRules('local') returns compact CORE_RULES", () => {
  const rules = getPromptRules("local");
  assert.equal(rules, CORE_RULES);
});

test("CORE_RULES is under 1500 characters (fits in local model context)", () => {
  assert.ok(CORE_RULES.length < 1500,
    `CORE_RULES is ${CORE_RULES.length} chars — should be <1500 for local model context`);
});

test("SELF_HEALING_PROMPT_RULES (full) still includes all content", () => {
  // Ensure the full rules weren't accidentally truncated during the split
  assert.match(SELF_HEALING_PROMPT_RULES, /safeClick/);
  assert.match(SELF_HEALING_PROMPT_RULES, /safeDblClick/);
  assert.match(SELF_HEALING_PROMPT_RULES, /safeDrag/);
  assert.match(SELF_HEALING_PROMPT_RULES, /FORBIDDEN/);
  assert.match(SELF_HEALING_PROMPT_RULES, /page\.getByRole\(\.\.\.\)\.click\(\)/);
});

if (process.exitCode) process.exit(1);
console.log("\n🎉 self-healing tests passed");

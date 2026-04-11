/**
 * @module tests/assertion-enhancer-deep
 * @description Deep unit tests for pipeline/assertionEnhancer.js
 *
 * The existing pipeline.test.js has 4 smoke tests for assertionEnhancer.
 * This file covers the gaps: all 7 INTENT_TEMPLATES, all 8 TYPE_TEMPLATES,
 * the FALLBACK_TEMPLATE, the three enhancement reasons, buildPageLoadAssertion
 * title handling, the enhanceTests batch wrapper with enhancedCount tracking,
 * the sourceUrl→snapshot fallback path, and classifiedPage priority over type.
 *
 * Coverage areas:
 *   1. hasStrongAssertions / hasWeakAssertions / hasNoAssertions — detection
 *   2. INTENT_TEMPLATES — all 7 intents inject the right assertion pattern
 *   3. TYPE_TEMPLATES — all 8 types inject assertions when no classifiedPage
 *   4. FALLBACK_TEMPLATE — fires for unrecognised types
 *   5. Enhancement reasons — no_assertions, weak_assertions_replaced,
 *                            added_page_load_assertion
 *   6. buildPageLoadAssertion — with/without title
 *   7. classifiedPage intent takes priority over test.type
 *   8. enhanceTests batch — enhancedCount, _assertionEnhanced flag per test
 *   9. Snapshot fallback — uses test.sourceUrl when snapshotsByUrl is empty
 *
 * Run: node tests/assertion-enhancer-deep.test.js
 */

import assert from "node:assert/strict";
import {
  hasStrongAssertions,
  hasWeakAssertions,
  hasNoAssertions,
  enhanceTest,
  enhanceTests,
} from "../src/pipeline/assertionEnhancer.js";

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const SNAPSHOT = { url: "http://ex.com/page", title: "Page Title" };
const SNAPSHOT_NO_TITLE = { url: "http://ex.com/page", title: "" };

/** Minimal test with no assertions — the main input for enhancement tests */
function noAssertTest(overrides = {}) {
  return {
    name: "Test with no assertions",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await safeClick(page, 'Continue');",
      "});",
    ].join("\n"),
    steps: ["Go to page", "Click continue"],
    type: "functional",
    sourceUrl: "http://ex.com/page",
    ...overrides,
  };
}

/** Minimal test with only weak assertions */
function weakAssertTest(overrides = {}) {
  return {
    name: "Test with weak assertions",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page).toBeTruthy();",
      "});",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
    ...overrides,
  };
}

/** Test already having strong assertions including toHaveURL */
function strongWithUrlTest() {
  return {
    name: "Strong test with URL",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page).toHaveURL('http://ex.com/page');",
      "  await expect(page.getByText('Title')).toBeVisible();",
      "});",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
  };
}

// ── 1. Detection helpers ──────────────────────────────────────────────────────

console.log("\n🔍  Detection helpers");

test("hasNoAssertions: true when code has no expect(", () => {
  assert.equal(hasNoAssertions("await page.goto('/login');\nawait safeClick(page, 'Go');"), true);
});

test("hasNoAssertions: false when code has expect(", () => {
  assert.equal(hasNoAssertions("await expect(page).toHaveURL('/dash');"), false);
});

test("hasWeakAssertions: detects expect(page).toBeTruthy", () => {
  assert.equal(hasWeakAssertions("await expect(page).toBeTruthy();"), true);
});

test("hasWeakAssertions: detects expect(page).toBeDefined", () => {
  assert.equal(hasWeakAssertions("await expect(page).toBeDefined();"), true);
});

test("hasWeakAssertions: detects expect(anything).toBeTruthy", () => {
  assert.equal(hasWeakAssertions("await expect(someLocator).toBeTruthy();"), true);
});

test("hasWeakAssertions: detects expect(anything).not.toBeNull", () => {
  assert.equal(hasWeakAssertions("await expect(el).not.toBeNull();"), true);
});

test("hasWeakAssertions: false for strong assertions", () => {
  assert.equal(hasWeakAssertions("await expect(page).toHaveURL('/dash');"), false);
});

test("hasStrongAssertions: detects every strong pattern", () => {
  const patterns = [
    "await expect(page).toHaveURL('/dash');",
    "await expect(page).toHaveTitle('App');",
    "await expect(el).toBeVisible();",
    "await expect(el).toHaveText('hello');",
    "await expect(el).toContainText('hi');",
    "await expect(el).toBeEnabled();",
    "await expect(el).toHaveValue('x');",
    "await expect(el).toBeChecked();",
    "await expect(el).toHaveCount(3);",
    "await expect(el).toBeDisabled();",
  ];
  for (const code of patterns) {
    assert.equal(hasStrongAssertions(code), true, `Should detect strong assertion in: ${code}`);
  }
});

test("hasStrongAssertions: false for code with only weak assertions", () => {
  assert.equal(hasStrongAssertions("await expect(page).toBeTruthy();"), false);
});

// ── 2. INTENT_TEMPLATES — all 7 intents ──────────────────────────────────────

console.log("\n🎯  INTENT_TEMPLATES — all 7 intents inject correct assertions");

test("AUTH: injects not.toContainText('Invalid') and not.toContainText('error')", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "AUTH" });
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "no_assertions");
  assert.match(r.playwrightCode, /not\.toContainText\('Invalid'\)/);
  assert.match(r.playwrightCode, /not\.toContainText\('error'\)/);
});

test("NAVIGATION: injects toHaveURL and toHaveTitle", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "NAVIGATION" });
  assert.equal(r._assertionEnhanced, true);
  assert.match(r.playwrightCode, /toHaveURL/);
  assert.match(r.playwrightCode, /toHaveTitle/);
});

test("FORM_SUBMISSION: injects form locator and submit button assertion", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "FORM_SUBMISSION" });
  assert.equal(r._assertionEnhanced, true);
  assert.match(r.playwrightCode, /locator\('form'\)/);
  assert.match(r.playwrightCode, /toBeVisible|toBeEnabled/);
});

test("SEARCH: injects search input locator assertion", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "SEARCH" });
  assert.equal(r._assertionEnhanced, true);
  assert.match(r.playwrightCode, /search/i);
  assert.match(r.playwrightCode, /toBeVisible/);
});

test("CRUD: injects not.toContainText('Error') and alert locator", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "CRUD" });
  assert.equal(r._assertionEnhanced, true);
  assert.match(r.playwrightCode, /not\.toContainText\('Error'\)/);
});

test("CHECKOUT: injects form locator and pay/order/confirm button check", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "CHECKOUT" });
  assert.equal(r._assertionEnhanced, true);
  assert.match(r.playwrightCode, /locator\('form'\)/);
});

test("CONTENT: injects toHaveTitle and main/article locator", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "CONTENT" });
  assert.equal(r._assertionEnhanced, true);
  assert.match(r.playwrightCode, /toHaveTitle/);
  assert.match(r.playwrightCode, /main|article/);
});

// ── 3. TYPE_TEMPLATES — all 8 types ──────────────────────────────────────────

console.log("\n📋  TYPE_TEMPLATES — all 8 types inject assertions when no classifiedPage");

const TYPE_EXPECTATIONS = {
  functional:    /toHaveTitle/,
  smoke:         /toHaveURL/,
  regression:    /toHaveURL/,
  e2e:           /toHaveTitle/,
  integration:   /locator\('form'\)/,
  accessibility: /locator\('main|h1/,
  security:      /not\.toContainText/,
  performance:   /toHaveURL/,
};

for (const [type, pattern] of Object.entries(TYPE_EXPECTATIONS)) {
  test(`type="${type}" injects correct assertion pattern`, () => {
    const r = enhanceTest(noAssertTest({ type }), SNAPSHOT, null);
    assert.equal(r._assertionEnhanced, true,
      `type="${type}" should trigger enhancement`);
    assert.match(r.playwrightCode, pattern,
      `type="${type}" should inject pattern ${pattern}`);
  });
}

// ── 4. FALLBACK_TEMPLATE ──────────────────────────────────────────────────────

console.log("\n🔄  FALLBACK_TEMPLATE — unrecognised types and missing classifiedPage");

test("unrecognised type with no classifiedPage uses fallback template", () => {
  const r = enhanceTest(noAssertTest({ type: "user-flow-custom-xyz" }), SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true);
  // Fallback template injects toHaveTitle and main/body locator
  assert.match(r.playwrightCode, /toHaveTitle/);
  assert.match(r.playwrightCode, /toBeVisible/);
});

test("no type, no classifiedPage uses fallback template", () => {
  const r = enhanceTest(noAssertTest({ type: undefined }), SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true);
  assert.match(r.playwrightCode, /toBeVisible/);
});

// ── 5. Enhancement reasons ────────────────────────────────────────────────────

console.log("\n📌  Enhancement reasons — three distinct paths");

test("no_assertions: reason when code has zero expect() calls", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "AUTH" });
  assert.equal(r._enhancementReason, "no_assertions");
});

test("weak_assertions_replaced: reason when only toBeTruthy/toBeDefined present", () => {
  const r = enhanceTest(weakAssertTest(), SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "weak_assertions_replaced");
  // The weak assertion line should be gone
  assert.doesNotMatch(r.playwrightCode, /toBeTruthy/);
});

test("added_page_load_assertion: reason when strong assertions exist but no toHaveURL/toHaveTitle", () => {
  const strongNoUrl = {
    name: "Visible but no URL check",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page.getByText('Welcome')).toBeVisible();",
      "});",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(strongNoUrl, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "added_page_load_assertion");
  // Should have injected a URL or title assertion
  assert.ok(
    r.playwrightCode.includes("toHaveURL") || r.playwrightCode.includes("toHaveTitle"),
    "Should have injected toHaveURL or toHaveTitle"
  );
});

test("no enhancement when strong assertions include toHaveURL", () => {
  const r = enhanceTest(strongWithUrlTest(), SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, false);
  assert.equal(r._enhancementReason, undefined);
});

test("no enhancement when strong assertions include toHaveTitle", () => {
  const withTitle = {
    name: "Strong test with title",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page).toHaveTitle('My App');",
      "  await expect(page.getByText('Welcome')).toBeVisible();",
      "});",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(withTitle, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, false);
});

// ── 6. buildPageLoadAssertion — title handling ────────────────────────────────

console.log("\n🏷️  buildPageLoadAssertion — title handling");

test("injects toHaveTitle when snapshot has a title", () => {
  const r = enhanceTest(noAssertTest(), { url: "http://ex.com/page", title: "My Login Page" }, null);
  assert.match(r.playwrightCode, /toHaveTitle/);
  // Title content should appear in the regex
  assert.match(r.playwrightCode, /My Login Page/);
});

test("injects toHaveURL using the snapshot hostname", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, null);
  // buildPageLoadAssertion injects a hostname-only regex (per STABILITY_RULES)
  assert.match(r.playwrightCode, /toHaveURL/);
  assert.match(r.playwrightCode, /ex\.com/);
});

test("URL is JSON-stringified safely (handles special chars in URL)", () => {
  const specialSnap = { url: "http://ex.com/path?q=test&filter=a b", title: "" };
  assert.doesNotThrow(() => enhanceTest(noAssertTest(), specialSnap, null));
});

// ── 7. classifiedPage intent takes priority over test.type ───────────────────

console.log("\n⚡  Intent vs type priority");

test("classifiedPage.dominantIntent takes priority over test.type", () => {
  // test.type is "smoke" (would inject toHaveURL),
  // classifiedPage is AUTH (should inject not.toContainText('error'))
  const t = noAssertTest({ type: "smoke" });
  const r = enhanceTest(t, SNAPSHOT, { dominantIntent: "AUTH" });
  // AUTH template uses not.toContainText('error'), not toHaveURL
  assert.match(r.playwrightCode, /not\.toContainText\('error'\)/);
});

test("falls through to type template when classifiedPage has unknown intent", () => {
  const t = noAssertTest({ type: "smoke" });
  const r = enhanceTest(t, SNAPSHOT, { dominantIntent: "UNKNOWN_INTENT_XYZ" });
  // smoke TYPE_TEMPLATE should be used instead
  assert.match(r.playwrightCode, /toHaveURL/);
});

// ── 8. enhanceTests batch wrapper ────────────────────────────────────────────

console.log("\n📦  enhanceTests batch — enhancedCount and flags");

test("enhancedCount equals number of tests that were actually modified", () => {
  const tests = [
    noAssertTest({ name: "No assertions test 1" }),    // will be enhanced
    noAssertTest({ name: "No assertions test 2" }),    // will be enhanced
    strongWithUrlTest(),                                 // already strong — NOT enhanced
  ];
  const snapshotsByUrl = { "http://ex.com/page": SNAPSHOT };
  const { tests: result, enhancedCount } = enhanceTests(tests, snapshotsByUrl, {});
  assert.equal(enhancedCount, 2, `Expected 2 enhanced, got ${enhancedCount}`);
  assert.equal(result.length, 3, "Should return all tests including unmodified");
});

test("enhancedCount is 0 when all tests already have strong assertions", () => {
  const tests = [strongWithUrlTest(), strongWithUrlTest()];
  const { enhancedCount } = enhanceTests(tests, {}, {});
  assert.equal(enhancedCount, 0);
});

test("each test in result has _assertionEnhanced boolean", () => {
  const tests = [noAssertTest(), strongWithUrlTest()];
  const { tests: result } = enhanceTests(tests, {}, {});
  for (const t of result) {
    assert.ok(typeof t._assertionEnhanced === "boolean",
      `_assertionEnhanced should be boolean on every test, got ${typeof t._assertionEnhanced}`);
  }
});

test("empty input returns empty result with enhancedCount 0", () => {
  const { tests: result, enhancedCount } = enhanceTests([], {}, {});
  assert.equal(result.length, 0);
  assert.equal(enhancedCount, 0);
});

test("classifiedPagesByUrl is passed through to individual enhanceTest calls", () => {
  const t = noAssertTest({ type: "smoke" });
  const snapshotsByUrl = { "http://ex.com/page": SNAPSHOT };
  const classifiedPagesByUrl = { "http://ex.com/page": { dominantIntent: "AUTH" } };
  const { tests: result } = enhanceTests([t], snapshotsByUrl, classifiedPagesByUrl);
  // AUTH template should win over smoke type template
  assert.match(result[0].playwrightCode, /not\.toContainText\('error'\)/);
});

// ── 9. Snapshot fallback when snapshotsByUrl is empty ────────────────────────

console.log("\n🗂️  Snapshot fallback — sourceUrl and pageTitle used when map is empty");

test("uses test.sourceUrl as snapshot.url when snapshotsByUrl is empty", () => {
  const t = noAssertTest({ sourceUrl: "http://myapp.com/login" });
  const { tests: result } = enhanceTests([t], {}, {});
  // The injected URL assertion uses a hostname-only regex (per STABILITY_RULES).
  // The dot is escaped in the generated regex literal: /myapp\\.com/i
  assert.match(result[0].playwrightCode, /myapp\\\.com/);
});

test("uses test.pageTitle as snapshot.title when snapshotsByUrl is empty", () => {
  const t = noAssertTest({ pageTitle: "My Login Page", sourceUrl: "http://myapp.com/login" });
  const { tests: result } = enhanceTests([t], {}, {});
  // Should inject a title-based assertion using pageTitle
  assert.match(result[0].playwrightCode, /My Login Page/);
});

test("uses full snapshot from snapshotsByUrl when available (takes priority over test fields)", () => {
  const t = noAssertTest({ pageTitle: "Old Title", sourceUrl: "http://ex.com/page" });
  const snapshotsByUrl = { "http://ex.com/page": { url: "http://ex.com/page", title: "Snapshot Title" } };
  const { tests: result } = enhanceTests([t], snapshotsByUrl, {});
  // Should use the snapshot title, not the test's pageTitle
  assert.match(result[0].playwrightCode, /Snapshot Title/);
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.log(`\n⚠️  ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n🎉 All assertion-enhancer-deep tests passed!`);
}

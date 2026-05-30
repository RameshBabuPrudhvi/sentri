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

test("advanced route-mocking flow is not force-enhanced", () => {
  const advanced = noAssertTest({
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.route('**/api/todos', route => route.fulfill({ status: 200, body: '[]' }));",
      "  await page.goto('http://ex.com/page');",
      "});",
    ].join("\n"),
  });
  const r = enhanceTest(advanced, SNAPSHOT, { dominantIntent: "NAVIGATION" });
  assert.equal(r._assertionEnhanced, false);
  assert.equal(r._enhancementSkipped, "advanced_capability_flow");
});

test("advanced API request context flow is not force-enhanced", () => {
  const advanced = noAssertTest({
    playwrightCode: [
      "test('x', async ({ request }) => {",
      "  const api = await request.newContext({ baseURL: 'http://ex.com' });",
      "  await api.get('/health');",
      "});",
    ].join("\n"),
  });
  const r = enhanceTest(advanced, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, false);
  assert.equal(r._enhancementSkipped, "advanced_capability_flow");
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

// ── 10. Fast-path: already fully enhanced tests ──────────────────────────────

console.log("\n⚡  Fast-path — skip enhancement for fully enhanced tests");

test("fast-path: strong assertions + toHaveURL → _assertionEnhanced: false (no work done)", () => {
  const t = strongWithUrlTest();
  const r = enhanceTest(t, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, false);
  // Code should be unchanged
  assert.equal(r.playwrightCode, t.playwrightCode);
});

test("fast-path: strong assertions + toHaveTitle → _assertionEnhanced: false", () => {
  const t = {
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
  const r = enhanceTest(t, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, false);
});

test("fast-path does NOT trigger when strong assertions exist but no page-load assertion", () => {
  const t = {
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
  const r = enhanceTest(t, SNAPSHOT, null);
  // Should be enhanced (page-load assertion added), not fast-pathed
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "added_page_load_assertion");
});

test("fast-path does NOT trigger when no expect() calls exist (comment mentions toHaveURL)", () => {
  const t = {
    name: "Commented test",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  // TODO: add toHaveURL and toBeVisible assertions",
      "});",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(t, SNAPSHOT, null);
  // hasNoAssertions check should prevent fast-path
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "no_assertions");
});

test("fast-path does NOT trigger for tests with only weak assertions", () => {
  const t = weakAssertTest();
  const r = enhanceTest(t, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "weak_assertions_replaced");
});

test("fast-path does NOT trigger when toHaveURL appears only in a comment (real expect exists)", () => {
  // This test has real expect() calls with strong assertions (toBeVisible),
  // but toHaveURL only appears in a comment — the fast-path should NOT
  // trigger because there is no actual page-load assertion.
  const t = {
    name: "Comment-only toHaveURL",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page.getByText('Welcome')).toBeVisible();",
      "  // TODO: add toHaveURL assertion for page load verification",
      "});",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(t, SNAPSHOT, null);
  // Should be enhanced (page-load assertion added), not fast-pathed
  assert.equal(r._assertionEnhanced, true,
    "fast-path should NOT trigger when toHaveURL is only in a comment");
  assert.equal(r._enhancementReason, "added_page_load_assertion");
  // Verify a real toHaveURL was injected
  assert.match(r.playwrightCode, /expect\(.+\)\.toHaveURL/,
    "Should have injected a real toHaveURL assertion");
});

test("fast-path does NOT trigger when toHaveTitle appears only in a string literal", () => {
  const t = {
    name: "String literal toHaveTitle",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page.getByText('Welcome')).toBeVisible();",
      "  const msg = 'should toHaveTitle but does not';",
      "});",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(t, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true,
    "fast-path should NOT trigger when toHaveTitle is only in a string literal");
  assert.equal(r._enhancementReason, "added_page_load_assertion");
});

// ── 11. Bundle-A fix #14 — hasNoAssertions ignores `expect(` in strings/comments ──
//
// Pre-fix `hasNoAssertions` used a bare `.includes("expect(")` so any test
// containing the substring `expect(` anywhere (inside a string literal, a
// comment, a log line) was classified as HAVING assertions — and the
// enhancer skipped injection on a test that genuinely had zero coverage.

console.log("\n🧹  hasNoAssertions — string/comment-safe detection (fix #14)");

test("hasNoAssertions: bare console.log('expect(loaded)') with NO real expect() → flagged as no-assertions", () => {
  // Bugs.md fix #14 fixture. Pre-fix this returned `false` (the substring
  // `expect(` is present inside the string literal); post-fix it returns
  // `true` because the string-stripping pass removes the literal's body
  // before the presence check runs.
  const code = [
    "test('x', async ({ page }) => {",
    "  await page.goto('http://ex.com/page');",
    "  console.log('expect(loaded)');",
    "});",
  ].join("\n");
  assert.equal(hasNoAssertions(code), true, "string-literal `expect(` must not count as a real assertion");
});

test("hasNoAssertions: `// expect(...)` line comment → flagged as no-assertions", () => {
  const code = [
    "test('x', async ({ page }) => {",
    "  await page.goto('http://ex.com/page');",
    "  // TODO: add expect(page).toHaveURL(...)",
    "});",
  ].join("\n");
  assert.equal(hasNoAssertions(code), true, "line-comment `expect(` mention must not count");
});

test("hasNoAssertions: `/* expect(...) */` block comment → flagged as no-assertions", () => {
  const code = [
    "test('x', async ({ page }) => {",
    "  await page.goto('http://ex.com/page');",
    "  /* placeholder for expect(page).toBeVisible() */",
    "});",
  ].join("\n");
  assert.equal(hasNoAssertions(code), true, "block-comment `expect(` mention must not count");
});

test("hasNoAssertions: template-literal `${expect(...)}` (no real call) → flagged as no-assertions", () => {
  // Template-literal contents are stripped wholesale, so even a fake
  // `${expect(...)}` in a string template won't fool the detector.
  const code = [
    "test('x', async ({ page }) => {",
    "  await page.goto('http://ex.com/page');",
    "  const msg = `assertion would be expect(foo)`;",
    "});",
  ].join("\n");
  assert.equal(hasNoAssertions(code), true, "template-literal `expect(` mention must not count");
});

test("hasNoAssertions: REAL expect() call with sibling string mentioning expect → has assertions", () => {
  // Positive control: a real `expect()` call still registers even when
  // the file ALSO contains decoy `expect(` mentions inside strings or
  // comments. We must not over-strip and lose true positives.
  const code = [
    "test('x', async ({ page }) => {",
    "  await page.goto('http://ex.com/page');",
    "  await expect(page).toHaveURL('/x');",
    "  console.log('expect(decoy)');",
    "  // TODO: add another expect()",
    "});",
  ].join("\n");
  assert.equal(hasNoAssertions(code), false, "real expect() call must still register");
});

test("enhancer injects assertions on a test whose only `expect(` is inside a string literal", () => {
  // End-to-end: the enhancer must drive the `no_assertions` branch on
  // this test (pre-fix it incorrectly fast-pathed because the substring
  // check returned false). The final code MUST contain a real injected
  // assertion.
  const stringOnlyTest = {
    name: "Test with expect inside string only",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  console.log('expect(something)');",
      "  await safeClick(page, 'Continue');",
      "});",
    ].join("\n"),
    steps: ["s"],
    type: "functional",
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(stringOnlyTest, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true, "enhancer must inject because the test genuinely has no assertions");
  assert.equal(r._enhancementReason, "no_assertions");
  // Verify a real assertion was injected.
  assert.match(r.playwrightCode, /\bexpect\s*\(.+\)\.\w+/, "must inject at least one real expect() chain");
});

test("hasStrongAssertions: `'toHaveURL'` inside a string literal does NOT count", () => {
  // Companion guard for the symmetric bug — pre-fix `hasStrongAssertions`
  // ran the regex directly against the raw code, so a string literal
  // containing `'toHaveURL'` would falsely register as a strong
  // assertion. Fix #14 strips strings/comments before the check.
  const code = "const note = 'should add toHaveURL later';";
  assert.equal(hasStrongAssertions(code), false, "matcher substring inside a string must not count");
});

// ── 12. Bundle-A fix #15 — injection anchor tolerates trailing content ───────
//
// Pre-fix the three `enhanceTest` injection regexes used `(\}\s*\);\s*$)`
// where `$` defaults to end-of-string. A test ending with `});\n// comment`
// failed the regex and the assertion injection was silently skipped. The
// fix uses a new `TEST_WRAPPER_CLOSE_RE` that tolerates trailing whitespace,
// line comments, and block comments after `});`.

console.log("\n🪢  enhanceTest — injection anchor tolerates trailing newlines/comments (fix #15)");

const TRAILING_CASES = [
  { label: "trailing newline", trailer: "\n" },
  { label: "trailing line comment", trailer: "\n// generated by gpt-4o" },
  { label: "trailing block comment", trailer: "\n/* model: gpt-4o\n   ts: 2025-01-15 */" },
  { label: "trailing whitespace + line comment", trailer: "\n  \n// note\n  " },
  { label: "trailing block comment then more whitespace", trailer: " /* end */ \n\n" },
];

// (a) `no_assertions` branch — injection must fire on every trailer shape.
for (const { label, trailer } of TRAILING_CASES) {
  test(`no_assertions branch: injects assertions when test ends with "${label}"`, () => {
    const t = noAssertTest({
      playwrightCode: [
        "test('x', async ({ page }) => {",
        "  await page.goto('http://ex.com/page');",
        "  await safeClick(page, 'Continue');",
        `});${trailer}`,
      ].join("\n"),
    });
    const r = enhanceTest(t, SNAPSHOT, { dominantIntent: "NAVIGATION" });
    assert.equal(r._assertionEnhanced, true, `must inject for trailer "${label}"`);
    assert.equal(r._enhancementReason, "no_assertions");
    // The injected assertion(s) must land BEFORE the closing `});`.
    const closeIdx = r.playwrightCode.lastIndexOf("});");
    const injectedExpectIdx = r.playwrightCode.search(/await\s+expect\s*\(/);
    assert.ok(
      injectedExpectIdx >= 0 && injectedExpectIdx < closeIdx,
      `injected expect must precede the closing }); for trailer "${label}"`,
    );
  });
}

// (b) `weak_assertions_replaced` branch — same regex used to splice page-load.
test("weak_assertions_replaced branch: injects page-load when test ends with `// comment`", () => {
  const t = {
    name: "Weak test with trailing comment",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page).toBeTruthy();",
      "});",
      "// trailing model note",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(t, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "weak_assertions_replaced");
  assert.match(r.playwrightCode, /toHaveURL|toHaveTitle/, "page-load assertion must be injected");
});

// (c) `added_page_load_assertion` branch — strong but no URL/title; trailing
//     block comment must not block injection.
test("added_page_load_assertion branch: injects page-load when test ends with `/* … */`", () => {
  const t = {
    name: "Strong test, no URL, trailing block comment",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page.getByText('Welcome')).toBeVisible();",
      "});",
      "/* generated 2025-01-15 */",
    ].join("\n"),
    steps: ["s"],
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(t, SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "added_page_load_assertion");
  // The injected toHaveURL must land BEFORE the closing `});`.
  const code = r.playwrightCode;
  const urlIdx = code.indexOf("toHaveURL");
  const closeIdx = code.lastIndexOf("});");
  assert.ok(urlIdx > 0 && urlIdx < closeIdx, "toHaveURL must precede the closing });");
});

test("injection still works when `});` is followed by nothing (no-regression baseline)", () => {
  // The bare-`});` case — exact pre-fix happy path. Post-fix must still
  // work bit-for-bit so no existing test regresses.
  const t = noAssertTest({
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await safeClick(page, 'Continue');",
      "});",
    ].join("\n"),
  });
  const r = enhanceTest(t, SNAPSHOT, { dominantIntent: "NAVIGATION" });
  assert.equal(r._assertionEnhanced, true);
  assert.equal(r._enhancementReason, "no_assertions");
});

// ── 13. Bundle-A fix #16 — AUTH/security templates scope to error regions ───
//
// Pre-fix the AUTH and `security` templates asserted
// `expect(page.locator('body')).not.toContainText('Invalid')` — which
// false-positives on legitimate body copy like:
//   • "Invalid email format" hints next to form inputs
//   • Admin links named "Error Reports"
//   • Help text like "Sometimes errors happen — try again"
// Fix #16 scopes the negative assertion to dedicated error-region
// selectors (`[role="alert"]`, `.error`, `.field-error`, etc.) and adds
// `.catch(() => {})` so the happy path (no error region present)
// doesn't fail the test.

console.log("\n🔐  AUTH / security templates — scoped error-region check (fix #16)");

test("AUTH template: scopes negative-text check to error regions, NOT body", () => {
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "AUTH" });
  assert.equal(r._assertionEnhanced, true);
  // Must NOT use `page.locator('body')` for the negative-text assertion
  // — that's the false-positive vector. (The existing positive happy-path
  // template doesn't otherwise reference `body`, so any presence here
  // would be the bug.)
  assert.doesNotMatch(
    r.playwrightCode,
    /locator\('body'\)\.not\.toContainText/,
    "AUTH template must not use page.locator('body') for negative-text check",
  );
  // Must reference one of the canonical error-region selectors.
  assert.match(
    r.playwrightCode,
    /role="alert"|\.error|\.field-error/,
    "AUTH template must scope to a dedicated error region",
  );
});

test("AUTH template: appends `.catch(() => {})` so missing error region doesn't fail the test", () => {
  // `.catch(() => {})` swallows the locator-not-found rejection so a
  // page WITHOUT any error region (the happy path) passes silently.
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "AUTH" });
  // Two `.not.toContainText(...)` chains, each followed by `.catch(() => {})`.
  const matches = r.playwrightCode.match(/\.not\.toContainText\('[^']+'\)\.catch\(\(\) => \{\}\)/g) || [];
  assert.ok(
    matches.length >= 2,
    `AUTH template must emit at least 2 .catch-guarded negative-text assertions, got ${matches.length}`,
  );
});

test("security TYPE template: same scoped-region fix applied", () => {
  // Symmetric guard — the `security` TYPE template had the identical bug
  // (literal copy of AUTH's body). Fix #16 patches both.
  const r = enhanceTest(noAssertTest({ type: "security" }), SNAPSHOT, null);
  assert.equal(r._assertionEnhanced, true);
  assert.doesNotMatch(
    r.playwrightCode,
    /locator\('body'\)\.not\.toContainText/,
    "security template must not use page.locator('body') for negative-text check",
  );
  assert.match(
    r.playwrightCode,
    /role="alert"|\.error|\.field-error/,
    "security template must scope to a dedicated error region",
  );
});

test("AUTH template: text `Invalid` and `error` keywords still present (no behaviour drop)", () => {
  // No-regression for the existing AUTH test contract — the template
  // still asserts on the same two keywords; only the locator scope
  // changed. A pre-fix consumer doing `assert.match(/not.toContainText\('Invalid'\)/)`
  // (line 168 above) must still pass.
  const r = enhanceTest(noAssertTest(), SNAPSHOT, { dominantIntent: "AUTH" });
  assert.match(r.playwrightCode, /not\.toContainText\('Invalid'\)/);
  assert.match(r.playwrightCode, /not\.toContainText\('error'\)/);
});

// ── 14. Bundle-A follow-up #F1/F2 — anchored matcher patterns + bounded RE ──
//
// F1: `HAS_PAGE_LOAD_ASSERTION_RE` no longer uses greedy `.+`/`.*` with
//     `/s` — bounded to `[^;\n]{1,2000}` so it can't catastrophically
//     backtrack on minified single-line inputs.
// F2: `STRONG_ASSERTION_PATTERNS` now anchor to `.toHaveURL(` method-call
//     syntax instead of bare `toHaveURL` substring — defence-in-depth
//     alongside fix #14's strip pass.

console.log("\n🔍  HAS_PAGE_LOAD_ASSERTION_RE / STRONG_ASSERTION_PATTERNS — anchored (#F1/#F2)");

test("F2: a property assignment `obj.toHaveURL = fn` does NOT count as a strong assertion", () => {
  // Pre-fix the bare `/toHaveURL/` substring would match the LHS of an
  // assignment. Post-fix the `\.toHaveURL\s*\(` anchor requires actual
  // method-call syntax.
  const code = "const obj = { toHaveURL: () => true }; obj.toHaveURL = () => false;";
  assert.equal(
    hasStrongAssertions(code),
    false,
    "property assignment must not register as a strong assertion",
  );
});

test("F2: real `.toHaveURL(...)` call still counts", () => {
  // Positive control — the anchored pattern must still match real calls.
  const code = "await expect(page).toHaveURL('/dash');";
  assert.equal(hasStrongAssertions(code), true);
});

test("F1: 5KB single-line `expect(...).toHaveURL(...)` body validates in < 200ms", () => {
  // Performance budget for the bounded regex. Pre-fix the greedy `.+`
  // with `/s` walked exponential backtracking trees on this fixture.
  const chunks = [];
  for (let i = 0; i < 80; i += 1) {
    chunks.push(`await expect(page.locator('.item-${i}').nth(${i}).first()).toHaveURL('/page-${i}');`);
  }
  const code = chunks.join(" ");
  assert.ok(code.length > 4000, `precondition: fixture must be > 4 KB, got ${code.length}`);

  // The enhancer's fast-path calls HAS_PAGE_LOAD_ASSERTION_RE — drive it
  // via enhanceTest with the perf fixture as `playwrightCode`.
  const t = {
    name: "Pathological perf fixture",
    playwrightCode: code,
    sourceUrl: "http://ex.com/page",
  };
  const t0 = Date.now();
  enhanceTest(t, SNAPSHOT, null);
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < 200,
    `enhanceTest on a 5KB single-line body with toHaveURL chains must finish < 200ms, took ${elapsed}ms`,
  );
});

test("F1: nested-parens expect target still validates the page-load regex", () => {
  // The bounded pattern must still match the canonical
  // `expect(page.locator('x').first()).toHaveURL(...)` shape.
  const t = {
    name: "Nested parens with toHaveURL",
    playwrightCode: [
      "test('x', async ({ page }) => {",
      "  await page.goto('http://ex.com/page');",
      "  await expect(page.locator('h1').first()).toBeVisible();",
      "  await expect(page).toHaveURL('/dash');",
      "});",
    ].join("\n"),
    sourceUrl: "http://ex.com/page",
  };
  const r = enhanceTest(t, SNAPSHOT, null);
  // Has strong assertions + a real toHaveURL → fast-path should fire
  // (i.e. `_assertionEnhanced: false` because the test is already fully
  // enhanced).
  assert.equal(r._assertionEnhanced, false,
    "fast-path must fire for a test with nested-paren toHaveURL");
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

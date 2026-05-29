/**
 * @module tests/deduplicator-deep
 * @description Deep unit tests for pipeline/deduplicator.js
 *
 * The existing pipeline.test.js has basic smoke tests for deduplicator.
 * This file covers the gaps: scoreTest edge cases, hash stability under
 * normalization, quality-based survivor selection, name-dedup boundary
 * conditions, and the O(n) precomputation path for deduplicateAcrossRuns.
 *
 * Coverage areas:
 *   1. hashTest — normalization stability, fallback paths, empty inputs
 *   2. scoreTest — all scoring branches: rewards, penalties, type bonuses
 *   3. deduplicateTests — survivor selection, stats shape, empty input
 *   4. deduplicateAcrossRuns — hash match, name+URL match, boundary conditions,
 *                              empty existing tests, empty new tests
 *
 * Run: node tests/deduplicator-deep.test.js
 */

import assert from "node:assert/strict";
import {
  hashTest,
  scoreTest,
  deduplicateTests,
  deduplicateAcrossRuns,
} from "../src/pipeline/deduplicator.js";

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

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FULL_TEST = {
  name: "User can complete checkout flow",
  playwrightCode: [
    "await page.goto('http://shop.com/cart');",
    "await safeClick(page, 'Checkout');",
    "await safeFill(page, 'Email', 'user@test.com');",
    "await safeClick(page, 'Place order');",
    "await safeExpect(page, expect, 'Order confirmed');",
    "await expect(page.locator('.total')).toContainText('$49');",
  ].join("\n"),
  steps: ["Go to cart", "Click checkout", "Fill email", "Place order", "Verify confirmation"],
  priority: "high",
  type: "e2e",
  sourceUrl: "http://shop.com/cart",
};

const MINIMAL_TEST = {
  name: "Cart page loads",
  playwrightCode: "await page.goto('http://shop.com/cart');\nawait expect(page).toBeTruthy();",
  steps: ["Load page"],
  priority: "low",
  type: "smoke",
  sourceUrl: "http://shop.com/cart",
};

// ── 1. hashTest ───────────────────────────────────────────────────────────────

console.log("\n#️⃣  hashTest — normalization and stability");

test("produces same hash regardless of minor whitespace differences", () => {
  const t1 = { playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/dash');" };
  const t2 = { playwrightCode: "await page.goto('/login');\n  await expect(page).toHaveURL('/dash');" };
  // Normalizer collapses whitespace, so these should hash identically
  assert.equal(hashTest(t1), hashTest(t2));
});

test("produces same hash regardless of punctuation differences in action lines", () => {
  const t1 = { playwrightCode: "await page.goto('/login');\nawait page.click('Sign in!');" };
  const t2 = { playwrightCode: "await page.goto('/login');\nawait page.click('Sign in');" };
  // Normalizer strips non-alphanumeric chars → same signature
  assert.equal(hashTest(t1), hashTest(t2));
});

test("produces different hash for different goto URLs", () => {
  const t1 = { playwrightCode: "await page.goto('/login');\nawait expect(page).toBeVisible();" };
  const t2 = { playwrightCode: "await page.goto('/register');\nawait expect(page).toBeVisible();" };
  assert.notEqual(hashTest(t1), hashTest(t2));
});

test("falls back to steps when playwrightCode is empty", () => {
  const t = { playwrightCode: "", steps: ["Go to login", "Enter credentials", "Submit"] };
  const hash = hashTest(t);
  assert.ok(typeof hash === "string" && hash.length > 0);
});

test("falls back to steps when playwrightCode has no await lines", () => {
  const t = { playwrightCode: "// just a comment\nconst x = 1;", steps: ["Check something"] };
  const hash = hashTest(t);
  // Should produce same hash as a test with no playwright code but same steps
  const t2 = { playwrightCode: "", steps: ["Check something"] };
  assert.equal(hashTest(t), hashTest(t2));
});

test("falls back to name when both code and steps are empty", () => {
  const t = { playwrightCode: "", steps: [], name: "My unique test name" };
  const hash = hashTest(t);
  assert.ok(typeof hash === "string" && hash.length > 0);
});

test("returns a string for a completely empty test object", () => {
  const hash = hashTest({});
  assert.ok(typeof hash === "string");
});

test("two tests with identical steps but different code have different hashes", () => {
  // Code-based hash takes priority over steps
  const t1 = {
    playwrightCode: "await page.goto('/a');\nawait expect(page).toHaveURL('/a');",
    steps: ["Same step"],
  };
  const t2 = {
    playwrightCode: "await page.goto('/b');\nawait expect(page).toHaveURL('/b');",
    steps: ["Same step"],
  };
  assert.notEqual(hashTest(t1), hashTest(t2));
});

// ── 2. scoreTest ──────────────────────────────────────────────────────────────

console.log("\n🏆  scoreTest — all scoring branches");

test("score is always 0–100 (no negative, no over-100)", () => {
  // Worst possible test
  const worst = { name: "x", playwrightCode: "await expect(page).toBeTruthy();\nawait expect(page).toBeTruthy();\nawait expect(page).toBeTruthy();", steps: [], priority: "low", type: "unknown" };
  assert.ok(scoreTest(worst) >= 0, `Expected >= 0, got ${scoreTest(worst)}`);

  // Best possible test — pile on every reward
  const best = {
    name: "Checkout with payment verification",
    playwrightCode: [
      "await expect(page).toHaveURL('/checkout');",
      "await expect(page).toHaveTitle('Checkout');",
      "await expect(page.getByRole('button')).toBeVisible();",
      "await expect(page.locator('.total')).toHaveText('$49.00');",
      "await expect(page.getByRole('textbox')).toBeEnabled();",
      "await expect(page.getByLabel('card')).toHaveValue('4242');",
      "await page.getByRole('button', { name: 'Pay' }).click();",
      "await page.getByLabel('Email').fill('a@b.com');",
    ].join("\n"),
    steps: ["s"],
    priority: "high",
    type: "e2e",
  };
  assert.ok(scoreTest(best) <= 100, `Expected <= 100, got ${scoreTest(best)}`);
});

test("rewards toHaveURL (+20)", () => {
  const base = scoreTest({ name: "t", playwrightCode: "await page.goto('/x');", steps: ["s"], priority: "medium", type: "functional" });
  const withUrl = scoreTest({ name: "t", playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');", steps: ["s"], priority: "medium", type: "functional" });
  assert.ok(withUrl > base, `toHaveURL should increase score: ${base} → ${withUrl}`);
});

test("rewards toHaveTitle (+15)", () => {
  const base = scoreTest({ playwrightCode: "await page.goto('/');", steps: ["s"] });
  const withTitle = scoreTest({ playwrightCode: "await page.goto('/');\nawait expect(page).toHaveTitle('Home');", steps: ["s"] });
  assert.ok(withTitle > base);
});

test("rewards toBeVisible (+15)", () => {
  const base = scoreTest({ playwrightCode: "await page.goto('/');", steps: ["s"] });
  const withVisible = scoreTest({ playwrightCode: "await page.goto('/');\nawait expect(el).toBeVisible();", steps: ["s"] });
  assert.ok(withVisible > base);
});

test("rewards toContainText / toHaveText (+15)", () => {
  const base = scoreTest({ playwrightCode: "await page.goto('/');", steps: ["s"] });
  const withText = scoreTest({ playwrightCode: "await page.goto('/');\nawait expect(el).toContainText('hi');", steps: ["s"] });
  assert.ok(withText > base);
});

test("rewards multiple expect() calls (+20 for >=2)", () => {
  const one = scoreTest({ playwrightCode: "await expect(page).toHaveURL('/x');", steps: ["s"] });
  const two = scoreTest({ playwrightCode: "await expect(page).toHaveURL('/x');\nawait expect(el).toBeVisible();", steps: ["s"] });
  assert.ok(two > one, `Two expects should score higher than one: ${one} → ${two}`);
});

test("penalizes toBeTruthy / toBeDefined (-20)", () => {
  // Use a baseline that already has strong assertions so the score is above 0
  // before the penalty is applied — otherwise both sides clamp to 0.
  const clean = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');\nawait expect(page).toHaveTitle('t');", steps: ["s"] });
  const weak  = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');\nawait expect(page).toBeTruthy();", steps: ["s"] });
  assert.ok(weak < clean, `toBeTruthy should penalize: ${clean} → ${weak}`);
});

test("penalizes missing assertions (-30)", () => {
  const withAssert = scoreTest({ playwrightCode: "await page.goto('/');\nawait expect(page).toHaveTitle('x');", steps: ["s"] });
  const noAssert = scoreTest({ playwrightCode: "await page.goto('/');", steps: ["s"] });
  assert.ok(noAssert < withAssert, `No assertions should penalize: ${withAssert} → ${noAssert}`);
});

test("rewards high priority (+10)", () => {
  // Need a baseline with actual assertions so scores are above 0
  const medium = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');", steps: ["s"], priority: "medium", type: "smoke" });
  const high   = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');", steps: ["s"], priority: "high",   type: "smoke" });
  assert.ok(high > medium, `high priority should score more than medium: ${medium} → ${high}`);
});

test("rewards industry-standard type (e2e, functional, smoke, etc.)", () => {
  const noType = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');", steps: ["s"], type: "" });
  const e2e    = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');", steps: ["s"], type: "e2e" });
  assert.ok(e2e > noType, `e2e type should score more: ${noType} → ${e2e}`);
});

test("rewards legacy intent-based types (auth, checkout, crud, etc.)", () => {
  const noType = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');", steps: ["s"], type: "" });
  const auth   = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');", steps: ["s"], type: "auth" });
  assert.ok(auth > noType, `auth type should score more: ${noType} → ${auth}`);
});

test("rewards getByRole / getByLabel / getByText selectors (+10)", () => {
  const raw  = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');\nawait page.locator('#btn').click();", steps: ["s"] });
  const role = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');\nawait page.getByRole('button').click();", steps: ["s"] });
  assert.ok(role > raw, `getByRole should score more than #id: ${raw} → ${role}`);
});

test("penalizes >2 nth-child / nth selectors (-10)", () => {
  const clean   = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');", steps: ["s"] });
  const fragile = scoreTest({ playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');\nawait el.nth(0).click();\nawait el.nth(1).click();\nawait el.nth(2).click();", steps: ["s"] });
  assert.ok(fragile < clean, `nth selectors should penalize: ${clean} → ${fragile}`);
});

test("FULL_TEST scores higher than MINIMAL_TEST", () => {
  assert.ok(scoreTest(FULL_TEST) > scoreTest(MINIMAL_TEST),
    `Full test (${scoreTest(FULL_TEST)}) should outscore minimal (${scoreTest(MINIMAL_TEST)})`);
});

// ── 3. deduplicateTests ───────────────────────────────────────────────────────

console.log("\n🚫  deduplicateTests — survivor selection and stats");

test("returns correct stats shape", () => {
  const { stats } = deduplicateTests([FULL_TEST, MINIMAL_TEST]);
  assert.ok("total" in stats, "stats.total missing");
  assert.ok("unique" in stats, "stats.unique missing");
  assert.ok("duplicatesRemoved" in stats, "stats.duplicatesRemoved missing");
  assert.ok("averageQuality" in stats, "stats.averageQuality missing");
});

test("stats.total equals input length", () => {
  const input = [FULL_TEST, MINIMAL_TEST, { ...FULL_TEST, name: "copy" }];
  const { stats } = deduplicateTests(input);
  assert.equal(stats.total, 3);
});

test("stats.duplicatesRemoved + stats.unique = stats.total", () => {
  const { stats } = deduplicateTests([FULL_TEST, { ...FULL_TEST }, MINIMAL_TEST]);
  assert.equal(stats.duplicatesRemoved + stats.unique, stats.total);
});

test("averageQuality is a number 0–100", () => {
  const { stats } = deduplicateTests([FULL_TEST, MINIMAL_TEST]);
  assert.ok(typeof stats.averageQuality === "number");
  assert.ok(stats.averageQuality >= 0 && stats.averageQuality <= 100);
});

test("empty input returns zero stats", () => {
  const { unique, removed, stats } = deduplicateTests([]);
  assert.equal(unique.length, 0);
  assert.equal(removed, 0);
  assert.equal(stats.total, 0);
  assert.equal(stats.averageQuality, 0);
});

test("single test is returned unchanged (no dedup to do)", () => {
  const { unique, removed } = deduplicateTests([FULL_TEST]);
  assert.equal(unique.length, 1);
  assert.equal(removed, 0);
});

test("higher quality test survives when there are three duplicates", () => {
  const v1 = { ...FULL_TEST, playwrightCode: FULL_TEST.playwrightCode, name: "v1" };
  const v2 = { ...FULL_TEST, playwrightCode: FULL_TEST.playwrightCode + "\nawait expect(page).toHaveURL('/confirmed');", name: "v2" };
  const v3 = { ...FULL_TEST, playwrightCode: FULL_TEST.playwrightCode, name: "v3" };

  const { unique } = deduplicateTests([v1, v2, v3]);

  // v2 has an extra toHaveURL — should score higher and survive
  assert.ok(unique.length <= 2, `Should deduplicate: got ${unique.length}`);
  const survivor = unique.find(t => hashTest(t) === hashTest(v2));
  // The highest-scoring version should be kept
  assert.ok(survivor, "The version with toHaveURL should survive");
});

test("unique array is sorted by quality descending", () => {
  const low = { ...MINIMAL_TEST, name: "low", playwrightCode: "await page.goto('/a');" };
  const high = { ...FULL_TEST, name: "high" };
  const { unique } = deduplicateTests([low, high]);
  if (unique.length >= 2) {
    assert.ok(unique[0]._quality >= unique[1]._quality,
      "First item should have highest quality");
  }
});

test("surviving test has _hash and _quality metadata attached", () => {
  const { unique } = deduplicateTests([FULL_TEST]);
  assert.ok("_hash" in unique[0], "Should have _hash");
  assert.ok("_quality" in unique[0], "Should have _quality");
  assert.ok(typeof unique[0]._quality === "number");
});

// ── 4. deduplicateAcrossRuns ──────────────────────────────────────────────────

console.log("\n🔄  deduplicateAcrossRuns — cross-run filtering");

test("returns all new tests when existing is empty", () => {
  const result = deduplicateAcrossRuns([FULL_TEST, MINIMAL_TEST], []);
  assert.equal(result.length, 2);
});

test("returns empty array when new tests is empty", () => {
  const result = deduplicateAcrossRuns([], [FULL_TEST]);
  assert.equal(result.length, 0);
});

test("filters out test that matches existing by structural hash", () => {
  const existing = [FULL_TEST];
  const newTests = [FULL_TEST]; // exact structural match
  const result = deduplicateAcrossRuns(newTests, existing);
  assert.equal(result.length, 0, "Structurally identical test should be filtered");
});

test("keeps test that is structurally different from existing", () => {
  const existing = [FULL_TEST];
  const different = {
    name: "A brand new test",
    playwrightCode: "await page.goto('/settings');\nawait expect(page).toHaveTitle('Settings');",
    steps: ["Go to settings"],
    sourceUrl: "http://shop.com/settings",
  };
  const result = deduplicateAcrossRuns([different], existing);
  assert.equal(result.length, 1);
});

test("name+URL dedup: same normalised name AND same sourceUrl = filtered", () => {
  const existing = [{
    name: "Verify checkout flow works correctly",
    sourceUrl: "http://shop.com/cart",
    playwrightCode: "await page.goto('/cart');\nawait page.click('Checkout');",
    steps: ["step1", "step2"],
  }];
  const newTest = {
    name: "Verify checkout flow works correctly",
    sourceUrl: "http://shop.com/cart",
    // Different code — but same name+URL should catch it
    playwrightCode: "await page.goto('/cart');\nawait safeClick(page, 'Checkout');",
    steps: ["s1", "s2"],
  };
  const result = deduplicateAcrossRuns([newTest], existing);
  assert.equal(result.length, 0, "Same name+URL should be treated as duplicate");
});

test("name+URL dedup: same name but DIFFERENT URL = allowed through", () => {
  const existing = [{
    name: "Verify checkout flow works correctly",
    sourceUrl: "http://shop.com/cart",
    playwrightCode: "await page.goto('/cart');\nawait page.click('x');",
    steps: ["s1", "s2"],
  }];
  const newTest = {
    name: "Verify checkout flow works correctly",
    sourceUrl: "http://shop.com/checkout", // different URL
    playwrightCode: "await page.goto('/checkout');\nawait page.click('y');",
    steps: ["s1", "s2"],
  };
  const result = deduplicateAcrossRuns([newTest], existing);
  assert.equal(result.length, 1, "Different URL should allow same-named test through");
});

test("name dedup ignores short names below 15-char minimum", () => {
  const existing = [{
    name: "Login test",  // only 10 chars after normalize → below threshold
    sourceUrl: "http://app.com/login",
    playwrightCode: "await page.goto('/login');\nawait page.fill('#x', 'a');",
    steps: ["go", "fill"],
  }];
  const newTest = {
    name: "Login test",
    sourceUrl: "http://app.com/login",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveTitle('Login');",
    steps: ["go", "check"],
  };
  const result = deduplicateAcrossRuns([newTest], existing);
  // "login test" = 10 chars < 15 minimum — name-dedup skips, hash-dedup must decide
  // The code is structurally different, so it should pass through
  assert.equal(result.length, 1, "Short names should not trigger name-based dedup");
});

test("filters multiple duplicates correctly", () => {
  const existing = [FULL_TEST, MINIMAL_TEST];
  const newTests = [
    FULL_TEST,   // duplicate
    MINIMAL_TEST, // duplicate
    { name: "Brand new test for settings page", playwrightCode: "await page.goto('/settings');\nawait expect(page).toHaveTitle('x');", steps: ["s1", "s2"], sourceUrl: "/settings" }, // new
  ];
  const result = deduplicateAcrossRuns(newTests, existing);
  assert.equal(result.length, 1, "Should keep only the non-duplicate test");
  assert.match(result[0].name, /settings/i);
});

test("does not mutate the input arrays", () => {
  const newTests = [FULL_TEST, MINIMAL_TEST];
  const existing = [FULL_TEST];
  const lenBefore = newTests.length;
  deduplicateAcrossRuns(newTests, existing);
  assert.equal(newTests.length, lenBefore, "Input array should not be mutated");
});

// ── 5. New exported helpers: fuzzyNameSimilarity, cosineSimilarity, semanticSimilarity ──

import {
  fuzzyNameSimilarity,
  cosineSimilarity,
  semanticSimilarity,
  FUZZY_NAME_THRESHOLD,
  SEMANTIC_SIMILARITY_THRESHOLD,
} from "../src/pipeline/deduplicator.js";

console.log("\n🔤  fuzzyNameSimilarity — Levenshtein-based name matching");

test("identical strings → 1.0", () => {
  assert.equal(fuzzyNameSimilarity("hello world", "hello world"), 1);
});

test("completely different strings → low similarity", () => {
  assert.ok(fuzzyNameSimilarity("abcdefghij", "zyxwvutsrq") < 0.3);
});

test("empty first string → 0", () => {
  assert.equal(fuzzyNameSimilarity("", "hello"), 0);
});

test("empty second string → 0", () => {
  assert.equal(fuzzyNameSimilarity("hello", ""), 0);
});

test("both empty → 0 (falsy guard)", () => {
  assert.equal(fuzzyNameSimilarity("", ""), 0);
});

test("null inputs → 0", () => {
  assert.equal(fuzzyNameSimilarity(null, "hello"), 0);
  assert.equal(fuzzyNameSimilarity("hello", null), 0);
});

test("similar names above threshold (≥ 0.80)", () => {
  const sim = fuzzyNameSimilarity(
    "verify login form validation",
    "verify login form validations"
  );
  assert.ok(sim >= FUZZY_NAME_THRESHOLD, `Expected ≥ ${FUZZY_NAME_THRESHOLD}, got ${sim}`);
});

test("different names below threshold (< 0.80)", () => {
  const sim = fuzzyNameSimilarity(
    "verify login form validation",
    "verify checkout cart totals"
  );
  assert.ok(sim < FUZZY_NAME_THRESHOLD, `Expected < ${FUZZY_NAME_THRESHOLD}, got ${sim}`);
});

console.log("\n📐  cosineSimilarity — sparse TF vector comparison");

test("identical vectors → 1.0", () => {
  const v = new Map([["login", 2], ["form", 1]]);
  assert.equal(cosineSimilarity(v, v), 1);
});

test("disjoint vectors → 0.0", () => {
  const a = new Map([["login", 1]]);
  const b = new Map([["checkout", 1]]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test("empty vector → 0.0", () => {
  const a = new Map();
  const b = new Map([["login", 1]]);
  assert.equal(cosineSimilarity(a, b), 0);
  assert.equal(cosineSimilarity(b, a), 0);
});

test("partially overlapping vectors → between 0 and 1", () => {
  const a = new Map([["login", 1], ["form", 1]]);
  const b = new Map([["login", 1], ["cart", 1]]);
  const sim = cosineSimilarity(a, b);
  assert.ok(sim > 0 && sim < 1, `Expected 0 < sim < 1, got ${sim}`);
});

console.log("\n🧠  semanticSimilarity — full test object comparison");

test("identical tests → 1.0", () => {
  const t = { name: "Verify login form validation errors", steps: ["Go to login", "Submit empty form"] };
  assert.equal(semanticSimilarity(t, t), 1);
});

test("completely different tests → low similarity", () => {
  const a = { name: "Verify login form validation errors", steps: ["Go to login", "Submit empty form"] };
  const b = { name: "Verify checkout cart totals calculation", steps: ["Add items to cart", "Check total"] };
  const sim = semanticSimilarity(a, b);
  assert.ok(sim < SEMANTIC_SIMILARITY_THRESHOLD, `Expected < ${SEMANTIC_SIMILARITY_THRESHOLD}, got ${sim}`);
});

test("tests with empty fields → 0 (no crash)", () => {
  const a = { name: "", steps: [] };
  const b = { name: "", steps: [] };
  assert.equal(semanticSimilarity(a, b), 0);
});

console.log("\n📏  Exported thresholds are correct values");

test("FUZZY_NAME_THRESHOLD is 0.80", () => {
  assert.equal(FUZZY_NAME_THRESHOLD, 0.80);
});

test("SEMANTIC_SIMILARITY_THRESHOLD is 0.65", () => {
  assert.equal(SEMANTIC_SIMILARITY_THRESHOLD, 0.65);
});

// ── 6. deduplicateTests — sourceUrl guard prevents cross-page false positives ─

console.log("\n🌐  deduplicateTests — sourceUrl guard for fuzzy/semantic layers");

test("fuzzy name layer: same name, different sourceUrl → both retained", () => {
  const t1 = {
    name: "Verify form validation errors displayed correctly",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/login');",
    steps: ["Go to login", "Submit empty form"],
    sourceUrl: "http://shop.com/login",
  };
  const t2 = {
    name: "Verify form validation errors displayed correctly",
    playwrightCode: "await page.goto('/signup');\nawait expect(page).toHaveURL('/signup');",
    steps: ["Go to signup", "Submit empty form"],
    sourceUrl: "http://shop.com/signup",
  };
  const { unique } = deduplicateTests([t1, t2]);
  assert.equal(unique.length, 2, "Tests on different pages with same name should both be retained");
});

test("fuzzy name layer: similar name, same sourceUrl → deduplicated", () => {
  const t1 = {
    name: "Verify login form validation errors displayed",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/login');",
    steps: ["Go to login", "Submit empty form"],
    sourceUrl: "http://shop.com/login",
  };
  const t2 = {
    name: "Verify login form validation error displayed",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveTitle('Login');",
    steps: ["Go to login", "Submit form"],
    sourceUrl: "http://shop.com/login",
  };
  const { unique } = deduplicateTests([t1, t2]);
  assert.equal(unique.length, 1, "Similar names on same page should be deduplicated");
});

test("semantic layer: similar vocabulary, different sourceUrl → both retained", () => {
  const t1 = {
    name: "Verify login form validation errors show correctly on page",
    description: "Tests that login form shows validation errors",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/login');",
    steps: ["Go to login", "Submit empty form", "Check errors"],
    sourceUrl: "http://shop.com/login",
  };
  const t2 = {
    name: "Verify signup form validation errors show correctly on page",
    description: "Tests that signup form shows validation errors",
    playwrightCode: "await page.goto('/signup');\nawait expect(page).toHaveURL('/signup');",
    steps: ["Go to signup", "Submit empty form", "Check errors"],
    sourceUrl: "http://shop.com/signup",
  };
  const { unique } = deduplicateTests([t1, t2]);
  assert.equal(unique.length, 2, "Semantically similar tests on different pages should both be retained");
});

// ── 7. scoreTestWithFactors — rubric breakdown ────────────────────────────────
//
// `scoreTestWithFactors` is the source-of-truth scoring function — `scoreTest`
// is a thin wrapper that returns only the numeric score. These tests lock down
// (a) the contract between the two functions, (b) the factor-array shape that
// the API exposes via `qualityScoreFactors`, and (c) the stable factor IDs
// (since they're persisted per-test and shipped to the frontend).

import { scoreTestWithFactors } from "../src/pipeline/deduplicator.js";

console.log("\n🧾  scoreTestWithFactors — factor breakdown contract");

test("returns { score, factors } shape", () => {
  const result = scoreTestWithFactors(FULL_TEST);
  assert.ok(typeof result.score === "number");
  assert.ok(Array.isArray(result.factors));
});

test("score matches scoreTest() for the same input", () => {
  // The two functions share QUALITY_FACTORS — scoreTest() wraps
  // scoreTestWithFactors(). They must never drift.
  for (const t of [FULL_TEST, MINIMAL_TEST, { playwrightCode: "", steps: [] }]) {
    assert.equal(scoreTestWithFactors(t).score, scoreTest(t),
      `Scores must match for ${JSON.stringify(t).slice(0, 60)}…`);
  }
});

test("each factor has stable id, label, delta, kind", () => {
  const { factors } = scoreTestWithFactors(FULL_TEST);
  assert.ok(factors.length > 0, "FULL_TEST should hit at least one factor");
  for (const f of factors) {
    assert.equal(typeof f.id, "string");
    assert.equal(typeof f.label, "string");
    assert.equal(typeof f.delta, "number");
    assert.ok(f.kind === "reward" || f.kind === "penalty",
      `kind must be "reward" or "penalty", got ${f.kind}`);
  }
});

test("sum of factor deltas equals the raw (un-clamped) score", () => {
  // Pick a test we know stays inside the 0–100 clamp so the assertion is exact.
  const t = {
    name: "Mid-range scoring test fixture",
    playwrightCode: "await page.goto('/x');\nawait expect(page).toHaveURL('/x');",
    steps: ["s"],
    priority: "medium",
    type: "functional",
  };
  const { score, factors } = scoreTestWithFactors(t);
  const sum = factors.reduce((a, f) => a + f.delta, 0);
  assert.equal(score, Math.max(0, Math.min(100, sum)));
});

test("rewards and penalties are partitioned by `kind`", () => {
  const noAssertions = scoreTestWithFactors({
    playwrightCode: "await page.goto('/x');", steps: ["s"],
  });
  const noneFactor = noAssertions.factors.find(f => f.id === "assert.none");
  assert.ok(noneFactor, "Missing-assertion test should hit assert.none");
  assert.equal(noneFactor.kind, "penalty");
  assert.ok(noneFactor.delta < 0, "Penalty deltas must be negative");
});

test("factor IDs are stable — known IDs are present in output", () => {
  // Frontend keys factor rows by `id`, and the column persists historical
  // breakdowns. If an ID is renamed, old data renders as "Unknown factor".
  const { factors } = scoreTestWithFactors({
    name: "Rich test with many signals",
    playwrightCode: [
      "await expect(page).toHaveURL('/x');",
      "await expect(page.getByRole('button')).toBeVisible();",
      "await page.getByLabel('Email').fill('a@b');",
    ].join("\n"),
    steps: ["s"],
    priority: "high",
    type: "e2e",
  });
  const ids = new Set(factors.map(f => f.id));
  for (const expected of ["assert.url", "assert.visible", "assert.multiple",
                          "name.descriptive", "priority.high", "type.high-value",
                          "selector.semantic"]) {
    assert.ok(ids.has(expected), `Expected factor id "${expected}" to fire`);
  }
});

// ── 8. normalizeQualityToConfidence — 0–100 score → 0–1 confidence ──────────
//
// Single source of truth for the AUTO-003b auto-approval threshold check.
// Previously the `/100` normalization was inlined in three places; these
// tests lock down the contract so future refactors can't reintroduce drift.

import { normalizeQualityToConfidence } from "../src/pipeline/deduplicator.js";

console.log("\n📊  normalizeQualityToConfidence — quality (0–100) → confidence (0–1)");

test("0 quality → 0 confidence", () => {
  assert.equal(normalizeQualityToConfidence(0), 0);
});

test("50 quality → 0.5 confidence", () => {
  assert.equal(normalizeQualityToConfidence(50), 0.5);
});

test("100 quality → 1 confidence", () => {
  assert.equal(normalizeQualityToConfidence(100), 1);
});

test("values above 100 clamp to 1 (defensive — rubric should never exceed 100)", () => {
  assert.equal(normalizeQualityToConfidence(150), 1);
});

test("negative values clamp to 0", () => {
  assert.equal(normalizeQualityToConfidence(-25), 0);
});

test("NaN coerces to 0 (Number.isFinite guard)", () => {
  assert.equal(normalizeQualityToConfidence(NaN), 0);
});

test("Infinity coerces to 0 (Number.isFinite guard)", () => {
  assert.equal(normalizeQualityToConfidence(Infinity), 0);
  assert.equal(normalizeQualityToConfidence(-Infinity), 0);
});

test("undefined coerces to 0", () => {
  assert.equal(normalizeQualityToConfidence(undefined), 0);
});

test("output is always within [0, 1]", () => {
  for (const q of [-5, 0, 1, 50, 99, 100, 101, 500, NaN, Infinity, undefined, null]) {
    const c = normalizeQualityToConfidence(q);
    assert.ok(c >= 0 && c <= 1, `confidence must be in [0,1] for input ${q}; got ${c}`);
  }
});

// ── 9. Bundle-A fix #11 — scenario guard on fuzzy / semantic dedup ──────────
//
// Positive AND negative scenario tests on the same URL with similar names
// (e.g. "Login with valid credentials" vs "Login with invalid credentials")
// must BOTH survive — they're the intended coverage of the same flow.
// Pre-fix the sourceUrl guard was the only check, and the semantic-vocabulary
// overlap was high enough to trip the cosine threshold so dedup collapsed
// the two into one.

import { sameDedupScenario } from "../src/pipeline/deduplicator.js";

console.log("\n🎭  deduplicateTests / deduplicateAcrossRuns — scenario guard");

test("sameDedupScenario: same scenario → true", () => {
  assert.equal(sameDedupScenario("positive", "positive"), true);
  assert.equal(sameDedupScenario("negative", "negative"), true);
});

test("sameDedupScenario: different scenarios → false (the bug case)", () => {
  assert.equal(sameDedupScenario("positive", "negative"), false);
  assert.equal(sameDedupScenario("negative", "positive"), false);
});

test("sameDedupScenario: either side omits scenario → true (legacy fallback)", () => {
  // Pre-fix behaviour preserved when EITHER side lacks `scenario` so existing
  // duplicates still dedupe. Required so we don't introduce a perf regression
  // by accidentally treating legacy null-scenario tests as different.
  assert.equal(sameDedupScenario(null, "positive"), true);
  assert.equal(sameDedupScenario("positive", null), true);
  assert.equal(sameDedupScenario(undefined, "negative"), true);
  assert.equal(sameDedupScenario("negative", undefined), true);
  assert.equal(sameDedupScenario(null, null), true);
});

test("deduplicateTests: positive + negative on same URL with similar names → BOTH retained", () => {
  // The bug fixture from Bugs.md. Pre-fix the semantic layer collapsed
  // these because TF-IDF cosine across name+description+steps was high
  // enough and the URLs matched.
  const positive = {
    name: "Login with valid credentials succeeds",
    description: "Verify happy-path login with correct username + password",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/dashboard');",
    steps: ["Go to login", "Enter valid credentials", "Submit", "Check dashboard"],
    sourceUrl: "http://app.com/login",
    scenario: "positive",
  };
  const negative = {
    name: "Login with invalid credentials fails",
    description: "Verify error path when credentials are rejected",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/login');",
    steps: ["Go to login", "Enter invalid credentials", "Submit", "Check error"],
    sourceUrl: "http://app.com/login",
    scenario: "negative",
  };
  const { unique } = deduplicateTests([positive, negative]);
  assert.equal(
    unique.length,
    2,
    `positive + negative on same URL must both be retained, got ${unique.length}`,
  );
});

test("deduplicateTests: SAME scenario on same URL with similar names → still deduplicated", () => {
  // Negative-path / no-regression: when the scenario matches, the
  // existing dedup behaviour is preserved.
  const a = {
    name: "Login form validation errors displayed correctly",
    description: "Tests login form error display",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/login');",
    steps: ["Go to login", "Submit empty", "Check errors"],
    sourceUrl: "http://app.com/login",
    scenario: "negative",
  };
  const b = {
    name: "Login form validation error displayed correctly",
    description: "Tests login form error display behaviour",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveTitle('Login');",
    steps: ["Go to login", "Submit form", "Check error"],
    sourceUrl: "http://app.com/login",
    scenario: "negative",
  };
  const { unique } = deduplicateTests([a, b]);
  assert.equal(unique.length, 1, "same-scenario similar tests on same page still dedupe");
});

test("deduplicateAcrossRuns: positive + existing negative on same URL → new test passes through", () => {
  const existing = [{
    name: "Login with invalid credentials fails",
    description: "Verify error path when credentials are rejected",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/login');",
    steps: ["Go to login", "Enter invalid credentials", "Submit", "Check error"],
    sourceUrl: "http://app.com/login",
    scenario: "negative",
  }];
  const newTest = {
    name: "Login with valid credentials succeeds",
    description: "Verify happy-path login with correct username + password",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/dashboard');",
    steps: ["Go to login", "Enter valid credentials", "Submit", "Check dashboard"],
    sourceUrl: "http://app.com/login",
    scenario: "positive",
  };
  const result = deduplicateAcrossRuns([newTest], existing);
  assert.equal(
    result.length,
    1,
    "positive-scenario test must pass through when only a negative-scenario exists for the same flow",
  );
});

test("deduplicateAcrossRuns: SAME scenario as existing on same URL → still filtered", () => {
  // No-regression for the cross-run path.
  const existing = [{
    name: "Login with valid credentials succeeds",
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveURL('/dashboard');",
    steps: ["Go to login", "Enter valid credentials", "Submit"],
    sourceUrl: "http://app.com/login",
    scenario: "positive",
  }];
  const newTest = {
    name: "Login with valid credentials succeed",  // tiny diff to exercise fuzzy layer
    playwrightCode: "await page.goto('/login');\nawait expect(page).toHaveTitle('Welcome');",
    steps: ["Go to login", "Enter valid credentials", "Click submit"],
    sourceUrl: "http://app.com/login",
    scenario: "positive",
  };
  const result = deduplicateAcrossRuns([newTest], existing);
  assert.equal(result.length, 0, "same-scenario near-duplicate still filters at cross-run layer");
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.log(`\n⚠️  ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n🎉 All deduplicator-deep tests passed!`);
}

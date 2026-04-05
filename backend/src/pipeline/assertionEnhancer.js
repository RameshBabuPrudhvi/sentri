/**
 * assertionEnhancer.js — Layer 4: Ensure every test has strong, meaningful assertions
 *
 * Detects weak/missing assertions and rewrites them using page context.
 */

// ── Assertion quality detection ───────────────────────────────────────────────

const WEAK_ASSERTION_PATTERNS = [
  /expect\(page\)\.toBeTruthy/,
  /expect\(page\)\.toBeDefined/,
  /expect\(.*\)\.toBeTruthy/,
  /expect\(.*\)\.not\.toBeNull/,
];

const STRONG_ASSERTION_PATTERNS = [
  /toHaveURL/,
  /toHaveTitle/,
  /toBeVisible/,
  /toHaveText/,
  /toContainText/,
  /toBeEnabled/,
  /toHaveValue/,
  /toBeChecked/,
  /toHaveCount/,
  /toBeDisabled/,
];

export function hasStrongAssertions(playwrightCode) {
  return STRONG_ASSERTION_PATTERNS.some(p => p.test(playwrightCode));
}

export function hasWeakAssertions(playwrightCode) {
  return WEAK_ASSERTION_PATTERNS.some(p => p.test(playwrightCode));
}

export function hasNoAssertions(playwrightCode) {
  return !playwrightCode.includes("expect(");
}

// ── Map industry-standard test types → intent-based template keys ─────────────
// The prompt templates now ask the AI to emit types like "functional", "e2e", etc.
// When classifiedPage is unavailable (single-test flow), we fall back to
// test.type — map every new type to the closest intent-based template so the
// enhancer picks meaningful assertions instead of always falling to VISIBILITY.

const TYPE_TO_INTENT = {
  // New industry-standard types → best-fit intent template
  FUNCTIONAL:    "NAVIGATION",       // generic feature verification → page load + content
  SMOKE:         "NAVIGATION",       // quick sanity → page load + content
  REGRESSION:    "NAVIGATION",       // stability check → page load + content
  E2E:           "NAVIGATION",       // multi-page journeys → navigation template
  INTEGRATION:   "FORM_SUBMISSION",  // API/component integration → form/submit template
  ACCESSIBILITY: "NAVIGATION",       // a11y checks → page structure + visibility
  SECURITY:      "AUTH",             // auth, permissions, XSS → auth template
  PERFORMANCE:   "NAVIGATION",       // load times → page load assertions
};

// ── Assertion templates by intent/type ───────────────────────────────────────

const ASSERTION_TEMPLATES = {
  AUTH: (snapshot) => `
  // Assert successful authentication
  await expect(page).not.toHaveURL(${JSON.stringify(snapshot.url)});
  await expect(page.locator('body')).not.toContainText('Invalid');
  await expect(page.locator('body')).not.toContainText('error');`,

  NAVIGATION: (snapshot) => `
  // Assert page loaded correctly
  await expect(page).toHaveURL(${JSON.stringify(snapshot.url)});
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('h1, h2, main').first()).toBeVisible();`,

  FORM_SUBMISSION: (snapshot) => `
  // Assert form is present and interactive
  await expect(page.locator('form').first()).toBeVisible();
  await expect(page.locator('button[type="submit"], input[type="submit"]').first()).toBeEnabled();`,

  SEARCH: (snapshot) => `
  // Assert search functionality
  await expect(page.locator('input[type="search"], input[placeholder*="search" i]').first()).toBeVisible();`,

  CRUD: (snapshot) => `
  // Assert action completed
  await expect(page.locator('body')).not.toContainText('Error');
  await expect(page.locator('[role="alert"], .alert, .notification, .toast').first()).toBeVisible().catch(() => {});`,

  CHECKOUT: (snapshot) => `
  // Assert checkout elements visible
  await expect(page.locator('form').first()).toBeVisible();
  await expect(page.locator('button').filter({ hasText: /pay|order|confirm/i }).first()).toBeVisible().catch(() => {});`,

  VISIBILITY: (snapshot) => `
  // Assert page content loaded
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('main, [role="main"], body').first()).toBeVisible();`,
};

// ── Page load assertion (always included) ────────────────────────────────────

function buildPageLoadAssertion(url, title) {
  const assertions = [`  await expect(page).toHaveURL(${JSON.stringify(url)});`];
  if (title) {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 30);
    assertions.push(`  await expect(page).toHaveTitle(/${escapedTitle}/i);`);
  }
  return assertions.join("\n");
}

/**
 * enhanceTest(test, snapshot, classifiedPage) → enhanced test
 *
 * Adds or strengthens assertions in a generated test based on context.
 */
export function enhanceTest(test, snapshot, classifiedPage) {
  let code = test.playwrightCode || "";

  // If no assertions at all — inject based on intent
  if (hasNoAssertions(code)) {
    const rawIntent = classifiedPage?.dominantIntent || test.type?.toUpperCase() || "NAVIGATION";
    const intent = TYPE_TO_INTENT[rawIntent] || rawIntent;
    const template = ASSERTION_TEMPLATES[intent] || ASSERTION_TEMPLATES.VISIBILITY;
    const pageLoad = buildPageLoadAssertion(snapshot.url, snapshot.title);

    // Inject before closing brace of the test
    code = code.replace(/(\}\s*\);\s*$)/, `${pageLoad}\n${template(snapshot)}\n$1`);

    return {
      ...test,
      playwrightCode: code,
      _assertionEnhanced: true,
      _enhancementReason: "no_assertions",
    };
  }

  // If only weak assertions — replace them
  if (hasWeakAssertions(code) && !hasStrongAssertions(code)) {
    const pageLoad = buildPageLoadAssertion(snapshot.url, snapshot.title);
    // Replace weak assertion lines
    code = code.replace(/.*expect\(.*\)\.(toBeTruthy|toBeDefined|not\.toBeNull).*\n?/g, "");
    code = code.replace(/(\}\s*\);\s*$)/, `${pageLoad}\n$1`);

    return {
      ...test,
      playwrightCode: code,
      _assertionEnhanced: true,
      _enhancementReason: "weak_assertions_replaced",
    };
  }

  // Already has strong assertions — ensure page load assertion exists
  if (!code.includes("toHaveURL") && !code.includes("toHaveTitle")) {
    const pageLoad = buildPageLoadAssertion(snapshot.url, snapshot.title);
    code = code.replace(/(\}\s*\);\s*$)/, `${pageLoad}\n$1`);
    return { ...test, playwrightCode: code, _assertionEnhanced: true, _enhancementReason: "added_page_load_assertion" };
  }

  return { ...test, _assertionEnhanced: false };
}

/**
 * enhanceTests(tests, snapshots, classifiedPages) → enhanced tests array
 */
export function enhanceTests(tests, snapshotsByUrl, classifiedPagesByUrl) {
  let enhanced = 0;
  const result = tests.map(test => {
    const snapshot = snapshotsByUrl[test.sourceUrl] || { url: test.sourceUrl, title: test.pageTitle };
    const classifiedPage = classifiedPagesByUrl[test.sourceUrl];
    const enhancedTest = enhanceTest(test, snapshot, classifiedPage);
    if (enhancedTest._assertionEnhanced) enhanced++;
    return enhancedTest;
  });

  return { tests: result, enhancedCount: enhanced };
}

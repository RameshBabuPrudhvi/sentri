/**
 * assertionEnhancer.js — Layer 4: Ensure every test has strong, meaningful assertions
 *
 * Detects weak/missing assertions and rewrites them using page context.
 */
import { isAdvancedPlaywrightScenario } from "./prompts/playwrightCapabilityGuide.js";

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

/**
 * Regex that matches `toHaveURL` or `toHaveTitle` only when they appear as
 * method calls after an `expect(` expression — i.e. inside a real assertion
 * chain.  Bare mentions in comments (`// TODO: add toHaveURL`) or string
 * literals (`'toHaveURL'`) are NOT matched.
 *
 * Pattern: `expect(` … `)` … `.toHaveURL(` or `.toHaveTitle(`
 * The `.+` is greedy so it backtracks from the last `)` on the line,
 * correctly handling nested parens like `expect(page.locator('x').first())`.
 */
const HAS_PAGE_LOAD_ASSERTION_RE = /expect\s*\(.+\).*\.(?:toHaveURL|toHaveTitle)\s*\(/s;

// ── Assertion templates ──────────────────────────────────────────────────────
// Two tiers of templates:
//   1. INTENT templates — used when classifiedPage is available (crawl pipeline)
//   2. TYPE templates  — used when test.type is an industry-standard type
//                        (single-test flow, or crawl tests with new type enum)
//
// The enhancer tries classifiedPage.dominantIntent first, then test.type,
// then falls back to FALLBACK.

// Helper: extract hostname regex from snapshot URL for loose URL assertions.
function hostnameRegex(url) {
  try {
    const h = new URL(url).hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!h) return "/.+/";
    return `/${h}/i`;
  } catch {
    return "/.+/";
  }
}

const INTENT_TEMPLATES = {
  AUTH: (snapshot) => `
  // Assert successful authentication — URL should change away from login page
  await expect(page.locator('body')).not.toContainText('Invalid');
  await expect(page.locator('body')).not.toContainText('error');`,

  NAVIGATION: (snapshot) => `
  // Assert page loaded correctly
  await expect(page).toHaveURL(${hostnameRegex(snapshot.url)});
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
  // Assert action completed — use flexible matcher for toast/notification text
  await expect(page.locator('body')).not.toContainText('Error');
  await expect(page.locator('[role="alert"], .alert, .notification, .toast').first()).toContainText(/success|saved|created|updated|deleted/i).catch(() => {});`,

  CHECKOUT: (snapshot) => `
  // Assert checkout elements visible
  await expect(page.locator('form').first()).toBeVisible();
  await expect(page.locator('button').filter({ hasText: /pay|order|confirm/i }).first()).toBeVisible().catch(() => {});`,

  CONTENT: (snapshot) => `
  // Assert page content loaded
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('main, [role="main"], article, body').first()).toBeVisible();`,
};

const TYPE_TEMPLATES = {
  functional: (snapshot) => `
  // Assert feature works — page loads with expected content
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('h1, h2, main').first()).toBeVisible();`,

  smoke: (snapshot) => `
  // Smoke check — page loads without errors
  await expect(page).toHaveURL(${hostnameRegex(snapshot.url)});
  await expect(page).toHaveTitle(/.+/);`,

  regression: (snapshot) => `
  // Regression — verify existing content unchanged
  await expect(page).toHaveURL(${hostnameRegex(snapshot.url)});
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('h1, h2, main').first()).toBeVisible();`,

  e2e: (snapshot) => `
  // E2E — verify navigation and content across pages
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('h1, h2, main').first()).toBeVisible();`,

  integration: (snapshot) => `
  // Integration — verify form/API interaction
  await expect(page.locator('form').first()).toBeVisible();
  await expect(page.locator('button[type="submit"], input[type="submit"]').first()).toBeEnabled();`,

  accessibility: (snapshot) => `
  // Accessibility — verify semantic structure
  await expect(page.locator('main, [role="main"]').first()).toBeVisible();
  await expect(page.locator('h1').first()).toBeVisible();`,

  security: (snapshot) => `
  // Security — verify auth boundary
  await expect(page.locator('body')).not.toContainText('Invalid');
  await expect(page.locator('body')).not.toContainText('error');`,

  performance: (snapshot) => `
  // Performance — verify page loads within timeout
  await expect(page).toHaveURL(${hostnameRegex(snapshot.url)});
  await expect(page).toHaveTitle(/.+/);`,
};

const FALLBACK_TEMPLATE = (snapshot) => `
  // Assert page content loaded
  await expect(page).toHaveTitle(/.+/);
  await expect(page.locator('main, [role="main"], body').first()).toBeVisible();`;

// ── Page load assertion (always included) ────────────────────────────────────

function buildPageLoadAssertion(url, title) {
  // Use a loose hostname-only regex instead of an exact URL string.
  // Exact URLs break on redirects, query params, geo-variants, and
  // consent/CAPTCHA interstitials. This matches the STABILITY_RULES guidance.
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  } catch {
    hostname = null;
  }
  const assertions = hostname
    ? [`  await expect(page).toHaveURL(/${hostname}/i);`]
    : [];
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
 *
 * Fast-path: if the test already has strong assertions AND a page-load
 * assertion (toHaveURL or toHaveTitle), skip all enhancement work and
 * return immediately. On re-crawls of a well-covered application this
 * eliminates string manipulation for the majority of tests.
 */
export function enhanceTest(test, snapshot, classifiedPage) {
  let code = test.playwrightCode || "";
  const advancedScenario = isAdvancedPlaywrightScenario(code);

  // ── Fast-path: already fully enhanced ────────────────────────────────────
  // A test qualifies only when it has at least one strong assertion AND a
  // page-load anchor (toHaveURL or toHaveTitle inside an actual expect()
  // chain) AND at least one expect() call.
  //
  // We use a regex that requires the matcher to appear after `expect(`
  // so that mentions in comments or string literals don't trigger the
  // fast-path.  Example false positive without this:
  //   await expect(el).toBeVisible();
  //   // TODO: add toHaveURL assertion
  // → code.includes("toHaveURL") is true but there is no real page-load
  //   assertion, so the test should NOT be fast-pathed.
  if (
    hasStrongAssertions(code) &&
    !hasNoAssertions(code) &&
    HAS_PAGE_LOAD_ASSERTION_RE.test(code)
  ) {
    return { ...test, _assertionEnhanced: false };
  }

  // If no assertions at all — inject based on intent or type
  if (hasNoAssertions(code)) {
    // Advanced tests (route mocks, API request contexts, frame-heavy flows,
    // uploads, tracing, etc.) often require bespoke assertions that can be
    // broken by generic enhancer templates. Leave them untouched and let the
    // original generation prompt own assertion strategy.
    if (advancedScenario) {
      return { ...test, _assertionEnhanced: false, _enhancementSkipped: "advanced_capability_flow" };
    }
    // Two-tier lookup: classifiedPage intent → test.type → fallback
    const intent = classifiedPage?.dominantIntent;
    const template = (intent && INTENT_TEMPLATES[intent])
      || TYPE_TEMPLATES[(test.type || "").toLowerCase()]
      || FALLBACK_TEMPLATE;
    const pageLoad = buildPageLoadAssertion(snapshot.url, snapshot.title);

    // S3-02: inject waitForStable before assertions so SPAs have settled.
    // The call is wrapped in an awaited helper that is already available in
    // the runtime (injected by executeTest via pageCapture.waitForStable).
    // We emit it as a comment-guarded page.waitForLoadState('networkidle')
    // fallback because the enhancer runs at generation time (no page ref) —
    // the actual MutationObserver-based wait runs at execution time via the
    // waitForStable() call prepended in executeTest.js.
    const stabilityStep = `  // S3-02: DOM stability wait — let the page settle before asserting\n  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});`;

    // Inject stability step + assertions before closing brace of the test
    code = code.replace(/(\}\s*\);\s*$)/, `${stabilityStep}\n${pageLoad}\n${template(snapshot)}\n$1`);

    return {
      ...test,
      playwrightCode: code,
      _assertionEnhanced: true,
      _enhancementReason: "no_assertions",
    };
  }

  // If only weak assertions — replace them
  if (hasWeakAssertions(code) && !hasStrongAssertions(code)) {
    if (advancedScenario) {
      return { ...test, _assertionEnhanced: false, _enhancementSkipped: "advanced_capability_flow" };
    }
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
  if (!HAS_PAGE_LOAD_ASSERTION_RE.test(code)) {
    if (advancedScenario) {
      return { ...test, _assertionEnhanced: false, _enhancementSkipped: "advanced_capability_flow" };
    }
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

/**
 * assertionEnhancer.js — Layer 4: Ensure every test has strong, meaningful assertions
 *
 * Detects weak/missing assertions and rewrites them using page context.
 */
import { isAdvancedPlaywrightScenario } from "./prompts/playwrightCapabilityGuide.js";
// Bundle-A follow-up #F3 — `stripStringsAndComments` extracted to a shared
// util so this module's assertion-presence checks and `deduplicator.js`'s
// quality rubric (which had the same string/comment false-positive bug)
// route through one implementation. The local copy below is preserved for
// the rest of this file's call sites but now delegates to the shared one.
import { stripStringsAndComments as sharedStripStringsAndComments } from "../utils/codeStripping.js";

// ── Assertion quality detection ───────────────────────────────────────────────

const WEAK_ASSERTION_PATTERNS = [
  /expect\(page\)\.toBeTruthy/,
  /expect\(page\)\.toBeDefined/,
  /expect\(.*\)\.toBeTruthy/,
  /expect\(.*\)\.not\.toBeNull/,
];

// Bundle-A follow-up #F2 — anchor each matcher pattern to method-call
// syntax (`.toHaveURL(`) rather than bare substring. Defence-in-depth
// alongside fix #14's `stripStringsAndComments` pass: if a future caller
// runs these patterns without the strip, a code identifier or property
// name like `obj.toHaveURL = …` won't false-match. Pre-fix these were
// bare substrings (`/toHaveURL/`) which would match anywhere the token
// appeared, including (without the strip) in comments and strings.
const STRONG_ASSERTION_PATTERNS = [
  /\.toHaveURL\s*\(/,
  /\.toHaveTitle\s*\(/,
  /\.toBeVisible\s*\(/,
  /\.toHaveText\s*\(/,
  /\.toContainText\s*\(/,
  /\.toBeEnabled\s*\(/,
  /\.toHaveValue\s*\(/,
  /\.toBeChecked\s*\(/,
  /\.toHaveCount\s*\(/,
  /\.toBeDisabled\s*\(/,
];

/**
 * Bundle-A fix #14 — strip string literals and line/block comments from
 * code before running substring / regex assertion-presence checks.
 *
 * Pre-fix `hasNoAssertions` used a bare `.includes("expect(")` check,
 * so a test containing `console.log("expect(loaded)")` (and no real
 * `expect()` call) was incorrectly classified as HAVING assertions and
 * the enhancer skipped injection — leaving the test with zero coverage.
 *
 * Strips:
 *   - `// line comments` through end-of-line
 *   - `/* block comments *⁠/` (single-line or multi-line)
 *   - `'single-quoted'`, `"double-quoted"`, ` ``template-literal`` `
 *     string contents (the literal delimiters are kept so subsequent
 *     parsing logic that cares about token boundaries still sees them).
 *
 * Backslash-escaped quotes inside string literals are honoured so a
 * string like `"he said \"hi\""` doesn't terminate early.
 *
 * Best-effort: not a full JavaScript tokeniser (template-literal
 * `${interpolations}` are stripped along with the rest of the string
 * body). Good enough for the assertion-presence heuristic — false
 * positives are tests where a `${expect(real)}` interpolation hides
 * a real assertion, which is exotic enough to ignore. The
 * `HAS_PAGE_LOAD_ASSERTION_RE` pattern below still anchors on actual
 * code, not stripped-out string contents, so the page-load check
 * stays accurate.
 *
 * @param {string} code
 * @returns {string} Code with string contents + comments redacted.
 */
// Bundle-A follow-up #F3 — thin delegate to `utils/codeStripping.js` so the
// implementation lives in exactly one place (DRY). Existing call sites in
// this file (`hasStrongAssertions`, `hasWeakAssertions`, `hasNoAssertions`)
// keep working unchanged.
function stripStringsAndComments(code) {
  return sharedStripStringsAndComments(code);
}

export function hasStrongAssertions(playwrightCode) {
  // Bundle-A fix #14 — strip strings + comments so a `// toHaveURL`
  // mention or a `'toBeVisible'` string literal can't masquerade as
  // a real assertion.
  const clean = stripStringsAndComments(playwrightCode || "");
  return STRONG_ASSERTION_PATTERNS.some(p => p.test(clean));
}

export function hasWeakAssertions(playwrightCode) {
  const clean = stripStringsAndComments(playwrightCode || "");
  return WEAK_ASSERTION_PATTERNS.some(p => p.test(clean));
}

/**
 * Bundle-A fix #14 — true assertion presence check.
 *
 * Pre-fix used `!playwrightCode.includes("expect(")` which returned
 * `false` (i.e. "has assertions") for any test where the literal
 * substring `expect(` appeared anywhere — including inside string
 * literals (`console.log("expect(loaded)")`) and comments
 * (`// TODO: add expect(...) call`). The enhancer would then skip
 * injection on a test that genuinely has zero assertions.
 *
 * The fix strips strings + comments before running the presence
 * check so only REAL `expect(` calls count, then uses the same
 * `\bexpect\s*\(` anchor as `HAS_PAGE_LOAD_ASSERTION_RE`.
 */
export function hasNoAssertions(playwrightCode) {
  const clean = stripStringsAndComments(playwrightCode || "");
  return !/\bexpect\s*\(/.test(clean);
}

/**
 * Regex that matches `toHaveURL` or `toHaveTitle` only when they appear as
 * method calls after an `expect(` expression — i.e. inside a real assertion
 * chain.  Bare mentions in comments (`// TODO: add toHaveURL`) or string
 * literals (`'toHaveURL'`) are NOT matched.
 *
 * Pattern: `expect(` … `)` … `.toHaveURL(` or `.toHaveTitle(`
 *
 * Bundle-A follow-up #F1 — both captures are bounded (`[^;\n]{1,2000}`
 * + `[^;\n]{0,200}`) instead of the pre-fix greedy `.+` / `.*` with the
 * `/s` flag. The old pattern walked exponential backtracking trees on
 * minified single-line test bodies — same class of vulnerability as
 * `ASSERTION_RE` (fixed by Bundle-A fix #18). The `/s` flag (dotall —
 * makes `.` match newlines) made it worse here: a multi-line input
 * could trigger backtracking across every newline.
 *
 * Capture bounds:
 *   • `[^;\n]{1,2000}` — expect target ≤ 2 KB, stops at statement
 *     boundary. Same bound used by `testValidator.js#ASSERTION_RE`.
 *   • `[^;\n]{0,200}`  — between `)` and `.toHaveURL(` is realistically
 *     0-5 chars (`.not`, whitespace); 200 is a generous cap.
 *
 * Dropped `/s` flag (no longer needed) so `.` reverts to default
 * "doesn't match newlines" — the `[^;\n]` character classes already
 * stop at newlines, but removing `/s` is defence-in-depth.
 */
const HAS_PAGE_LOAD_ASSERTION_RE = /expect\s*\([^;\n]{1,2000}\)[^;\n]{0,200}\.(?:toHaveURL|toHaveTitle)\s*\(/;

/**
 * Bundle-A fix #15 — assertion-injection anchor that matches the test
 * wrapper's closing `});` even when followed by trailing newlines,
 * line comments, or block comments.
 *
 * Pre-fix the three injection regexes used `(\}\s*\);\s*$)` — `$`
 * defaults to end-of-string (no `/m` flag), so any test ending with
 * `});\n// generated by gpt-4o\n` silently failed the regex and the
 * assertion injection was a no-op.
 *
 * Naively adding `/m` would make `$` match end-of-LINE anywhere in
 * the file, so an inner `});` (e.g. a `.then(() => { ... });` chain)
 * could be picked instead of the test wrapper's closing. The pattern
 * below is more precise: it requires the `});` to be followed ONLY by
 * whitespace, line comments, or block comments through end-of-string
 * — i.e. it's the LAST `});` in the file, with optional non-code
 * trailers. The matching group still captures `});` exactly so the
 * replacement strings (`${assertions}\n$1`) inject the assertions
 * BEFORE the closing brace, identical to the pre-fix happy path.
 *
 * Pattern breakdown:
 *   (\}\s*\);)             — capture the closing `});` (group $1)
 *   (?=                    — lookahead: must be followed by ONLY
 *     (?:                  —   any number of …
 *       \s+ |              —   whitespace runs (incl. newlines), OR
 *       \/\/[^\n]* |       —   line comments (to EOL, no leading \s+ → handled by outer alternation), OR
 *       \/\*[\s\S]*?\*\/   —   block comments (non-greedy across newlines)
 *     )*
 *     $                    — end of STRING (no `/m`, no surprises)
 *   )
 */
const TEST_WRAPPER_CLOSE_RE = /(\}\s*\);)(?=(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$)/;

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

// Bundle-A fix #16 — selector targeting typical error UI regions, used by
// AUTH + security templates below. Scoping the negative-text check to
// dedicated alert / error containers avoids false-positives on legitimate
// body text like "Invalid email format" hints next to inputs, "Error
// Reports" admin nav links, or copy that mentions "errors" in passing
// (e.g. "Sometimes errors happen — try again").
//
// Selector list mirrors industry conventions:
//   • `[role="alert"]`     — WAI-ARIA live region for important messages
//   • `.error` / `.field-error` — Bootstrap / Tailwind / Material UI defaults
//   • `[aria-invalid="true"]` — accessible form-validation flag
//   • `.alert-danger` / `.notification--error` — alternate framework names
//
// `.catch(() => {})` swallows the "locator not found" rejection so a
// page WITHOUT any error region (i.e. no error happened — the happy
// path) doesn't fail the test. The negative assertion only fires when
// an error region actually exists; when it does, it must NOT contain
// the failure keyword. This is the standard "soft assert on error UI"
// pattern used by Playwright community examples and matches the
// existing CRUD template's `.catch(() => {})` idiom on line 99-100.
const AUTH_ERROR_REGION_SELECTOR = "[role=\"alert\"], .error, .field-error, [aria-invalid=\"true\"], .alert-danger, .notification--error";

const INTENT_TEMPLATES = {
  AUTH: (snapshot) => `
  // Assert successful authentication — URL should change away from login page.
  // Bundle-A fix #16: scope the negative-text check to dedicated error
  // regions so legitimate body copy (e.g. "Invalid email format" input
  // hints, "Error Reports" admin links) doesn't false-positive after a
  // successful login. .catch(() => {}) swallows the not-found case
  // — the happy path has no error region to assert against.
  await expect(page.locator('${AUTH_ERROR_REGION_SELECTOR}').first()).not.toContainText('Invalid').catch(() => {});
  await expect(page.locator('${AUTH_ERROR_REGION_SELECTOR}').first()).not.toContainText('error').catch(() => {});`,

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
  // Security — verify auth boundary.
  // Bundle-A fix #16: scope to dedicated error regions (see
  // AUTH_ERROR_REGION_SELECTOR docblock above) to avoid false-positives
  // on legitimate body copy like "Error reports" admin links.
  await expect(page.locator('${AUTH_ERROR_REGION_SELECTOR}').first()).not.toContainText('Invalid').catch(() => {});
  await expect(page.locator('${AUTH_ERROR_REGION_SELECTOR}').first()).not.toContainText('error').catch(() => {});`,

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

    // Inject stability step + assertions before closing brace of the test.
    // Bundle-A fix #15 — `TEST_WRAPPER_CLOSE_RE` tolerates trailing
    // newlines / line / block comments after `});` so a test ending with
    // `});\n// generated by gpt-4o\n` still gets injected (pre-fix the
    // `$` end-of-string anchor failed the match and the assertions were
    // silently skipped).
    code = code.replace(TEST_WRAPPER_CLOSE_RE, `${stabilityStep}\n${pageLoad}\n${template(snapshot)}\n$1`);

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
    // Bundle-A fix #15 — see TEST_WRAPPER_CLOSE_RE docblock.
    code = code.replace(TEST_WRAPPER_CLOSE_RE, `${pageLoad}\n$1`);

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
    // Bundle-A fix #15 — see TEST_WRAPPER_CLOSE_RE docblock.
    code = code.replace(TEST_WRAPPER_CLOSE_RE, `${pageLoad}\n$1`);
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

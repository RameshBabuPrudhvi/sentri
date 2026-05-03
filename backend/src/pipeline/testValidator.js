/**
 * testValidator.js — Rejects malformed or placeholder tests before they enter the DB
 *
 * Mostly pure — only side effect is the lazy, memoised `.github/.gitleaks.toml`
 * read performed by `secretScanner.loadSecretRules()` on first call to
 * `scanForSecrets()` (the CAP-003 gate). That read happens at most once per
 * process lifetime; the result is cached for subsequent calls.
 *
 * Exports:
 *   validateTest(test, projectUrl)          → string[]  (empty = valid)
 *   validateLocators(code)                  → string[]
 *   validateActions(code)                   → string[]
 *   validateAssertions(code)                → string[]
 *   validateSafeHelperUsage(code)           → string[]
 */

import { VALID_TEST_TYPES } from "./prompts/outputSchema.js";
import { extractTestBody, stripPlaywrightImports, patchNetworkIdle, repairBrokenStringLiterals } from "../runner/codeParsing.js";
import { looksLikeCssSelector } from "../utils/selectorHeuristics.js";
import { scanForSecrets } from "./secretScanner.js";
import { parse } from "acorn";

const VALID_TYPES_SET = new Set(VALID_TEST_TYPES);

// ---------------------------------------------------------------------------
// Defect #2 — Action method whitelist
// ---------------------------------------------------------------------------

/**
 * Complete whitelist of Playwright API methods that Sentri-generated tests
 * are expected to call. Any method call on `page`, `locator()`, or `expect()`
 * that is NOT in this set is flagged as an invalid action.
 *
 * Grouped for readability; the Set is what drives validation.
 */
const VALID_PAGE_ACTIONS = new Set([
  // Browser / context lifecycle
  "launch", "newContext", "newPage", "close", "storageState",
  "addCookies", "clearCookies", "cookies", "grantPermissions", "clearPermissions",
  "setGeolocation", "setExtraHTTPHeaders", "setDefaultTimeout", "setDefaultNavigationTimeout",
  "tracing", "start", "stop", "startChunk", "stopChunk",
  // Navigation
  "goto", "goBack", "goForward", "reload", "waitForURL",
  // Interaction
  "click", "dblclick", "fill", "type", "press", "pressSequentially",
  "hover", "focus", "blur", "tap", "check", "uncheck", "selectOption",
  "dispatchEvent", "dragAndDrop", "dragTo", "setInputFiles",
  // Waiting
  "waitForLoadState", "waitForNavigation", "waitForSelector",
  "waitForFunction", "waitForTimeout", "waitForRequest", "waitForResponse",
  "waitForEvent",
  // Routing / network control
  "route", "unroute", "routeFromHAR", "fulfill", "continue", "fallback", "abort",
  // Extraction
  "textContent", "getAttribute", "innerHTML", "innerText", "inputValue",
  "isChecked", "isDisabled", "isEditable", "isEnabled", "isHidden", "isVisible",
  "url", "title", "content",
  // Locators (return locator objects, not results)
  "locator", "getByRole", "getByLabel", "getByText", "getByPlaceholder",
  "getByAltText", "getByTitle", "getByTestId", "frameLocator",
  // Locator terminal actions (called on locator, not page)
  "waitFor", "count", "nth", "first", "last", "filter", "all",
  "screenshot", "scrollIntoViewIfNeeded", "selectText",
  // Emulation / page configuration
  "setViewportSize", "emulateMedia", "addInitScript",
  // Evaluate-on-selector variants (Ollama frequently uses these)
  "$eval", "$$eval", "$", "$$", "$x",
  // Expect (assertion builder)
  "expect",
  // API / request context (for api tests)
  "get", "post", "put", "patch", "delete", "head", "fetch", "dispose",
  // Test runner structure / diagnostics
  "describe", "beforeEach", "afterEach", "beforeAll", "afterAll", "step",
  "setTimeout", "slow", "fixme", "skip", "fail", "info", "attach",
  "soft", "poll", "configure", "use", "extend", "only",
  // Misc
  "evaluate", "evaluateHandle",
  "keyboard", "mouse", "touchscreen",
  "on", "once", "off",
]);

/**
 * Pattern that matches any method call on page/locator/expect in Playwright code.
 * Captures: the receiver expression + the method name.
 *   e.g.  page.clicks(...)  →  method = "clicks"
 *         locator.fillup()  →  method = "fillup"
 */
const ACTION_CALL_RE = /(?<![a-zA-Z0-9_$])(?:page|locator|frame|context|request|browser|api|test|expect|testInfo|route)\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

/**
 * validateActions(code) → string[]
 *
 * Scans all method calls on `page`, `locator`, `frame`, `context`, and
 * `request` and flags any that are not in VALID_PAGE_ACTIONS.
 *
 * Resolves defect #2 — catches typos like `.clicks()`, `.fillIn()`, `.toHavURL()`.
 *
 * @param {string} code - Playwright test code
 * @returns {string[]} Array of issue strings (empty = all actions valid)
 */
export function validateActions(code) {
  if (!code) return [];
  const issues = [];
  const seen = new Set();
  let m;
  ACTION_CALL_RE.lastIndex = 0;
  while ((m = ACTION_CALL_RE.exec(code)) !== null) {
    const method = m[1];
    if (!VALID_PAGE_ACTIONS.has(method) && !seen.has(method)) {
      seen.add(method);
      issues.push(`invalid Playwright method ".${method}()" — not a recognised API`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Defect #3 — Assertion chain validation
// ---------------------------------------------------------------------------

/**
 * All Playwright matcher names (with and without "not." prefix).
 * Source: https://playwright.dev/docs/api/class-locatorassertions
 */
const VALID_MATCHERS = new Set([
  // Page assertions
  "toHaveURL", "toHaveTitle",
  // Locator assertions
  "toBeAttached", "toBeChecked", "toBeDisabled", "toBeEditable",
  "toBeEmpty", "toBeEnabled", "toBeFocused", "toBeHidden", "toBeInViewport",
  "toBeVisible", "toContainText", "toHaveAccessibleDescription",
  "toHaveAccessibleName", "toHaveAttribute", "toHaveClass", "toHaveCount",
  "toHaveCSS", "toHaveId", "toHaveJSProperty", "toHaveRole",
  "toHaveScreenshot", "toHaveText", "toHaveValue", "toHaveValues",
  // Generic
  "toBe", "toEqual", "toBeTruthy", "toBeFalsy", "toBeDefined",
  "toBeNull", "toBeUndefined", "toBeNaN", "toBeGreaterThan",
  "toBeGreaterThanOrEqual", "toBeLessThan", "toBeLessThanOrEqual",
  "toContain", "toMatch", "toMatchObject", "toHaveLength", "toThrow",
  "toHaveProperty",  // Jest/Node — common in API tests (body.toHaveProperty('key'))
  // Snapshot
  "toMatchSnapshot",
]);

/**
 * Matches the full assertion chain after expect():
 *   expect(page).toHaveURL(...)
 *   expect(locator).not.toBeVisible()
 *   expect(value).toBe(...)
 *   expect(page.locator('...').first()).toBeVisible()
 *
 * Uses greedy `.+` so the regex backtracks from the last `)` on the
 * line, correctly handling nested parentheses inside the expect()
 * expression (e.g. `.locator(...).first()`).
 *
 * Groups:
 *   [1] target expression inside expect(...)
 *   [2] optional ".not" negation
 *   [3] matcher name
 */
const ASSERTION_RE = /expect\s*\((.+)\)\s*(\.not)?\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

/**
 * Matchers that must NOT be used with .not because the negated form is
 * logically redundant or always-passes (Playwright warns/errors on these).
 */
const NO_NEGATE_MATCHERS = new Set([
  "toBeHidden",   // .not.toBeHidden() === toBeVisible() — use the positive form
  "toBeDisabled", // .not.toBeDisabled() === toBeEnabled()
  "toBeFalsy",    // .not.toBeFalsy() is confusing — use toBeTruthy()
  "toBeNull",     // .not.toBeNull() rarely meaningful in Playwright context
]);

/**
 * validateAssertions(code) → string[]
 *
 * Validates every expect() call in the code:
 *   - Matcher must be a known Playwright method (catches typos like toHavURL)
 *   - .not must not be paired with logically-redundant matchers
 *
 * Resolves defect #3.
 *
 * @param {string} code
 * @returns {string[]}
 */
/**
 * Promise-chain methods that can appear after an expect() assertion chain
 * but are NOT assertion matchers. The greedy ASSERTION_RE can capture these
 * when `.catch(() => {})` or `.then(...)` follows an expect chain (e.g.
 * `expect(loc).toContainText(/x/).catch(() => {})`). Skip them silently.
 */
const PROMISE_CHAIN_METHODS = new Set(["catch", "then", "finally"]);

export function validateAssertions(code) {
  if (!code) return [];
  const issues = [];
  const seenMatchers = new Set();
  let m;
  ASSERTION_RE.lastIndex = 0;
  while ((m = ASSERTION_RE.exec(code)) !== null) {
    const matcher = m[3];
    const isNegated = Boolean(m[2]);

    // Skip promise-chain methods that the greedy regex can over-match
    if (PROMISE_CHAIN_METHODS.has(matcher)) continue;

    if (!VALID_MATCHERS.has(matcher) && !seenMatchers.has(matcher)) {
      seenMatchers.add(matcher);
      issues.push(`unknown assertion matcher ".${matcher}()" — check for typos (e.g. toHavURL → toHaveURL)`);
    }

    if (isNegated && NO_NEGATE_MATCHERS.has(matcher)) {
      issues.push(
        `.not.${matcher}() is logically redundant — use the positive counterpart instead`
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Safe-helper enforcement (TC-7 regression) — raw-CSS `expect(page.locator(...))`
// chains bypass the self-healing waterfall, so a brittle class rename or
// empty-state edge case silently fails the whole test. Force the AI to use
// either a semantic locator (getByRole / getByText / getByLabel / getByTestId)
// or the `safeExpect(page, expect, text, role?)` helper, which falls back
// through ~20 role/text/label strategies.
// ---------------------------------------------------------------------------

/**
 * Matchers that have a safe-helper equivalent and therefore should not be
 * chained off a raw `page.locator(<cssSelector>)` expression. Tests that
 * combine these with raw-CSS locators are rejected so the generator retries.
 *
 * NOTE: `toHaveCount`, `toBeHidden`, `toHaveValue`, `toHaveAttribute`,
 * `toHaveClass`, and `toHaveCSS` are intentionally **not** listed here —
 * the `SELF_HEALING_PROMPT_RULES` in `selfHealing.js` explicitly tells the
 * AI to use `page.locator(...)` for count/state/attribute assertions, so
 * rejecting those would contradict the generation prompt. Only visibility
 * and textual-content assertions are enforced to go through `safeExpect`.
 */
const SAFE_HELPER_MATCHERS = new Set([
  "toBeVisible",
  "toContainText",
  "toHaveText",
]);

/**
 * Captures `expect(page.locator(<literal>)).[not.]<matcher>(...)` chains.
 * Only literal-string locator arguments are matched — dynamic locator
 * expressions (variables, chained `.first()`, etc.) are outside scope and
 * get a pass. Three quote alternations mirror the other RE helpers so
 * inner quotes (`"[data-id='x']"`) don't truncate the capture.
 */
const EXPECT_LOCATOR_RE =
  /expect\s*\(\s*page\s*\.\s*locator\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s*\)\s*\)\s*(?:\.not)?\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

/**
 * validateSafeHelperUsage(code) → string[]
 *
 * Rejects `expect(page.locator('<cssSelector>')).<visibilityMatcher>(...)`
 * chains. These bypass the self-healing locator waterfall and so fail
 * silently when the class/id is renamed or the element only renders in a
 * subset of UI states (the TC-7 regression where `.todo-count` was missing
 * in TodoMVC's empty state).
 *
 * The AI is expected to use one of:
 *   - `await safeExpect(page, expect, '<visible text>', '<role>')`
 *   - `expect(page.getByRole('<role>', { name: '<text>' })).<matcher>(...)`
 *   - `expect(page.getByText('<text>')).<matcher>(...)`
 *
 * Human-readable arguments (e.g. `locator('Submit')`) are a no-op for
 * `page.locator()` anyway — Playwright will simply fail to find them —
 * so they're left for the existing locator validator to flag.
 *
 * @param {string} code
 * @returns {string[]}
 */
export function validateSafeHelperUsage(code) {
  if (!code) return [];
  const issues = [];
  const seen = new Set();
  let m;
  EXPECT_LOCATOR_RE.lastIndex = 0;
  while ((m = EXPECT_LOCATOR_RE.exec(code)) !== null) {
    const selector = m[1] || m[2] || m[3];
    const matcher = m[4];
    if (!SAFE_HELPER_MATCHERS.has(matcher)) continue;
    if (!looksLikeCssSelector(selector)) continue;
    const key = `${matcher}::${selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(
      `raw-CSS locator assertion expect(page.locator("${selector}")).${matcher}(...) — `
      + `use safeExpect(page, expect, "<visible text>") or a semantic locator `
      + `(getByRole/getByText/getByLabel/getByTestId) so the assertion survives `
      + `class renames and empty-state edge cases`
    );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Defect #1 — Locator validation
// ---------------------------------------------------------------------------

/**
 * CSS pseudo-classes that are valid in a browser context.
 * Any other :<word> pseudo is flagged as suspicious.
 */
const VALID_CSS_PSEUDOS = new Set([
  "root", "nth-child", "nth-of-type", "nth-last-child", "nth-last-of-type",
  "first-child", "last-child", "first-of-type", "last-of-type",
  "only-child", "only-of-type", "not", "is", "where", "has",
  "hover", "focus", "focus-within", "focus-visible", "active", "visited",
  "checked", "disabled", "enabled", "placeholder", "empty", "target",
  "link", "any-link", "local-link", "scope", "matches",
  // Form-related pseudo-classes (commonly used in form validation tests)
  "required", "optional", "valid", "invalid", "read-only", "read-write",
  "placeholder-shown", "indeterminate", "default", "defined",
  "in-range", "out-of-range",
  // Playwright-specific
  "visible", "hidden", "text", "has-text", "above", "below", "near",
  "left-of", "right-of",
]);

/**
 * Captures CSS selector arguments passed to .locator(), .querySelector*,
 * or .waitForSelector().
 *
 * Three alternations handle the three JS string delimiters so that a
 * quote character different from the outer delimiter (e.g. `"` inside a
 * `'`-delimited string) does not prematurely terminate the capture.
 * Without this, selectors like `'button[type="submit"]'` or XPaths like
 * `'//div[@id="main"]'` would be truncated at the inner `"`.
 */
const CSS_LOCATOR_RE = /(?:locator|querySelector|waitForSelector|waitForSelectorAll)\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;

/**
 * Captures XPath strings (detected by leading // or (// patterns).
 *
 * Same three-alternation strategy as CSS_LOCATOR_RE above.
 */
const XPATH_LOCATOR_RE = /(?:locator|querySelector|waitForSelector)\s*\(\s*(?:"((?:\/\/|\(\/\/)[^"]+)"|'((?:\/\/|\(\/\/)[^']+)'|`((?:\/\/|\(\/\/)[^`]+)`)/g;

/**
 * Validates a CSS selector string for obvious structural errors.
 * Not a full CSS parser — catches the most common AI mistakes.
 *
 * @param {string} selector
 * @returns {string|null} Error description or null if OK
 */
function checkCssSelector(selector) {
  // Unclosed brackets
  const openSquare = (selector.match(/\[/g) || []).length;
  const closeSquare = (selector.match(/\]/g) || []).length;
  if (openSquare !== closeSquare) {
    return `CSS selector has unbalanced brackets: "${selector}"`;
  }
  const openParen = (selector.match(/\(/g) || []).length;
  const closeParen = (selector.match(/\)/g) || []).length;
  if (openParen !== closeParen) {
    return `CSS selector has unbalanced parentheses: "${selector}"`;
  }

  // Unknown pseudo-class
  const pseudoMatch = selector.match(/:([a-zA-Z-]+)/g);
  if (pseudoMatch) {
    for (const pseudo of pseudoMatch) {
      const name = pseudo.slice(1).toLowerCase().replace(/^:/, "");
      if (!VALID_CSS_PSEUDOS.has(name)) {
        return `CSS selector uses unknown pseudo-class ":${name}" in "${selector}"`;
      }
    }
  }

  // Overly deep selector (> 6 combinators is a code smell)
  const depth = (selector.match(/\s*[>+~\s]\s*/g) || []).length;
  if (depth > 6) {
    return `CSS selector is overly specific (${depth} combinators) — consider a stable locator like getByRole or data-testid: "${selector}"`;
  }

  return null;
}

/**
 * Validates an XPath string for common structural errors.
 *
 * @param {string} xpath
 * @returns {string|null}
 */
function checkXPath(xpath) {
  // Balanced brackets
  const openSquare = (xpath.match(/\[/g) || []).length;
  const closeSquare = (xpath.match(/\]/g) || []).length;
  if (openSquare !== closeSquare) {
    return `XPath has unbalanced brackets: "${xpath}"`;
  }
  const openParen = (xpath.match(/\(/g) || []).length;
  const closeParen = (xpath.match(/\)/g) || []).length;
  if (openParen !== closeParen) {
    return `XPath has unbalanced parentheses: "${xpath}"`;
  }

  // Invalid axis shorthand — AI sometimes writes "//div//[@id]" (double slash before @)
  if (/\/\/\[@/.test(xpath)) {
    return `XPath has invalid syntax "//[@" — should be "//*[@" or "//element[@": "${xpath}"`;
  }

  // Overly deep path (> 8 steps is a fragile locator)
  const steps = (xpath.match(/\//g) || []).length;
  if (steps > 8) {
    return `XPath is overly specific (${steps} path steps) — consider a stable locator: "${xpath}"`;
  }

  return null;
}

/**
 * validateLocators(code) → string[]
 *
 * Extracts all CSS and XPath locator strings from the code and validates each.
 * Resolves defect #1.
 *
 * @param {string} code
 * @returns {string[]}
 */
export function validateLocators(code) {
  if (!code) return [];
  const issues = [];

  // CSS selectors
  let m;
  CSS_LOCATOR_RE.lastIndex = 0;
  while ((m = CSS_LOCATOR_RE.exec(code)) !== null) {
    const selector = m[1] || m[2] || m[3];
    if (selector.startsWith("//") || selector.startsWith("(//")) continue; // XPath, handled below
    const err = checkCssSelector(selector);
    if (err) issues.push(err);
  }

  // XPath
  XPATH_LOCATOR_RE.lastIndex = 0;
  while ((m = XPATH_LOCATOR_RE.exec(code)) !== null) {
    const err = checkXPath(m[1] || m[2] || m[3]);
    if (err) issues.push(err);
  }

  return issues;
}

/**
 * Validate a single AI-generated test object.
 * Returns an array of issue strings — empty means the test is valid.
 *
 * @param {object} test        — AI-generated test object
 * @param {string} projectUrl  — the project's base URL (for placeholder detection)
 * @returns {string[]}
 */
export function validateTest(test, projectUrl) {
  const issues = [];

  // Must have a meaningful name
  if (!test.name || test.name.trim().length < 5) {
    issues.push("name is missing or too short");
  }

  // Must have at least one step
  if (!Array.isArray(test.steps) || test.steps.length === 0) {
    issues.push("no test steps defined");
  }

  // Type must be a known industry-standard value (warn, don't reject — the AI
  // occasionally invents types like "user-flow" which are still usable tests)
  if (test.type) {
    const lower = test.type.toLowerCase();
    test.type = VALID_TYPES_SET.has(lower) ? lower : "functional";
  }

  // Scenario must be one of the expected values
  const validScenarios = new Set(["positive", "negative", "edge_case"]);
  if (test.scenario) {
    const lower = test.scenario.toLowerCase();
    test.scenario = validScenarios.has(lower) ? lower : "positive";
  }

  // Playwright code: if present, must be parseable (contain `async` and braces)
  if (test.playwrightCode) {
    if (!test.playwrightCode.includes("async")) {
      issues.push("playwrightCode missing async function");
    }
    if (!test.playwrightCode.includes("{")) {
      issues.push("playwrightCode missing function body");
    }
    // Reject placeholder URLs that the AI sometimes hallucinates
    if (test.playwrightCode.includes("https://example.com") ||
        test.playwrightCode.includes("http://example.com")) {
      issues.push("playwrightCode uses placeholder example.com URL");
    }
    // Must reference navigation — page.goto, click actions (which may navigate),
    // or self-healing helpers. The runtime auto-navigates to sourceUrl when
    // page.goto is absent (executeTest.js:322-324), so .click() on a link
    // is also valid navigation evidence.
    // API tests use request.newContext / api.get/post instead.
    const isApiTest = test._generatedFrom === "api_har_capture" || test._generatedFrom === "api_user_described"
      || test.playwrightCode.includes("request.newContext") || test.playwrightCode.includes("api.get") || test.playwrightCode.includes("api.post");
    const hasNavigation = test.playwrightCode.includes("page.goto")
      || test.playwrightCode.includes("safeClick")
      || test.playwrightCode.includes(".click(")
      || test.playwrightCode.includes("page.waitForURL");
    if (!isApiTest && !hasNavigation) {
      issues.push("playwrightCode missing page.goto navigation");
    }
    // Syntax validation — catch malformed code at generation time rather than
    // at run time. Uses acorn to parse the code as a proper AST, which catches
    // unbalanced braces, unterminated strings, and other syntax errors with
    // precise line:column positions. This is more reliable than new Function()
    // which couldn't handle `await` without an async wrapper.
    //
    // We strip imports first (they're removed at runtime by codeExecutor.js)
    // and wrap the extracted body in an async function so top-level `await`
    // is valid — matching the execution pattern in codeExecutor.js:45-67.
    try {
      const bodyForCheck = extractTestBody(test.playwrightCode);
      const stripped = bodyForCheck
        ? stripPlaywrightImports(bodyForCheck)
        : stripPlaywrightImports(test.playwrightCode);
      // Apply the same repair passes used at runtime (codeExecutor.js:37-41)
      // so that known AI output patterns (e.g. newlines inside quoted strings,
      // networkidle usage) don't cause false-positive rejections.
      const codeToCheck = repairBrokenStringLiterals(patchNetworkIdle(stripped));
      // Wrap in async function so `await` is valid at the top level
      const wrapped = `(async () => {\n${codeToCheck}\n})();`;
      parse(wrapped, { ecmaVersion: 2022, sourceType: "script" });

      // Deep validation — locators, action methods, assertion chains
      // (defects #1, #2, #3 from issue #57)
      // Only run after syntax is confirmed valid so we're not parsing
      // malformed code with regexes and generating misleading errors.
      issues.push(...validateLocators(codeToCheck));
      issues.push(...validateActions(codeToCheck));
      issues.push(...validateAssertions(codeToCheck));
      issues.push(...validateSafeHelperUsage(codeToCheck));
    } catch (syntaxErr) {
      const loc = syntaxErr.loc ? ` (line ${syntaxErr.loc.line}, col ${syntaxErr.loc.column})` : "";
      issues.push(`playwrightCode has syntax error${loc}: ${syntaxErr.message}`);
    }

    // CAP-003: secret-scanner gate. Reject AI-generated tests that embed
    // credentials harvested during crawl (Authorization headers, API keys,
    // JWTs, AWS access keys). Findings are redacted before surfacing — the
    // raw match is never echoed back into the issues list or persisted on
    // the test record. Annotation lives on `test.secretScan` so the
    // orchestrator / reviewer UI can flag the run via `run.secretScanBlocked`.
    const secretFindings = scanForSecrets(test.playwrightCode);
    if (secretFindings.length > 0) {
      const formatted = secretFindings.map((f) => `${f.ruleId} (${f.match})`);
      issues.push(`secret scan failed: ${formatted.join(", ")}`);
      test.secretScan = { blocked: true, findings: secretFindings };
    }
  }

  // Reject tests with duplicate/generic names the AI sometimes produces
  const genericNames = ["test 1", "test 2", "test 3", "untitled", "sample test", "example test"];
  if (test.name && genericNames.includes(test.name.toLowerCase().trim())) {
    issues.push("generic placeholder test name");
  }

  return issues;
}

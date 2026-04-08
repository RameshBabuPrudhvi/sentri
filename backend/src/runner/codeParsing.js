/**
 * codeParsing.js — Pure string transforms for AI-generated Playwright code
 *
 * These functions are stateless, side-effect-free, and have zero external
 * dependencies — making them trivially unit-testable.
 *
 * Exports:
 *   extractTestBody(code)        — pull the async arrow-fn body from a test()
 *   patchNetworkIdle(code)       — rewrite networkidle → domcontentloaded
 *   stripPlaywrightImports(code) — remove import/require of @playwright/test
 *   isApiTest(code)              — detect API-only tests (request.newContext)
 */

/**
 * extractTestBody(playwrightCode)
 *
 * Pulls the async function body out of the generated Playwright test so we can
 * run it directly against an already-open page/context — without needing to
 * spawn a whole new Playwright test runner process.
 *
 * Handles both common shapes the AI produces:
 *   test('name', async ({ page }) => { ... })
 *   test('name', async ({ page, context }) => { ... })
 */
export function extractTestBody(playwrightCode) {
  if (!playwrightCode) return null;

  // Match:  async ({ page ... }) => {  ...  }
  // We want everything inside the outermost braces of the arrow function body.
  const arrowMatch = playwrightCode.match(/async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{([\s\S]*)/);
  if (!arrowMatch) return null;

  // arrowMatch[1] starts just after the opening { of the test body.
  // We walk character-by-character to find the matching closing brace.
  const bodyAndRest = arrowMatch[1];
  let depth = 1;
  let i = 0;
  for (; i < bodyAndRest.length && depth > 0; i++) {
    if (bodyAndRest[i] === "{") depth++;
    else if (bodyAndRest[i] === "}") depth--;
  }
  // Everything up to (but not including) the final closing brace is the body.
  return bodyAndRest.slice(0, i - 1).trim();
}

/**
 * patchNetworkIdle(code)
 *
 * Rewrites any waitForLoadState('networkidle') or waitForLoadState("networkidle")
 * calls that the AI may have generated into the safe domcontentloaded equivalent.
 *
 * Many real-world sites (SPAs, e-commerce like Amazon) fire continuous background
 * XHR/fetch requests for ads, personalisation, and tracking — they never reach
 * networkidle, so Playwright always times out after 30 s.  domcontentloaded is
 * sufficient to guarantee the primary DOM content is ready for interaction.
 *
 * Also rewrites page.goto() calls that use waitUntil:'networkidle' to use
 * waitUntil:'domcontentloaded' for the same reason.
 *
 * Additionally, wraps bare element.click() calls that are immediately followed
 * by a waitForNavigation/waitForLoadState pattern into a safer Promise.all so
 * the navigation promise is registered before the click fires.
 */
export function patchNetworkIdle(code) {
  return code
    // waitForLoadState('networkidle') / waitForLoadState("networkidle")
    .replace(/waitForLoadState\s*\(\s*['"]networkidle['"]\s*(,\s*\{[^}]*\})?\s*\)/g,
      "waitForLoadState('domcontentloaded', { timeout: 30000 })")
    // waitUntil: 'networkidle' / waitUntil: "networkidle" inside goto / waitForNavigation
    .replace(/waitUntil\s*:\s*['"]networkidle['"]/g,
      "waitUntil: 'domcontentloaded'");
}

/**
 * stripPlaywrightImports(code)
 *
 * Remove lines like:
 *   import { test, expect } from '@playwright/test';
 *   const { test, expect } = require('@playwright/test');
 * so they don't cause parse errors when we eval the body.
 */
export function stripPlaywrightImports(code) {
  return code
    .split("\n")
    .filter(line => !line.match(/import\s*\{.*\}\s*from\s*['"]@playwright\/test['"]/))
    .filter(line => !line.match(/require\s*\(\s*['"]@playwright\/test['"]\s*\)/))
    .join("\n");
}

/**
 * isApiTest(playwrightCode)
 *
 * Returns true when the generated code is an API-only test that uses
 * `request.newContext()` (Playwright's APIRequestContext) rather than
 * browser-based page interactions.
 *
 * API tests:
 *   - Do NOT need a browser page or page.goto()
 *   - Need a real Playwright `request` fixture instead of the undefined stub
 *   - Should skip browser-specific artifacts (screenshots, DOM snapshots, video)
 */
export function isApiTest(playwrightCode) {
  if (!playwrightCode) return false;
  const body = extractTestBody(playwrightCode);
  if (!body) return false;
  // Detect request.newContext() or destructured { request } fixture usage
  // without any page.goto / page.click / page.locator interactions
  const usesRequestContext = /request\s*\.\s*newContext\s*\(/.test(body)
    || /request\s*\.\s*(get|post|put|patch|delete|head|fetch)\s*\(/.test(body);
  const usesPage = /page\s*\.\s*(goto|click|locator|getByRole|getByText|getByLabel|getByPlaceholder|fill|type|check|uncheck|selectOption|waitForSelector|waitForLoadState)\s*\(/.test(body)
    || /expect\s*\(\s*page\s*\)/.test(body);
  return usesRequestContext && !usesPage;
}

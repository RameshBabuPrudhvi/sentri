/**
 * @module pipeline/prompts/playwrightCapabilityGuide
 * @description Shared Playwright capability coverage guidance used by
 * generation, regeneration, and debugging prompts.
 */

/**
 * Full-surface Playwright capability checklist used to prevent prompts from
 * overfitting to only click/fill style tests.
 */
export const PLAYWRIGHT_CAPABILITY_GUIDE = [
  "Browser & context lifecycle: browser.newContext(), context.newPage(), storageState reuse",
  "Cross-browser intent: chromium/firefox/webkit compatibility when scenario requires it",
  "Navigation: page.goto(), reload(), goBack(), goForward()",
  "Locators: locator(), getByRole(), getByText(), getByTestId(), frameLocator()",
  "Actions: click, dblclick, fill, type, press, hover, check/uncheck, drag/drop, file upload",
  "Assertions: toBeVisible(), toHaveText(), toHaveValue(), toContainText(), soft assertions when appropriate",
  "Waiting strategy: auto-waiting first, waitForSelector/waitForLoadState as targeted fallbacks",
  "Frames & complex DOM: nested frame handling and Shadow DOM-safe locator strategy",
  "Network controls: page.route() interception, mock/fulfill/abort/continue patterns",
  "API testing: request.newContext(), GET/POST/PUT/PATCH/DELETE with schema assertions",
  "Debugging/observability: screenshots, traces, videos/test attachments",
  "Execution structure: fixtures/hooks, retries/timeouts, describe.parallel, device emulation (viewport/geolocation)",
];

/**
 * Build a compact capability block for prompt inclusion.
 *
 * @returns {string}
 */
export function buildCapabilityCoverageBlock() {
  return `PLAYWRIGHT CAPABILITY COVERAGE (use what the scenario needs, not a limited subset):
${PLAYWRIGHT_CAPABILITY_GUIDE.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}`;
}


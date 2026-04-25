/**
 * @module pipeline/prompts/playwrightCapabilityGuide
 * @description Tier/scenario-aware Playwright capability guidance to keep
 * prompts focused instead of dumping an undifferentiated capability list.
 */

const CLOUD_UI_CAPABILITIES = [
  "Use browser/context lifecycle only when needed (newContext/newPage/storageState).",
  "Prefer resilient locators: getByRole/getByText/getByTestId, locator(), frameLocator() for iframes.",
  "Cover rich interactions where the UI requires them: dblclick/hover/check/uncheck/drag-drop/file upload/press.",
  "Use targeted waiting: auto-wait first, then waitForSelector/waitForLoadState('domcontentloaded') when justified.",
  "Use network/API primitives only for relevant flows: page.route mocks, request.newContext contract checks.",
  "Add debugging observability for fragile flows: screenshots/tracing/video attachments.",
  "For scale scenarios, structure tests with hooks/fixtures/retries/timeouts and parallel-safe describe blocks.",
  "Use device emulation/geolocation only when mobile or regional behaviour is explicitly under test.",
];

const LOCAL_UI_CAPABILITIES = [
  "Match Playwright APIs to scenario complexity (frames/uploads/drag-drop/mocks/API/device).",
  "Prefer semantic locators (getByRole/getByText/getByTestId) and frameLocator for iframe flows.",
  "Use stable waits (auto-wait + domcontentloaded + targeted waitForSelector).",
];

const API_CAPABILITIES = [
  "API tests must use request.newContext + HTTP methods (get/post/put/patch/delete).",
  "Validate status + response schema/content; use route mocking only when API dependency requires isolation.",
  "Do not include browser-only UI interactions unless explicitly generating hybrid API+UI coverage.",
];

const DEBUG_CAPABILITIES = [
  "Preserve advanced primitives already in the test (route mocks, storageState, tracing, frame locators).",
  "Apply the smallest fix possible without downgrading robust Playwright patterns to basic click/fill only.",
];

/**
 * Regexes that indicate the test uses advanced Playwright patterns where
 * assertion enhancement should be conservative to avoid breaking orchestration.
 */
export const ADVANCED_PLAYWRIGHT_PATTERNS = [
  /\bpage\.route\s*\(/,
  /\broute\.(fulfill|continue|abort|fallback)\s*\(/,
  /\brequest\.newContext\s*\(/,
  /\bapi\.(get|post|put|patch|delete|fetch)\s*\(/,
  /\bframeLocator\s*\(/,
  /\bsetInputFiles\s*\(/,
  /\bdragAndDrop\s*\(/,
  /\bdragTo\s*\(/,
  /\bstorageState\s*\(/,
  /\btracing\.(start|stop|startChunk|stopChunk)\s*\(/,
];

/**
 * Build a capability block tuned for prompt purpose and model tier.
 *
 * @param {object} [opts]
 * @param {"ui"|"api"|"debug"} [opts.mode="ui"]
 * @param {"cloud"|"local"} [opts.tier="cloud"]
 * @returns {string}
 */
export function buildCapabilityCoverageBlock({ mode = "ui", tier = "cloud" } = {}) {
  let items = CLOUD_UI_CAPABILITIES;
  if (mode === "api") items = API_CAPABILITIES;
  if (mode === "debug") items = DEBUG_CAPABILITIES;
  if (mode === "ui" && tier === "local") items = LOCAL_UI_CAPABILITIES;
  return `PLAYWRIGHT CAPABILITY RULES (${mode.toUpperCase()}):
${items.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}`;
}

/**
 * Returns true when code includes advanced Playwright primitives that are
 * sensitive to assertion enhancer rewrites.
 *
 * @param {string} playwrightCode
 * @returns {boolean}
 */
export function isAdvancedPlaywrightScenario(playwrightCode) {
  if (!playwrightCode || typeof playwrightCode !== "string") return false;
  return ADVANCED_PLAYWRIGHT_PATTERNS.some((pattern) => pattern.test(playwrightCode));
}

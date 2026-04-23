/**
 * @module pipeline/prompts/promptTiers
 * @description Single source of truth for tiered prompt content (MNT-009).
 *
 * Local models (Ollama / mistral:7b) have effective context windows of ~4K–8K
 * tokens. Cloud models (Anthropic, OpenAI, Google) have 128K+. This module
 * centralises ALL tier-dependent prompt text so other modules import from one
 * place instead of scattering local/cloud variants across files.
 *
 * ### Architecture
 * - `selfHealing.js`  owns self-healing rules (CORE_RULES, SELF_HEALING_PROMPT_RULES)
 *   and exposes `getPromptRules(tier)`.
 * - `promptTiers.js`  (this file) owns everything else that varies by tier:
 *   assertion rules, stability rules, code requirements, and config.
 * - `outputSchema.js` assembles the final system prompt by importing from both.
 *
 * ### Exports
 * - {@link getTier}           — Returns `"cloud"` or `"local"` based on the active provider.
 * - {@link TIER_CONFIG}       — Per-tier configuration (maxElements, fewShot, etc.).
 * - {@link getAssertionRules} — Tier-aware assertion rules.
 * - {@link getStabilityRules} — Tier-aware stability rules.
 * - {@link getCodeRequirements} — Tier-aware code requirement block.
 */

import { isLocalProvider } from "../../aiProvider.js";

/**
 * @typedef {Object} TierConfig
 * @property {string}  name          - Tier name (`"cloud"` or `"local"`).
 * @property {number}  maxElements   - Max DOM elements to include in prompts.
 * @property {boolean} includeFewShot - Whether to include few-shot examples.
 */

/** @type {Object<string, TierConfig>} */
export const TIER_CONFIG = {
  cloud: {
    name: "cloud",
    maxElements: 50,
    includeFewShot: true,
  },
  local: {
    name: "local",
    maxElements: 15,
    includeFewShot: false,
  },
};

/**
 * Determine the prompt tier based on the active AI provider.
 *
 * @returns {"cloud"|"local"} The tier name.
 */
export function getTier() {
  return isLocalProvider() ? "local" : "cloud";
}

// ─── Assertion rules ─────────────────────────────────────────────────────────

const CLOUD_ASSERTION_RULES = `
- Every test MUST have at least 2 strong assertions that verify SPECIFIC VISIBLE CONTENT on the page (exact text, element count, field value) — not just that "a page loaded" or "an element exists".
- STRONG assertions (preferred): toBeVisible() on elements found by specific text/role, toContainText('exact text'), toHaveValue('specific value'), toBeEnabled(), toHaveCount(N). Use toHaveURL() ONLY with a loose hostname-only regex (see STABILITY rule) — never with path or query patterns.
- WEAK (forbidden): toBeTruthy(), toBeDefined(), toEqual(true).
- In "playwrightCode", every expect() assertion must check something a user can SEE — a specific heading, a button label, form field content, a list item count, an error message, or a visible text string. Do NOT write assertions that only check "page loaded" or "element exists" without verifying its text or state.
- DYNAMIC CONTENT: Page data from the crawl is a snapshot — values like usernames, order IDs, dates, counts, prices, and UUIDs WILL differ at runtime. NEVER hard-code dynamic values in assertions. Instead:
  ✓ Dates:    toContainText(/\\d{4}-\\d{2}-\\d{2}/) or toContainText(/\\w+ \\d{1,2}, \\d{4}/)
  ✓ IDs/UUIDs: toHaveAttribute('data-id', /[a-f0-9-]{36}/) or toContainText(/Order #\\d+/)
  ✓ Counts:   expect(page.locator(...)).not.toHaveCount(0)  — NOT toHaveCount(5)
  ✓ Prices:   toContainText(/\\$[\\d,.]+/)
  ✓ Usernames/personalization: assert the LABEL is visible ("Welcome") not the dynamic value ("Welcome John")
  ✓ Toasts/notifications: toContainText(/success|saved|created|updated|deleted/i) — NOT exact text
  ✗ NEVER: toHaveText('Welcome John'), toContainText('Order #12345'), toHaveCount(5) on dynamic lists`.trim();

const LOCAL_ASSERTION_RULES = `
- Every test MUST have at least 2 assertions that verify SPECIFIC VISIBLE CONTENT (text, count, value).
- STRONG: toBeVisible(), toContainText('exact'), toHaveValue('val'), toHaveCount(N).
- Use toHaveURL() ONLY with hostname-only regex — never exact URL.
- NEVER hard-code dynamic values (dates, IDs, counts, prices) — use regex patterns.`.trim();

/**
 * @param {"cloud"|"local"} tier
 * @returns {string}
 */
export function getAssertionRules(tier) {
  return tier === "local" ? LOCAL_ASSERTION_RULES : CLOUD_ASSERTION_RULES;
}

// ─── Stability rules ─────────────────────────────────────────────────────────

const CLOUD_STABILITY_RULES = `
- URL ASSERTIONS: NEVER assert exact URLs or narrow regex patterns on the final URL after navigation. Real-world sites redirect unpredictably (CAPTCHAs, consent pages, geo-redirects, login walls, URL-encoded params). Instead: (a) PREFER asserting visible page CONTENT over toHaveURL(). (b) If you must check the URL, use the LOOSEST possible regex that only checks the hostname — e.g. await expect(page).toHaveURL(/example\\.com/i) — never match on path segments or query params. (c) For search flows, assert that results appeared on the page rather than checking the URL. (d) NEVER use toHaveURL() with a literal string — it will fail on any redirect, query param, or geo-variant of the URL. (e) NEVER add toHaveURL() as a final assertion after a search, filter, or form action — the URL will contain query params that make an exact match impossible.
- After every page.goto() use { waitUntil: 'domcontentloaded' } — NEVER use waitForLoadState('networkidle') as SPAs and e-commerce sites continuously fire background requests and never reach networkidle, causing a guaranteed 30s timeout. After clicking a button or link that causes navigation, use await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), element.click()]). For asserting dynamic content, use await page.waitForSelector('selector', { timeout: 15000 }) before the expect() assertion.
- ASYNC CONTENT & LOADING STATES: SPAs and dynamic pages often show loading spinners, skeleton screens, or "Loading..." text before real content appears. NEVER assert on content that may still be loading. Before asserting on async content: (a) Wait for the real content to appear: await page.waitForSelector('[data-loaded], .content:not(.loading)', { timeout: 15000 }).catch(() => {}); (b) Or wait for a loading indicator to disappear: await page.locator('.spinner, .loading, [aria-busy="true"]').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {}); (c) Use Playwright's built-in auto-waiting by asserting with a timeout: await expect(page.locator('...')).toContainText('expected', { timeout: 10000 });`.trim();

const LOCAL_STABILITY_RULES = `
- Use { waitUntil: 'domcontentloaded' } after page.goto — NEVER networkidle.
- Wait for content before asserting: await expect(locator).toContainText('text', { timeout: 10000 }).`.trim();

/**
 * @param {"cloud"|"local"} tier
 * @returns {string}
 */
export function getStabilityRules(tier) {
  return tier === "local" ? LOCAL_STABILITY_RULES : CLOUD_STABILITY_RULES;
}

// ─── Code requirements ───────────────────────────────────────────────────────

const CLOUD_CODE_REQUIREMENTS = `CODE REQUIREMENTS:
- playwrightCode must be fully self-contained and executable on its own.
- Do NOT use placeholder URLs like 'https://example.com' — use the real URL provided in the user message.
- INLINE ALL TEST DATA: Every value used in the test (search terms, email addresses, passwords, usernames, quantities, IDs) MUST be written as a string literal directly in the code. NEVER declare variables like "const searchTerm = 'iphone'" or reference testData keys by name. BAD: await safeFill(page, 'Search', searchTerm) — ReferenceError at runtime. GOOD: await safeFill(page, 'Search', 'iphone') — literal value always works.
- NEVER declare unused variables. Do NOT assign a locator to a variable (const searchInput = page.locator(...)) unless you immediately use it on the very next line.
- STEP COMMENTS: Add a "// Step N:" comment before the code for each step in the "steps" array. This aligns the code with the step descriptions in the UI. Example: if steps has 3 items, the code should have "// Step 1:", "// Step 2:", "// Step 3:" comments marking where each step's code begins. Every step in the "steps" array MUST have corresponding code — do NOT leave steps without implementation.`;

const LOCAL_CODE_REQUIREMENTS = `CODE REQUIREMENTS:
- playwrightCode must be fully self-contained and executable.
- Use the real URL from the user message — never 'https://example.com'.
- Inline all test data as string literals — never declare variables for values.
- Add "// Step N:" comments before code for each step.`;

/**
 * @param {"cloud"|"local"} tier
 * @returns {string}
 */
export function getCodeRequirements(tier) {
  return tier === "local" ? LOCAL_CODE_REQUIREMENTS : CLOUD_CODE_REQUIREMENTS;
}

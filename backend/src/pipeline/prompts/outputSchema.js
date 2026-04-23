/**
 * outputSchema.js — Single source of truth for the AI-generated test JSON schema
 *
 * Previously the JSON output format, type enum, step-writing rules, and assertion
 * rules were duplicated across intentPrompt.js, journeyPrompt.js, and
 * userRequestedPrompt.js. Changes had to be applied in 3 places, and they
 * frequently drifted.
 *
 * This module exports:
 *   VALID_TEST_TYPES     — enum array for the "type" field
 *   OUTPUT_SCHEMA_BLOCK  — the JSON schema example + type/step/assertion rules
 *   buildSystemPrompt()  — the persona + rules that belong in the "system" role
 *
 * Prompt builders import these and only supply the user-facing context
 * (page data, scenario hints, dials) in the "user" role.
 */

import { getPromptRules } from "../../selfHealing.js";
import { isLocalProvider } from "../../aiProvider.js";
import { buildFewShotBlock } from "./fewShotExamples.js";
import { getTier } from "./promptTiers.js";

// ─── Valid test types ────────────────────────────────────────────────────────

export const VALID_TEST_TYPES = [
  "functional",
  "smoke",
  "regression",
  "e2e",
  "integration",
  "accessibility",
  "security",
  "performance",
];

// ─── Shared assertion & stability rules ──────────────────────────────────────
// Numbered independently so prompt builders can reference them by label
// (e.g. "see STABILITY rule") without worrying about absolute numbering.

export const ASSERTION_RULES = `
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

export const STABILITY_RULES = `
- URL ASSERTIONS: NEVER assert exact URLs or narrow regex patterns on the final URL after navigation. Real-world sites redirect unpredictably (CAPTCHAs, consent pages, geo-redirects, login walls, URL-encoded params). Instead: (a) PREFER asserting visible page CONTENT over toHaveURL(). (b) If you must check the URL, use the LOOSEST possible regex that only checks the hostname — e.g. await expect(page).toHaveURL(/example\\.com/i) — never match on path segments or query params. (c) For search flows, assert that results appeared on the page rather than checking the URL. (d) NEVER use toHaveURL() with a literal string — it will fail on any redirect, query param, or geo-variant of the URL. (e) NEVER add toHaveURL() as a final assertion after a search, filter, or form action — the URL will contain query params that make an exact match impossible.
- After every page.goto() use { waitUntil: 'domcontentloaded' } — NEVER use waitForLoadState('networkidle') as SPAs and e-commerce sites continuously fire background requests and never reach networkidle, causing a guaranteed 30s timeout. After clicking a button or link that causes navigation, use await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), element.click()]). For asserting dynamic content, use await page.waitForSelector('selector', { timeout: 15000 }) before the expect() assertion.
- ASYNC CONTENT & LOADING STATES: SPAs and dynamic pages often show loading spinners, skeleton screens, or "Loading..." text before real content appears. NEVER assert on content that may still be loading. Before asserting on async content: (a) Wait for the real content to appear: await page.waitForSelector('[data-loaded], .content:not(.loading)', { timeout: 15000 }).catch(() => {}); (b) Or wait for a loading indicator to disappear: await page.locator('.spinner, .loading, [aria-busy="true"]').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {}); (c) Use Playwright's built-in auto-waiting by asserting with a timeout: await expect(page.locator('...')).toContainText('expected', { timeout: 10000 });`.trim();

// ─── JSON output schema block ────────────────────────────────────────────────
// Shared by all three prompt builders. The example values guide the LLM on
// field shapes without over-constraining the output.

export function buildOutputSchemaBlock({ isJourney = false, journeyType = "" } = {}) {
  const journeyFields = isJourney
    ? `\n      "journeyType": "${journeyType}",\n      "isJourneyTest": true,`
    : "";

  return `
Return ONLY valid JSON (no markdown, no code fences):
{
  "tests": [
    {
      "name": "descriptive name that includes what scenario (positive/negative) is tested",
      "description": "specific user goal or failure scenario being validated",
      "preconditions": "required setup state — e.g. 'User is logged in as admin, product catalog has ≥1 item' (omit if none)",
      "priority": "high|medium",
      "type": "${VALID_TEST_TYPES.join("|")}",
      "scenario": "positive|negative|edge_case",${journeyFields}
      "testData": { "example_field": "example_value — concrete sample values so the test is immediately runnable" },
      "steps": [
        "User opens the page and sees the main heading 'Example Title' and a navigation bar",
        "User clicks the 'Sign Up' button in the top-right corner",
        "A registration form appears with Name, Email, and Password fields",
        "User fills in Name with 'Jane Doe', Email with 'jane@test.com', Password with 'Secure123!'",
        "User clicks 'Create Account' and a success message 'Account created successfully' appears"
      ],
      "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => {\\n  // complete test code\\n});"
    }
  ]
}

FIELD RULES:
- "type" must be one of: ${VALID_TEST_TYPES.map(t => `"${t}"`).join(", ")}. Pick the best match. If unsure, use "functional".
- "preconditions" — state any required setup (user role, data state, browser context). Omit or set to "" if the test starts from a clean state.
- "testData" — provide concrete sample values (emails, IDs, search terms, amounts) for documentation only. CRITICAL: ALL values in testData MUST be inlined as string or number literals directly inside playwrightCode — NEVER declare a variable (const searchTerm = ...) and NEVER reference a testData key by name inside the code. BAD: safeFill(page, 'Search', searchTerm) — searchTerm is not defined at runtime. GOOD: safeFill(page, 'Search', 'iphone') — literal value inline. Omit testData or set to {} if no test data is needed.
- "steps" — SHORT HUMAN-READABLE descriptions of what the user does and sees (plain English), NOT Playwright code or technical assertions. Playwright code goes ONLY in "playwrightCode".
  Write each step so a manual tester can follow it without looking at code. Name the SPECIFIC element or text the user interacts with and what they should SEE as a result.
  BAD steps (too vague):  ["The page loads successfully", "The URL reflects the section", "Verify the expected content is displayed"]
  GOOD steps (specific):  ["User sees the heading 'Create Account' and a form with Name, Email, and Password fields", "User fills in Name with 'Jane' and Email with 'jane@test.com' and clicks 'Sign Up'", "A confirmation message 'Account created' appears below the form"]
  When the output format is Gherkin / BDD, write steps as: "Given the user is on the registration page", "When the user fills in the form and clicks 'Sign Up'", "Then a confirmation message 'Account created' is displayed".

${isLocalProvider() ? "" : buildFewShotBlock()}`.trim();
}

// ─── System prompt ───────────────────────────────────────────────────────────
// Contains the persona, self-healing rules, assertion rules, and stability
// rules. These are constant across all prompt types and belong in the
// "system" message role so the LLM treats them with highest priority.

// ─── Prompt version ──────────────────────────────────────────────────────────
// Bump this when the system prompt, schema, or rules change materially.
// Stored on every generated test so teams can track which prompt version
// produced which tests, A/B test prompt changes, and roll back if quality
// regresses.

export const PROMPT_VERSION = "2.2.0";

export function buildSystemPrompt() {
  const tier = getTier();
  const rules = getPromptRules(tier);
  return `You are a senior QA automation engineer generating production-grade Playwright test suites.

PERSONA RULES:
- Every test must simulate a REAL USER ACTION (click, navigate, fill, scroll) and verify the OUTCOME — do NOT generate tests that only check whether elements exist on the page.
- Tests must be independent — no shared state between tests.
- Skip tests for: footer, social icons, cookie banners — but DO test primary navigation links and CTAs that lead to real user flows.
- For NEGATIVE tests: assert the actual error message or validation indicator is visible.
- Only test elements/behaviors that ACTUALLY exist for the page type.

SELF-HEALING:
${rules}

ASSERTION QUALITY:
${ASSERTION_RULES}

STABILITY:
${STABILITY_RULES}

CODE REQUIREMENTS:
- playwrightCode must be fully self-contained and executable on its own.
- Do NOT use placeholder URLs like 'https://example.com' — use the real URL provided in the user message.
- INLINE ALL TEST DATA: Every value used in the test (search terms, email addresses, passwords, usernames, quantities, IDs) MUST be written as a string literal directly in the code. NEVER declare variables like "const searchTerm = 'iphone'" or reference testData keys by name. BAD: await safeFill(page, 'Search', searchTerm) — ReferenceError at runtime. GOOD: await safeFill(page, 'Search', 'iphone') — literal value always works.
- NEVER declare unused variables. Do NOT assign a locator to a variable (const searchInput = page.locator(...)) unless you immediately use it on the very next line.
- STEP COMMENTS: Add a "// Step N:" comment before the code for each step in the "steps" array. This aligns the code with the step descriptions in the UI. Example: if steps has 3 items, the code should have "// Step 1:", "// Step 2:", "// Step 3:" comments marking where each step's code begins. Every step in the "steps" array MUST have corresponding code — do NOT leave steps without implementation.`;
}
/**
 * intentPrompt.js — Single-page intent-based prompt template
 *
 * Builds the AI prompt for generating Playwright tests based on the
 * classified intent of a single page (AUTH, SEARCH, CHECKOUT, etc.)
 * and its interactive elements.
 */

import { isLocalProvider } from "../../aiProvider.js";
import { SELF_HEALING_PROMPT_RULES } from "../../selfHealing.js";
import { resolveTestCountInstruction } from "../promptHelpers.js";

// ── Scenario hints per page type ─────────────────────────────────────────────

function buildScenarioHints(testCountInstr) {
  return {
    AUTH: `${testCountInstr} covering:
- POSITIVE: Successful login with valid credentials redirects to dashboard
- POSITIVE: Registration form accepts valid new user data
- NEGATIVE: Wrong password shows clear error message
- NEGATIVE: Empty required fields show validation errors
- NEGATIVE: Invalid email format blocked before submit
- EDGE: Password visibility toggle works
- EDGE: Forgot password link is accessible`,

    SEARCH: `${testCountInstr} covering:
- POSITIVE: Search returns relevant results for valid query
- POSITIVE: Search filters narrow down results correctly
- POSITIVE: Clicking a result navigates to detail page
- NEGATIVE: Empty search query handled gracefully
- NEGATIVE: No results for unknown term shows empty state
- EDGE: Special characters in search don't break the page
- EDGE: Very long search query is handled`,

    CHECKOUT: `${testCountInstr} covering:
- POSITIVE: Add item to cart and view cart with correct total
- POSITIVE: Quantity update recalculates cart total
- POSITIVE: Proceed to checkout from cart page
- NEGATIVE: Invalid payment details show error
- NEGATIVE: Empty required checkout fields blocked
- EDGE: Remove item from cart updates totals
- EDGE: Cart persists on page refresh`,

    FORM_SUBMISSION: `${testCountInstr} covering:
- POSITIVE: Form submits with all valid required fields
- POSITIVE: Success confirmation is shown after submit
- NEGATIVE: Submit with empty required fields shows validation
- NEGATIVE: Invalid email format shows error before submit
- NEGATIVE: Duplicate submission is prevented
- EDGE: Form scrolls to first error field on failed submit
- EDGE: Character limits enforced on text inputs`,

    NAVIGATION: `${testCountInstr} covering:
- POSITIVE: User clicks a navigation link and is taken to the correct destination page with expected content
- POSITIVE: User navigates to this page, verifies key content loads, then navigates to another section and back
- POSITIVE: Primary navigation links lead to the correct URLs and load the expected page titles
- POSITIVE: Key call-to-action buttons trigger the intended user flow (e.g. sign up, get started, learn more)
- POSITIVE: User completes a multi-step navigation: homepage → section page → detail page → back to homepage
- NEGATIVE: Broken or dead links are detected (clicking a link does not lead to a 404 or error page)
- NEGATIVE: Navigation state is preserved correctly after browser back/forward
- EDGE: Deep-linking directly to this page loads it correctly with all content visible
- EDGE: Page renders correctly and key interactive elements are functional after a full reload`,

    CRUD: `${testCountInstr} covering:
- POSITIVE: Create new item with valid data succeeds
- POSITIVE: Created item appears in list immediately
- POSITIVE: Edit existing item and save persists changes
- NEGATIVE: Create with duplicate name shows error
- NEGATIVE: Required fields block save when empty
- EDGE: Delete shows confirmation dialog
- EDGE: Cancel edit discards unsaved changes`,

    CONTENT: `${testCountInstr} covering:
- POSITIVE: User opens the page and main content/article is fully visible and readable
- POSITIVE: User clicks internal links within the content and is navigated to the correct destination
- POSITIVE: User scrolls through the page and all sections, images, and media load progressively
- POSITIVE: User clicks a related content link or "read more" and the target page loads with expected content
- NEGATIVE: Broken images or missing media are detected (no placeholder or 404 resources)
- NEGATIVE: External links open correctly without breaking the current page state
- EDGE: User navigates to the page via direct URL and all content renders without requiring prior navigation
- EDGE: Page content is accessible — headings are hierarchical and interactive elements are reachable`,
  };
}

// ── Main prompt builder ──────────────────────────────────────────────────────

export function buildIntentPrompt(classifiedPage, snapshot, { testCount = "ai_decides" } = {}) {
  const local = isLocalProvider();
  // For local models (Ollama) keep element data compact to avoid context overflow (HTTP 500).
  // Cloud models get the full element data for richer test generation.
  const elements = classifiedPage.classifiedElements
    .filter(({ confidence }) => confidence > 20)
    .slice(0, local ? 12 : 20)
    .map(({ element, intent, confidence }) => {
      if (local) {
        return {
          tag: element.tag, text: (element.text || "").slice(0, 40),
          type: element.type, role: element.role,
          name: element.name, id: element.id,
          label: element.label, placeholder: element.placeholder,
          testId: element.testId, intent, confidence,
        };
      }
      return { ...element, intent, confidence };
    });

  const pageType = classifiedPage.dominantIntent;

  const testCountInstr = resolveTestCountInstruction(testCount, local);
  const scenarioHints = buildScenarioHints(testCountInstr);
  const hints = scenarioHints[pageType] || scenarioHints.NAVIGATION;

  return `You are a senior QA engineer. Generate comprehensive Playwright tests based on REAL user behavior patterns.
Every test must simulate a REAL USER ACTION (click, navigate, fill, scroll) and verify the OUTCOME — do NOT generate tests that only check whether elements exist on the page.

PAGE: ${snapshot.url}
TITLE: ${snapshot.title}
DOMINANT INTENT: ${pageType}
FORMS ON PAGE: ${snapshot.forms}
H1 TEXT: ${snapshot.h1 || "none"}
DESCRIPTION: ${snapshot.metaDescription || "none"}
HEADINGS: ${JSON.stringify(snapshot.headings || [], null, 2)}

CLASSIFIED INTERACTIVE ELEMENTS:
${JSON.stringify(elements, null, 2)}

REQUIRED SCENARIO COVERAGE:
${hints}

STRICT RULES:
1. ${testCountInstr} — must include BOTH positive AND negative scenarios
2. Each test validates a REAL user goal or validates graceful failure handling
3. ${SELF_HEALING_PROMPT_RULES}
4. Every test MUST have at least 2 strong assertions that verify SPECIFIC VISIBLE CONTENT on the page (exact text, element count, field value) — not just that "a page loaded" or "an element exists"
5. STRONG assertions (preferred): toBeVisible() on elements found by specific text/role, toContainText('exact text'), toHaveValue('specific value'), toBeEnabled(), toHaveCount(N). Use toHaveURL() ONLY with a loose hostname-only regex (see rule 13) — never with path or query patterns.
6. WEAK (forbidden): toBeTruthy(), toBeDefined(), toEqual(true)
7. Skip tests for: footer, social icons, cookie banners — but DO test primary navigation links and CTAs that lead to real user flows
8. Tests must be independent — no shared state between tests
9. For NEGATIVE tests: assert the actual error message or validation indicator is visible
10. Only test elements/behaviors that ACTUALLY exist for this type of page
11. CRITICAL: Every playwrightCode MUST start with: await page.goto('${snapshot.url}', { waitUntil: 'domcontentloaded', timeout: 30000 }); — use the EXACT URL above, never a placeholder
12. CRITICAL: playwrightCode must be fully self-contained and executable on its own
13. STABILITY — URL ASSERTIONS: NEVER assert exact URLs or narrow regex patterns on the final URL after navigation. Real-world sites redirect unpredictably (CAPTCHAs like /sorry, consent pages, geo-redirects, login walls, URL-encoded params like %3F instead of ?). Instead: (a) PREFER asserting visible page CONTENT — e.g. await expect(page.getByText('Search results')).toBeVisible() — over toHaveURL(). (b) If you must check the URL, use the LOOSEST possible regex that only checks the hostname — e.g. await expect(page).toHaveURL(/google\\.com/i) — never match on path segments or query params that may be rewritten. (c) For search flows, assert that results appeared on the page (visible text, result count, a result link) rather than checking the URL contains the query string.
14. STABILITY: After every page.goto() use { waitUntil: 'domcontentloaded' } — NEVER use waitForLoadState('networkidle') as SPAs and e-commerce sites (Amazon, etc.) continuously fire background requests and never reach networkidle, causing a guaranteed 30 s timeout. After clicking a button or link that causes navigation, use await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), element.click()]). For asserting dynamic content that loads after interaction (search results, filtered lists, modal contents), use await page.waitForSelector('selector', { timeout: 15000 }) before the expect() assertion.

Return ONLY valid JSON (no markdown, no code fences):
{
  "tests": [
    {
      "name": "descriptive name that includes what scenario (positive/negative) is tested",
      "description": "specific user goal or failure scenario being validated",
      "priority": "high|medium",
      "type": "functional|smoke|regression|e2e|integration|accessibility|security|performance",
      "scenario": "positive|negative|edge_case",
      "steps": ["User opens the page and sees the main heading and navigation", "User clicks the primary call-to-action button", "The next view loads and the expected heading or confirmation text is visible", "User verifies key content is present — e.g. a list of items, a form, or a success message"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => {\\n  // complete test code\\n});"
    }
  ]
}

IMPORTANT: "type" must be one of these industry-standard test types — pick the best match:
  - "functional"     — verifies a specific feature works as expected
  - "smoke"          — quick sanity check of critical paths
  - "regression"     — confirms existing functionality after a change
  - "e2e"            — end-to-end flow spanning multiple pages/steps
  - "integration"    — verifies interactions between components or APIs
  - "accessibility"  — WCAG compliance, keyboard nav, screen readers
  - "security"       — auth, permissions, input sanitisation
  - "performance"    — load times, responsiveness, resource usage
If unsure, use "functional".

IMPORTANT: The "steps" array must contain SHORT HUMAN-READABLE descriptions of what the user does and sees (plain English), NOT Playwright code or technical assertions. Playwright code goes ONLY in "playwrightCode".
Write each step so a manual tester can follow it without looking at code. Name the SPECIFIC element or text the user interacts with and what they should SEE as a result — never write vague steps like "page loads successfully" or "URL reflects the section".
BAD steps (too vague):  ["The page loads successfully", "The URL reflects the section", "Verify the expected content is displayed", "The form works correctly"]
GOOD steps (specific & user-friendly): ["User sees the heading 'Create Account' and a form with Name, Email, and Password fields", "User fills in Name with 'Jane' and Email with 'jane@test.com' and clicks 'Sign Up'", "A confirmation message 'Account created' appears below the form", "The form fields are cleared and a 'Go to Dashboard' link is visible"]
When the output format is Gherkin / BDD, write steps as: "Given the user is on the registration page", "When the user fills in the form and clicks 'Sign Up'", "Then a confirmation message 'Account created' is displayed".

IMPORTANT: In "playwrightCode", every expect() assertion must check something a user can SEE — a specific heading, a button label, form field content, a list item count, an error message, or a visible text string. Do NOT write assertions that only check "page loaded" or "element exists" without verifying its text or state. Read the actual PAGE DATA above (title, headings, elements) and assert against REAL content from that page.`;
}

/**
 * journeyPrompt.js — Multi-page journey prompt template
 *
 * Builds the AI prompt for generating end-to-end Playwright tests that span
 * multiple pages (e.g. Login → Dashboard → Action → Logout).
 */

import { isLocalProvider } from "../../aiProvider.js";
import { SELF_HEALING_PROMPT_RULES } from "../../selfHealing.js";
import { resolveTestCountInstruction } from "../promptHelpers.js";

export function buildJourneyPrompt(journey, allSnapshots, { testCount = "ai_decides" } = {}) {
  const local = isLocalProvider();
  const pageContexts = journey.pages.map(page => {
    const snapshot = allSnapshots[page.url];
    // For local models (Ollama) keep element data compact to avoid context overflow (HTTP 500)
    const rawElems = (snapshot?.elements || []).slice(0, local ? 8 : 10);
    const elems = local
      ? rawElems.map(e => ({
          tag: e.tag, text: (e.text || "").slice(0, 40), type: e.type,
          role: e.role, name: e.name, testId: e.testId,
        }))
      : rawElems;
    return `
  Page: ${page.url}
  Title: ${page.title}
  Intent: ${page.dominantIntent}
  Key elements: ${JSON.stringify(elems, null, 2)}`;
  }).join("\n---");

  return `You are a senior QA engineer generating comprehensive Playwright tests for a real user journey.

JOURNEY: ${journey.name}
TYPE: ${journey.type}
DESCRIPTION: ${journey.description}

PAGES IN THIS JOURNEY:
${pageContexts}

${resolveTestCountInstruction(testCount, local)} end-to-end Playwright tests covering this journey from multiple angles.

Requirements:
1. Cover BOTH positive paths (happy paths) AND negative paths (error states, edge cases)
2. Each test must flow through multiple pages/steps logically
3. ${SELF_HEALING_PROMPT_RULES}
4. Include at least 3 meaningful assertions per test that verify SPECIFIC VISIBLE CONTENT (exact heading text, button labels, field values, item counts) — not just that "a page loaded". Preferred: toBeVisible() on elements found by specific text/role, toContainText('exact text'), toHaveValue('specific value'), toHaveCount(N). Use toHaveURL() ONLY with a loose hostname-only regex (see rule 10) — never with path or query patterns.
5. After every page.goto() call use { waitUntil: 'domcontentloaded' } — do NOT use waitForLoadState('networkidle') as many real-world sites (e.g. SPAs, e-commerce) fire continuous background requests and never reach networkidle, causing a 30 s timeout.
6. Tests must represent REAL user goals and behaviors
7. Negative tests should verify error messages and validation feedback
8. CRITICAL: Each test's playwrightCode MUST be fully self-contained — it MUST start with await page.goto('FULL_URL', { waitUntil: 'domcontentloaded', timeout: 30000 }) as the very first line inside the test function. Use the actual URL from the PAGE data above.
9. CRITICAL: Do NOT use placeholder URLs like 'https://example.com' — use the real page URL provided.
10. STABILITY — URL ASSERTIONS: NEVER assert exact URLs or narrow regex patterns on the final URL after navigation. Real-world sites redirect unpredictably (CAPTCHAs like /sorry, consent pages, geo-redirects, login walls, URL-encoded params like %3F instead of ?). Instead: (a) PREFER asserting visible page CONTENT — e.g. await expect(page.getByText('Dashboard')).toBeVisible() — over toHaveURL(). (b) If you must check the URL, use the LOOSEST possible regex that only checks the hostname — e.g. await expect(page).toHaveURL(/example\\.com/i) — never match on path segments or query params that may be rewritten. (c) For search or filter flows, assert that results appeared on the page rather than checking the URL.
11. STABILITY: After clicking a button or link that triggers navigation, wrap the click in Promise.all with page.waitForNavigation({ waitUntil: 'domcontentloaded' }) — e.g. await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), element.click()]). Never use waitForLoadState('networkidle') after a click — it times out on sites with background polling. For asserting dynamic content (search results, filters), use await page.waitForSelector('selector', { timeout: 15000 }) instead.

Return ONLY valid JSON (no markdown):
{
  "tests": [
    {
      "name": "descriptive journey test name",
      "description": "what user goal this validates",
      "priority": "high",
      "type": "e2e|functional|smoke|regression|integration|accessibility|security|performance",
      "scenario": "positive|negative|edge_case",
      "journeyType": "${journey.type}",
      "isJourneyTest": true,
      "steps": ["User opens the first page and sees the expected heading and key interactive elements", "User performs the main action (fill form, click button, select option) to move to the next step", "The next page loads and the user sees a confirmation or the expected content for that step", "User continues through the journey and verifies the final outcome — a success message, completed state, or summary view"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => {\\n  // full journey code here\\n});"
    }
  ]
}

IMPORTANT: "type" must be one of these industry-standard test types — pick the best match:
  - "e2e"            — end-to-end flow spanning multiple pages/steps (default for journeys)
  - "functional"     — verifies a specific feature works as expected
  - "smoke"          — quick sanity check of critical paths
  - "regression"     — confirms existing functionality after a change
  - "integration"    — verifies interactions between components or APIs
  - "accessibility"  — WCAG compliance, keyboard nav, screen readers
  - "security"       — auth, permissions, input sanitisation
  - "performance"    — load times, responsiveness, resource usage

IMPORTANT: The "steps" array must contain SHORT HUMAN-READABLE descriptions of what the user does and sees (plain English), NOT Playwright code or technical assertions. Playwright code goes ONLY in "playwrightCode".
Write each step so a manual tester can follow it without looking at code. Name the SPECIFIC element or text the user interacts with and what they should SEE as a result — never write vague steps like "page loads successfully" or "user is redirected".
BAD steps (too vague):  ["The page loads successfully", "User is redirected to the dashboard", "The URL reflects the checkout page", "The flow works correctly"]
GOOD steps (specific & user-friendly): ["User sees the heading 'Create Account' and a form with Name, Email, and Password fields", "User fills in Name with 'Jane' and Email with 'jane@test.com' and clicks 'Sign Up'", "A confirmation message 'Account created' appears below the form", "User clicks 'Go to Dashboard' and the dashboard shows 'Welcome, Jane' in the header"]
When the output format is Gherkin / BDD, write steps as: "Given the user is on the registration page", "When the user fills in the form and clicks 'Sign Up'", "Then a confirmation message 'Account created' is displayed".

IMPORTANT: In "playwrightCode", every expect() assertion must check something a user can SEE — a specific heading, a button label, form field content, a list item count, an error message, or a visible text string. Do NOT write assertions that only check "page loaded" or "element exists" without verifying its text or state. Read the actual PAGE DATA above (titles, intents, elements) and assert against REAL content from those pages.`;
}

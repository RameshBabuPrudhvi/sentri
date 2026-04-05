/**
 * userRequestedPrompt.js — User-requested single test prompt template
 *
 * Used by generateSingleTest (POST /api/projects/:id/tests/generate) when a
 * user provides a specific name + description. Unlike buildIntentPrompt which
 * generates 5-8 generic tests from crawled page data, this prompt generates
 * exactly ONE focused test that matches the user's stated intent.
 */

import { isLocalProvider } from "../../aiProvider.js";
import { SELF_HEALING_PROMPT_RULES } from "../../selfHealing.js";
import { resolveTestCountInstruction } from "../promptHelpers.js";

export function buildUserRequestedPrompt(name, description, appUrl, { testCount = "ai_decides" } = {}) {
  const local = isLocalProvider();
  const countInstruction = resolveTestCountInstruction(testCount, local);

  return `You are a senior QA engineer. A user has asked you to create a specific Playwright test.

TEST NAME: ${name}
USER DESCRIPTION: ${description || "(no description provided)"}
APPLICATION URL: ${appUrl}

Your job is to generate test(s) that precisely match the user's request above.
Do NOT generate generic tests. Do NOT generate tests unrelated to the title and description.
The test(s) MUST directly verify what the user described — nothing more, nothing less.

STRICT RULES:
1. ${countInstruction} — focused entirely on what the user described
2. The test name should match or closely reflect the user's provided name
3. Steps must be specific to the described scenario, not generic page checks
4. ${SELF_HEALING_PROMPT_RULES}
5. Every test MUST have at least 2 strong assertions that verify SPECIFIC VISIBLE CONTENT on the page (exact text, element count, field value) — not just that "a page loaded" or "an element exists"
6. STRONG assertions (preferred): toBeVisible() on elements found by specific text/role, toContainText('exact text'), toHaveValue('specific value'), toBeEnabled(), toHaveCount(N). Use toHaveURL() ONLY with a loose hostname-only regex (see rule 11) — never with path or query patterns.
7. WEAK (forbidden): toBeTruthy(), toBeDefined(), toEqual(true)
8. CRITICAL: playwrightCode MUST start with: await page.goto('${appUrl}', { waitUntil: 'domcontentloaded', timeout: 30000 });
9. CRITICAL: playwrightCode must be fully self-contained and executable on its own
10. CRITICAL: Do NOT use placeholder URLs like 'https://example.com' — use '${appUrl}'
11. STABILITY — URL ASSERTIONS: NEVER assert exact URLs or narrow regex patterns on the final URL after navigation. Real-world sites redirect unpredictably (CAPTCHAs like /sorry, consent pages, geo-redirects, login walls, URL-encoded params like %3F instead of ?). Instead: (a) PREFER asserting visible page CONTENT — e.g. await expect(page.getByText('Welcome')).toBeVisible() — over toHaveURL(). (b) If you must check the URL, use the LOOSEST possible regex that only checks the hostname — e.g. await expect(page).toHaveURL(/example\\.com/i) — never match on path segments or query params that may be rewritten. (c) For search flows, assert that results appeared on the page rather than checking the URL contains the query string.
12. STABILITY: After every page.goto() use { waitUntil: 'domcontentloaded' } — NEVER use waitForLoadState('networkidle'). After clicking something that navigates, use await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }), element.click()]). For dynamic content assertions use await page.waitForSelector('selector', { timeout: 15000 }) before expect().

Return ONLY valid JSON (no markdown, no code fences):
{
  "tests": [
    {
      "name": "${name}",
      "description": "${(description || "").replace(/"/g, '\\"').slice(0, 200)}",
      "priority": "high",
      "type": "functional|smoke|regression|e2e|integration|accessibility|security|performance",
      "scenario": "positive|negative|edge_case",
      "steps": ["User opens the application and sees the main page with its heading and navigation", "User performs the action described above (click, fill, submit, navigate)", "The expected outcome is visible — a confirmation message, updated content, or new page heading appears", "User verifies the final state matches what was requested — correct text, values, or element states are shown"],
      "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('${name.replace(/'/g, "\\'")}', async ({ page }) => {\\n  // complete test code\\n});"
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
Write each step so a manual tester can follow it without looking at code. Name the SPECIFIC element or text the user interacts with and what they should SEE as a result — never write vague steps like "page loads successfully" or "the expected outcome is visible".
BAD steps (too vague):  ["The page loads successfully", "The expected outcome is visible on the page", "The URL reflects the section", "The feature works correctly"]
GOOD steps (specific & user-friendly): ["User sees the heading 'Create Account' and a form with Name, Email, and Password fields", "User fills in Name with 'Jane' and Email with 'jane@test.com' and clicks 'Sign Up'", "A confirmation message 'Account created' appears below the form", "The form fields are cleared and a 'Go to Dashboard' link is visible"]
When the output format is Gherkin / BDD, write steps as: "Given the user is on the registration page", "When the user fills in the form and clicks 'Sign Up'", "Then a confirmation message 'Account created' is displayed".

IMPORTANT: In "playwrightCode", every expect() assertion must check something a user can SEE — a specific heading, a button label, form field content, a list item count, an error message, or a visible text string. Do NOT write assertions that only check "page loaded" or "element exists" without verifying its text or state. Base your assertions on the APPLICATION URL and USER DESCRIPTION provided above — use real content the user would expect to see.`;
}

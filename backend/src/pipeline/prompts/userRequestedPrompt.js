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
5. Every test MUST have at least 2 strong assertions
6. STRONG assertions: toHaveURL(), toBeVisible(), toContainText(), toHaveValue(), toBeEnabled()
7. WEAK (forbidden): toBeTruthy(), toBeDefined(), toEqual(true)
8. CRITICAL: playwrightCode MUST start with: await page.goto('${appUrl}', { waitUntil: 'domcontentloaded', timeout: 30000 });
9. CRITICAL: playwrightCode must be fully self-contained and executable on its own
10. CRITICAL: Do NOT use placeholder URLs like 'https://example.com' — use '${appUrl}'
11. STABILITY: For URL assertions use regex patterns — e.g. await expect(page).toHaveURL(/\\/about/i) instead of exact URL strings, because query params, trailing slashes, and redirects cause false failures
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
      "steps": ["User navigates to the application", "User performs the described action", "The expected outcome is visible on the page"],
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
BAD steps:  ["await page.goto('...')", "Assert: success message visible", "assert form is submitted"]
GOOD steps: ["User opens the homepage", "User clicks the Sign In button", "A success confirmation message appears", "The user's profile name is shown in the header"]
When the output format is Gherkin / BDD, write steps as: "Given the user is on the login page", "When the user clicks Sign In", "Then a welcome message is displayed".`;
}

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
import { getTier, getAssertionRules, getStabilityRules, getCodeRequirements } from "./promptTiers.js";

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
- "testData" — provide concrete sample values (emails, IDs, search terms, amounts) for documentation only. CRITICAL: ALL values in testData MUST be inlined as string or number literals directly inside playwrightCode — NEVER declare a variable (const query = ...) and NEVER reference a testData key by name inside the code. BAD: safeFill(page, 'Username', emailVar) — emailVar is not defined at runtime. GOOD: safeFill(page, 'Username', 'testuser@example.com') — literal value inline. Use the ACTUAL field labels from PAGE DATA. Omit testData or set to {} if no test data is needed.
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

export const PROMPT_VERSION = "2.3.0";

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
${getAssertionRules(tier)}

STABILITY:
${getStabilityRules(tier)}

${getCodeRequirements(tier)}`;
}
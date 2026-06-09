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
import { buildCapabilityCoverageBlock } from "./playwrightCapabilityGuide.js";

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
      "playwrightCode": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => {\\n  // complete test code\\n});",
      "setupCode": "",
      "teardownCode": ""
    }
  ]
}

FIELD RULES:
- "type" must be one of: ${VALID_TEST_TYPES.map(t => `"${t}"`).join(", ")}. Pick the best match. If unsure, use "functional".
- "preconditions" — state any required setup (user role, data state, browser context). Omit or set to "" if the test starts from a clean state.
- "testData" — provide concrete sample values (emails, IDs, search terms, amounts) for documentation only. CRITICAL: ALL values in testData MUST be inlined as string or number literals directly inside playwrightCode — NEVER declare a variable (const query = ...) and NEVER reference a testData key by name inside the code. BAD: safeFill(page, 'Username', emailVar) — emailVar is not defined at runtime. GOOD: safeFill(page, 'Username', 'testuser@example.com') — literal value inline. Use the ACTUAL field labels from PAGE DATA. Omit testData or set to {} if no test data is needed.
- "setupCode" (optional, AUDIT-ROADMAP B6 / QAL-002) — JS code executed BEFORE the test body. Use ONLY when the test needs PRECONDITION STATE that isn't already encoded in the test steps (e.g. seeding a row, signing in a secondary user, clearing localStorage). The runner exposes the same \`page\` / \`safeClick\` / \`safeFill\` / \`safeExpect\` globals as the main test body. Leave as "" when no setup is needed.
- "teardownCode" (optional, AUDIT-ROADMAP B6 / QAL-002) — JS code executed in the test's \`finally\` block to RESET STATE the test created. CRITICAL: if the test CREATES any resource (user account, order, file upload, ...), include a teardown step that DELETES or RESETS it via the same UI flow. Errors in teardown are swallowed + logged — never let cleanup mask a real test failure. Leave as "" when the test creates no persistent resource.
- "playwrightCode" + "setupCode" + "teardownCode" — when the SUT requires UNIQUE TEST DATA (signup forms, email-based registration, anything with a UNIQUE constraint), use one of these placeholder tokens INSTEAD of hardcoded values; the runner substitutes them with deterministic seeded faker values: \`__FAKE_EMAIL__\`, \`__FAKE_NAME__\`, \`__FAKE_FIRST_NAME__\`, \`__FAKE_LAST_NAME__\`, \`__FAKE_PHONE__\`, \`__FAKE_USERNAME__\`, \`__FAKE_PASSWORD__\`, \`__FAKE_COMPANY__\`, \`__FAKE_STREET__\`, \`__FAKE_CITY__\`, \`__FAKE_ZIP__\`, \`__FAKE_UUID__\`, \`__FAKE_NUMBER__\`, \`__FAKE_WORD__\`, \`__TIMESTAMP__\`. Multiple occurrences of the SAME token in one test resolve to the SAME value (so "fill email with __FAKE_EMAIL__" and "expect text __FAKE_EMAIL__" stay coherent). Different tokens get different values.
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

// AUDIT-ROADMAP B6 bumped 2.4.0 → 2.5.0 because the schema gained two
// optional fields (setupCode, teardownCode) and a new placeholder-token
// convention. The version stamp on `tests.promptVersion` lets operators
// A/B-test pre-B6 vs post-B6 generation quality on a single project.
export const PROMPT_VERSION = "2.5.0";

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

${buildCapabilityCoverageBlock({ mode: "ui", tier })}

${getCodeRequirements(tier)}`;
}

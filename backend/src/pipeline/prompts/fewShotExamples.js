/**
 * fewShotExamples.js — Gold-standard test examples for few-shot prompting
 *
 * LLMs produce dramatically more consistent output when shown 1-2 complete
 * input→output examples. These examples are appended to the user message
 * by buildOutputSchemaBlock() when the prompt is for a cloud provider
 * (local models skip them to save context window).
 *
 * Each example is a minimal but complete test object that demonstrates:
 *   - Specific, non-vague step descriptions
 *   - Strong assertions (toBeVisible on real text, toContainText)
 *   - Self-healing helpers (safeClick, safeFill, safeExpect)
 *   - preconditions and testData fields
 *   - Correct type/scenario/priority usage
 */

// ── Positive functional test — login flow ────────────────────────────────────

export const LOGIN_POSITIVE_EXAMPLE = {
  name: "Successful login with valid credentials shows dashboard",
  description: "Verifies that a registered user can log in and see the dashboard greeting",
  preconditions: "User 'jane@test.com' exists with password 'Secure123!'",
  priority: "high",
  type: "functional",
  scenario: "positive",
  testData: {
    email: "jane@test.com",
    password: "Secure123!",
  },
  steps: [
    "User opens the login page and sees the heading 'Sign In' with Email and Password fields",
    "User enters 'jane@test.com' in the Email field and 'Secure123!' in the Password field",
    "User clicks the 'Sign In' button",
    "The dashboard loads and shows 'Welcome back, Jane' in the header",
    "The navigation bar shows a 'My Account' link confirming the user is logged in",
  ],
  playwrightCode: `import { test, expect } from '@playwright/test';

test('Successful login with valid credentials shows dashboard', async ({ page }) => {
  await page.goto('https://app.example.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

  await safeExpect(page, expect, 'Sign In', 'heading');
  await safeFill(page, 'Email', 'jane@test.com');
  await safeFill(page, 'Password', 'Secure123!');
  await safeClick(page, 'Sign In');

  await safeExpect(page, expect, 'Welcome back, Jane');
  await safeExpect(page, expect, 'My Account', 'link');
});`,
};

// ── Negative functional test — form validation ───────────────────────────────

export const FORM_VALIDATION_NEGATIVE_EXAMPLE = {
  name: "Empty required fields show validation errors on submit",
  description: "Verifies that submitting the contact form with empty required fields shows inline validation messages",
  preconditions: "",
  priority: "medium",
  type: "functional",
  scenario: "negative",
  testData: {},
  steps: [
    "User opens the contact page and sees the heading 'Contact Us' with Name, Email, and Message fields",
    "User leaves all fields empty and clicks the 'Send Message' button",
    "Validation error 'Name is required' appears below the Name field",
    "Validation error 'Email is required' appears below the Email field",
    "The form does NOT submit — the user remains on the same page",
  ],
  playwrightCode: `import { test, expect } from '@playwright/test';

test('Empty required fields show validation errors on submit', async ({ page }) => {
  await page.goto('https://app.example.com/contact', { waitUntil: 'domcontentloaded', timeout: 30000 });

  await safeExpect(page, expect, 'Contact Us', 'heading');
  await safeClick(page, 'Send Message');

  await safeExpect(page, expect, 'Name is required');
  await safeExpect(page, expect, 'Email is required');
  // Confirm we're still on the contact page (form did not submit)
  await safeExpect(page, expect, 'Contact Us', 'heading');
});`,
};

// ── Build the few-shot block for injection into prompts ──────────────────────

export function buildFewShotBlock() {
  return `
EXAMPLES — here are two gold-standard tests showing the expected output quality:

Example 1 (positive functional test):
${JSON.stringify(LOGIN_POSITIVE_EXAMPLE, null, 2)}

Example 2 (negative functional test):
${JSON.stringify(FORM_VALIDATION_NEGATIVE_EXAMPLE, null, 2)}

Your generated tests must match this level of specificity in steps, assertions, and test data.`.trim();
}

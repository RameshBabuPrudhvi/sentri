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
 *   - ALL test data inlined as string literals — NEVER as variables
 *   - count assertions written inline inside expect() — no locator variables
 *   - No toHaveURL() after search/navigation actions
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
  // Values are inlined as string literals — NEVER assigned to variables
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

// ── Positive functional test — search flow ───────────────────────────────────
// THIS EXAMPLE EXPLICITLY DEMONSTRATES THE THREE MOST COMMON MISTAKES:
//   MISTAKE 1 — using a variable instead of a literal:
//     BAD:  const searchTerm = 'laptop'; await safeFill(page, 'Search', searchTerm);
//     GOOD: await safeFill(page, 'Search', 'laptop');  ← literal, always works
//   MISTAKE 2 — assigning a locator to a variable before expect():
//     BAD:  const results = page.locator('.product-title'); await expect(results).toHaveCount(0);
//     GOOD: await expect(page.locator('.product-title')).not.toHaveCount(0);  ← inline
//   MISTAKE 3 — using toHaveURL() after search/navigation:
//     BAD:  await expect(page).toHaveURL('https://shop.example.com');  ← fails on query params
//     GOOD: assert visible page CONTENT instead of the URL

export const SEARCH_POSITIVE_EXAMPLE = {
  name: "Search for 'laptop' returns relevant product listings",
  description: "Verifies that entering a search query shows matching results with product titles visible",
  preconditions: "",
  priority: "high",
  type: "functional",
  scenario: "positive",
  testData: {
    searchQuery: "laptop",
  },
  steps: [
    "User opens the homepage and sees the search bar",
    "User types 'laptop' into the search bar and clicks the Search button",
    "Search results page loads showing product listings",
    "At least one result is visible and its title contains the word 'laptop'",
  ],
  playwrightCode: `import { test, expect } from '@playwright/test';

test('Search for laptop returns relevant product listings', async ({ page }) => {
  await page.goto('https://shop.example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // CORRECT: 'laptop' is a string literal — not a variable
  await safeFill(page, 'Search', 'laptop');
  await safeClick(page, 'Search');

  // Wait for results before asserting
  await page.waitForSelector('.product-title', { timeout: 15000 });

  // CORRECT: locator written inline inside expect() — no variable declaration
  await expect(page.locator('.product-title')).not.toHaveCount(0);

  // Assert visible content — first result must contain the search term
  await expect(page.locator('.product-title').first()).toContainText('laptop', { ignoreCase: true });

  // CORRECT: assert visible content, NOT toHaveURL() — URL will have query params like ?q=laptop&ref=...
  await safeExpect(page, expect, 'results for');
});`,
};

// ── Build the few-shot block for injection into prompts ──────────────────────

export function buildFewShotBlock() {
  return `
EXAMPLES — study all three gold-standard tests. Example 3 (search flow) is the most important.

Example 1 (positive — login):
${JSON.stringify(LOGIN_POSITIVE_EXAMPLE, null, 2)}

Example 2 (negative — form validation):
${JSON.stringify(FORM_VALIDATION_NEGATIVE_EXAMPLE, null, 2)}

Example 3 (positive — SEARCH FLOW — read carefully before generating any search/filter test):
${JSON.stringify(SEARCH_POSITIVE_EXAMPLE, null, 2)}

CRITICAL RULES demonstrated by the examples above — violating any of these makes the test broken:
1. ALL values in testData ('laptop', 'jane@test.com', 'Secure123!') are written as string literals directly in playwrightCode. NEVER declare a variable like "const searchTerm = 'laptop'" — searchTerm will be undefined at runtime and throw a ReferenceError.
2. Count/locator assertions: page.locator() is written INLINE inside expect() — never assigned to a const/let first.
3. Search/filter tests: assert on visible CONTENT (result titles, headings, counts). NEVER use toHaveURL() with a literal URL string after a search or navigation — the URL will always contain query params that make an exact match fail.
4. No unused variable declarations. If you assign page.locator() to a variable, use it immediately on the very next line.

Your generated tests must follow all four rules above.`.trim();
}
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
    "User opens the login page and sees a heading and credential fields",
    "User enters valid credentials into the email and password fields",
    "User clicks the sign-in button",
    "The authenticated area loads — a structural heading confirms login succeeded",
    "A navigation element confirms the user is in an authenticated session",
  ],
  playwrightCode: `import { test, expect } from '@playwright/test';

test('Successful login with valid credentials shows dashboard', async ({ page }) => {
  // Step 1: Open the login page — replace 'Sign In' with the ACTUAL heading from PAGE DATA
  await page.goto('https://app.example.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await safeExpect(page, expect, 'Sign In', 'heading');

  // Step 2: Enter credentials — values inlined as string literals, labels from PAGE DATA
  await safeFill(page, 'Email', 'jane@test.com');
  await safeFill(page, 'Password', 'Secure123!');

  // Step 3: Click the sign-in button — replace with the ACTUAL button label from PAGE DATA
  await safeClick(page, 'Sign In');

  // Step 4: Assert authenticated state via a STRUCTURAL element (heading, landmark)
  // NOT a personalized greeting like 'Welcome John' — that is dynamic content
  // Replace 'Dashboard' with the ACTUAL post-login heading from PAGE DATA
  await safeExpect(page, expect, 'Dashboard', 'heading');

  // Step 5: Confirm session via a navigation element from PAGE DATA
  await safeExpect(page, expect, 'Account', 'link');
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
  // Step 1: User opens the contact page and sees the heading 'Contact Us'
  await page.goto('https://app.example.com/contact', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await safeExpect(page, expect, 'Contact Us', 'heading');

  // Step 2: User leaves all fields empty and clicks 'Send Message'
  await safeClick(page, 'Send Message');

  // Step 3: Validation error 'Name is required' appears
  await safeExpect(page, expect, 'Name is required');

  // Step 4: Validation error 'Email is required' appears
  await safeExpect(page, expect, 'Email is required');

  // Step 5: The form does NOT submit — user remains on the same page
  await safeExpect(page, expect, 'Contact Us', 'heading');
});`,
};

// ── Positive functional test — search flow ───────────────────────────────────
// THIS EXAMPLE EXPLICITLY DEMONSTRATES THE THREE MOST COMMON MISTAKES:
//   MISTAKE 1 — using a variable instead of a literal:
//     BAD:  const query = 'test term'; await safeFill(page, 'Search', query);
//     GOOD: await safeFill(page, 'Search', 'test term');  ← literal, always works
//   MISTAKE 2 — assigning a locator to a variable before expect():
//     BAD:  const items = page.getByRole('listitem'); await expect(items).not.toHaveCount(0);
//     GOOD: await expect(page.getByRole('listitem')).not.toHaveCount(0);  ← inline
//   MISTAKE 3 — using toHaveURL() after search/navigation:
//     BAD:  await expect(page).toHaveURL('https://example.com/search');  ← fails on query params
//     GOOD: assert visible page CONTENT instead of the URL

export const SEARCH_POSITIVE_EXAMPLE = {
  name: "Search returns relevant results for a valid query",
  description: "Verifies that entering a search query shows matching results with visible content",
  preconditions: "",
  priority: "high",
  type: "functional",
  scenario: "positive",
  testData: {
    searchQuery: "test query",
  },
  steps: [
    "User opens the page and sees the search input",
    "User types a search term into the search input and submits",
    "Results appear on the page — at least one result item is visible",
    "The first result contains text related to the search term",
  ],
  playwrightCode: `import { test, expect } from '@playwright/test';

test('Search returns relevant results for a valid query', async ({ page }) => {
  // Step 1: Open the page — use the ACTUAL URL from PAGE DATA
  await page.goto('https://app.example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Step 2: Type search term and submit
  // CORRECT: 'test query' is a string literal — not a variable
  // Replace 'Search' with the ACTUAL field label/placeholder from CLASSIFIED INTERACTIVE ELEMENTS
  await safeFill(page, 'Search', 'test query');
  await safeClick(page, 'Search');

  // Step 3: Wait for results — use semantic selectors, not CSS classes like '.product-title'
  await page.waitForSelector('[role="listitem"], [data-testid*="result"], li, article', { timeout: 15000 });
  // CORRECT: locator written INLINE inside expect() — no variable declaration
  // CORRECT: .not.toHaveCount(0) — NEVER use greaterThan() which does not exist in Playwright
  await expect(page.getByRole('listitem').first()).toBeVisible();

  // Step 4: First result contains the search term
  await expect(page.getByRole('listitem').first()).toContainText('test query', { ignoreCase: true });
  // CORRECT: assert visible content, NOT toHaveURL() — URL will have query params
  await safeExpect(page, expect, 'results');
});`,
};

// ── Build the few-shot block for injection into prompts ──────────────────────

export function buildFewShotBlock() {
  return `
EXAMPLES — study all three gold-standard tests. Example 3 (search flow) is the most important.

IMPORTANT: The element labels, text strings, and field names in these examples
('Sign In', 'Email', 'Search', 'Dashboard', 'Submit', etc.) are ILLUSTRATIVE ONLY.
When generating for a real application, you MUST read the PAGE DATA / CLASSIFIED
INTERACTIVE ELEMENTS provided above and use the ACTUAL labels, roles, accessible
names, and placeholders from that data — never copy example strings directly.

Example 1 (positive — login):
${JSON.stringify(LOGIN_POSITIVE_EXAMPLE, null, 2)}

Example 2 (negative — form validation):
${JSON.stringify(FORM_VALIDATION_NEGATIVE_EXAMPLE, null, 2)}

Example 3 (positive — SEARCH FLOW — read carefully before generating any search/filter test):
${JSON.stringify(SEARCH_POSITIVE_EXAMPLE, null, 2)}

CRITICAL RULES demonstrated by the examples above — violating any of these makes the test broken:
1. ALL values in testData are written as string literals directly in playwrightCode. NEVER declare a variable like "const query = 'term'" — it will be undefined at runtime and throw a ReferenceError.
2. Count/locator assertions: locators are written INLINE inside expect() — never assigned to a const/let first. Use .not.toHaveCount(0) — NEVER use greaterThan() which does not exist in Playwright.
3. Use SEMANTIC locators (getByRole, getByLabel, getByPlaceholder, getByText) — not CSS class selectors. Read the ACTUAL roles and labels from the PAGE DATA provided above.
4. Search/filter tests: assert on visible CONTENT (result items, headings). NEVER use toHaveURL() with a literal URL string after a search or navigation — the URL will always contain query params that make an exact match fail.
5. Post-login / post-action assertions: assert STRUCTURAL elements (headings, nav landmarks, links) — NOT personalized dynamic values like 'Welcome John' or 'Order #12345'.
6. No unused variable declarations. If you assign page.locator() to a variable, use it immediately on the very next line.
7. STEP COMMENTS: Every step in the "steps" array MUST have a corresponding "// Step N:" comment in playwrightCode marking where that step's code begins. Do NOT leave any step without implementation code.

Your generated tests must follow all seven rules above.`.trim();
}
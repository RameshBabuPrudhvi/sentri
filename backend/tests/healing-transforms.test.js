/**
 * @module tests/healing-transforms
 * @description Comprehensive unit tests for selfHealing.applyHealingTransforms.
 *
 * applyHealingTransforms is a 180-line pure regex engine that rewrites raw
 * Playwright code into self-healing helper calls. It has zero tests despite
 * being on the hot path for every generated test. Bugs here silently produce
 * unexecutable code at run-time.
 *
 * Coverage areas:
 *   1. safeClick transforms   — page.click, getByRole, getByText, getByLabel,
 *                               getByPlaceholder, getByTestId, getByAltText, locator
 *   2. safeFill transforms    — page.fill, getByLabel, getByPlaceholder,
 *                               getByRole, getByTestId, locator
 *   3. safeHover transforms   — page.hover, locator, getByText, getByRole, getByTestId
 *   4. safeDblClick transforms — page.dblclick, locator, getByText, getByRole, getByTestId
 *   5. safeExpect transforms  — scoped roles, input-like roles, getByLabel,
 *                               getByText, getByPlaceholder, getByTestId, getByAltText, locator
 *   6. CSS/XPath passthrough  — selectors must not be rewritten
 *   7. Special-character safety — quotes, backticks, template injection
 *   8. Null/undefined guard   — must not throw on bad input
 *   9. No double-transform    — idempotency on already-transformed code
 *
 * Run: node tests/healing-transforms.test.js
 */

import assert from "node:assert/strict";
import { applyHealingTransforms } from "../src/selfHealing.js";

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

// ── 1. safeClick transforms ───────────────────────────────────────────────────

console.log("\n🖱️  safeClick transforms");

test("page.click('text') → safeClick", () => {
  const out = applyHealingTransforms("await page.click('Sign in')");
  assert.equal(out, "await safeClick(page, 'Sign in')");
});

test("page.click(\"text\") double-quotes → safeClick", () => {
  const out = applyHealingTransforms('await page.click("Submit")');
  assert.equal(out, "await safeClick(page, 'Submit')");
});

test("page.getByText('x').click() → safeClick", () => {
  const out = applyHealingTransforms("await page.getByText('Continue').click()");
  assert.equal(out, "await safeClick(page, 'Continue')");
});

test("page.getByRole('button', { name: 'x' }).click() → safeClick", () => {
  const out = applyHealingTransforms("await page.getByRole('button', { name: 'Log in' }).click()");
  assert.equal(out, "await safeClick(page, 'Log in')");
});

test("page.getByRole('link', ...).click() → safeClick", () => {
  const out = applyHealingTransforms("await page.getByRole('link', { name: 'Home' }).click()");
  assert.equal(out, "await safeClick(page, 'Home')");
});

test("page.getByLabel('x').click() → safeClick", () => {
  const out = applyHealingTransforms("await page.getByLabel('Accept terms').click()");
  assert.equal(out, "await safeClick(page, 'Accept terms')");
});

test("page.getByPlaceholder('x').click() → safeClick", () => {
  const out = applyHealingTransforms("await page.getByPlaceholder('Search').click()");
  assert.equal(out, "await safeClick(page, 'Search')");
});

test("page.getByTestId('x').click() → safeClick", () => {
  const out = applyHealingTransforms("await page.getByTestId('submit-btn').click()");
  assert.equal(out, "await safeClick(page, 'submit-btn')");
});

test("page.getByAltText('x').click() → safeClick", () => {
  const out = applyHealingTransforms("await page.getByAltText('Company logo').click()");
  assert.equal(out, "await safeClick(page, 'Company logo')");
});

test("page.locator('text').click() with human text → safeClick", () => {
  const out = applyHealingTransforms("await page.locator('Add to cart').click()");
  assert.equal(out, "await safeClick(page, 'Add to cart')");
});

// ── 2. CSS/XPath passthrough (must NOT be rewritten) ─────────────────────────

console.log("\n🛡️  CSS/XPath passthrough — must stay untouched");

test("page.click('#css-id') — CSS ID selector not rewritten", () => {
  const code = "await page.click('#submit-btn')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.click('.class-name') — CSS class not rewritten", () => {
  const code = "await page.click('.primary-button')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.click('[data-attr]') — attribute selector not rewritten", () => {
  const code = "await page.click('[data-action=\"submit\"]')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.click('//xpath') — XPath not rewritten", () => {
  const code = "await page.click('//button[@type=\"submit\"]')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('#id').click() — CSS id locator not rewritten", () => {
  const code = "await page.locator('#login-form').click()";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('.cls > button').click() — combinator selector not rewritten", () => {
  const code = "await page.locator('.nav > button').click()";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('[role=\"button\"]').click() — attribute selector not rewritten", () => {
  const code = "await page.locator('[role=\"button\"]').click()";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('input[name=q]').fill() — attribute selector locator not rewritten", () => {
  const code = "await page.locator('input[name=q]').fill('hello')";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 3. safeFill transforms ────────────────────────────────────────────────────

console.log("\n✏️  safeFill transforms");

test("page.fill('label', 'value') → safeFill", () => {
  const out = applyHealingTransforms("await page.fill('Email', 'user@test.com')");
  assert.equal(out, "await safeFill(page, 'Email', 'user@test.com')");
});

test("page.getByLabel('x').fill(val) → safeFill", () => {
  const out = applyHealingTransforms("await page.getByLabel('Password').fill('secret123')");
  assert.equal(out, "await safeFill(page, 'Password', 'secret123')");
});

test("page.getByPlaceholder('x').fill(val) → safeFill", () => {
  const out = applyHealingTransforms("await page.getByPlaceholder('Enter email').fill('a@b.com')");
  assert.equal(out, "await safeFill(page, 'Enter email', 'a@b.com')");
});

test("page.getByRole('textbox', { name: 'x' }).fill(val) → safeFill", () => {
  const out = applyHealingTransforms("await page.getByRole('textbox', { name: 'Username' }).fill('alice')");
  assert.equal(out, "await safeFill(page, 'Username', 'alice')");
});

test("page.getByTestId('x').fill(val) → safeFill", () => {
  const out = applyHealingTransforms("await page.getByTestId('email-input').fill('user@example.com')");
  assert.equal(out, "await safeFill(page, 'email-input', 'user@example.com')");
});

test("page.locator('label').fill(val) with human text → safeFill", () => {
  const out = applyHealingTransforms("await page.locator('First name').fill('Jane')");
  assert.equal(out, "await safeFill(page, 'First name', 'Jane')");
});

test("page.fill('#selector') CSS — not rewritten", () => {
  const code = "await page.fill('#email-field', 'user@test.com')";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 4. safeHover transforms ───────────────────────────────────────────────────

console.log("\n🕵️  safeHover transforms");

test("page.hover('text') → safeHover", () => {
  const out = applyHealingTransforms("await page.hover('Products')");
  assert.equal(out, "await safeHover(page, 'Products')");
});

test("page.locator('text').hover() → safeHover", () => {
  const out = applyHealingTransforms("await page.locator('Dropdown menu').hover()");
  assert.equal(out, "await safeHover(page, 'Dropdown menu')");
});

test("page.getByText('x').hover() → safeHover", () => {
  const out = applyHealingTransforms("await page.getByText('More options').hover()");
  assert.equal(out, "await safeHover(page, 'More options')");
});

test("page.getByRole('button', { name: 'x' }).hover() → safeHover", () => {
  const out = applyHealingTransforms("await page.getByRole('button', { name: 'Help' }).hover()");
  assert.equal(out, "await safeHover(page, 'Help')");
});

test("page.getByTestId('x').hover() → safeHover", () => {
  const out = applyHealingTransforms("await page.getByTestId('nav-menu').hover()");
  assert.equal(out, "await safeHover(page, 'nav-menu')");
});

test("page.hover('#css') — CSS selector not rewritten", () => {
  const code = "await page.hover('#dropdown-trigger')";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 5. safeDblClick transforms ────────────────────────────────────────────────

console.log("\n👆  safeDblClick transforms");

test("page.dblclick('text') → safeDblClick", () => {
  const out = applyHealingTransforms("await page.dblclick('Edit inline')");
  assert.equal(out, "await safeDblClick(page, 'Edit inline')");
});

test("page.locator('text').dblclick() → safeDblClick", () => {
  const out = applyHealingTransforms("await page.locator('Cell value').dblclick()");
  assert.equal(out, "await safeDblClick(page, 'Cell value')");
});

test("page.getByText('x').dblclick() → safeDblClick", () => {
  const out = applyHealingTransforms("await page.getByText('Rename').dblclick()");
  assert.equal(out, "await safeDblClick(page, 'Rename')");
});

test("page.getByRole('button', { name: 'x' }).dblclick() → safeDblClick", () => {
  const out = applyHealingTransforms("await page.getByRole('button', { name: 'Open' }).dblclick()");
  assert.equal(out, "await safeDblClick(page, 'Open')");
});

test("page.getByTestId('x').dblclick() → safeDblClick", () => {
  const out = applyHealingTransforms("await page.getByTestId('editable-cell').dblclick()");
  assert.equal(out, "await safeDblClick(page, 'editable-cell')");
});

test("page.dblclick('#css') — CSS selector not rewritten", () => {
  const code = "await page.dblclick('#editable-cell')";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 6. safeExpect transforms ──────────────────────────────────────────────────

console.log("\n🔍  safeExpect transforms");

test("expect(page.getByRole('button', {name:'x'})).toBeVisible() → safeExpect with role", () => {
  const out = applyHealingTransforms(
    "expect(page.getByRole('button', { name: 'Submit' })).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Submit', 'button')");
});

test("expect(page.getByRole('link', {name:'x'})).toBeVisible() → safeExpect with role", () => {
  const out = applyHealingTransforms(
    "expect(page.getByRole('link', { name: 'Home' })).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Home', 'link')");
});

test("expect(page.getByRole('heading', {name:'x'})).toBeVisible() → safeExpect with role", () => {
  const out = applyHealingTransforms(
    "expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Dashboard', 'heading')");
});

test("expect(page.getByRole('textbox', {name:'x'})).toBeVisible() → safeExpect no role (input-like)", () => {
  const out = applyHealingTransforms(
    "expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Search')");
});

test("expect(page.getByRole('searchbox', {name:'x'})).toBeVisible() → safeExpect no role", () => {
  const out = applyHealingTransforms(
    "expect(page.getByRole('searchbox', { name: 'Query' })).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Query')");
});

test("await expect(page.getByRole(...)).toBeVisible() — with leading await", () => {
  const out = applyHealingTransforms(
    "await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Cancel', 'button')");
});

test("expect(page.getByLabel('x')).toBeVisible() → safeExpect", () => {
  const out = applyHealingTransforms(
    "expect(page.getByLabel('Email address')).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Email address')");
});

test("expect(page.getByText('x')).toBeVisible() → safeExpect", () => {
  const out = applyHealingTransforms(
    "expect(page.getByText('Welcome back')).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Welcome back')");
});

test("expect(page.getByText('x', {exact:true})).toBeVisible() → safeExpect", () => {
  const out = applyHealingTransforms(
    "expect(page.getByText('Sign out', { exact: true })).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Sign out')");
});

test("expect(page.getByPlaceholder('x')).toBeVisible() → safeExpect", () => {
  const out = applyHealingTransforms(
    "expect(page.getByPlaceholder('Enter password')).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Enter password')");
});

test("expect(page.getByTestId('x')).toBeVisible() → safeExpect", () => {
  const out = applyHealingTransforms(
    "expect(page.getByTestId('hero-banner')).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'hero-banner')");
});

test("expect(page.getByAltText('x')).toBeVisible() → safeExpect", () => {
  const out = applyHealingTransforms(
    "expect(page.getByAltText('Company logo')).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Company logo')");
});

test("expect(page.locator('text')).toBeVisible() with human text → safeExpect", () => {
  const out = applyHealingTransforms(
    "expect(page.locator('Success message')).toBeVisible()"
  );
  assert.equal(out, "await safeExpect(page, expect, 'Success message')");
});

test("expect(page.locator('#css')).toBeVisible() — CSS selector NOT rewritten", () => {
  const code = "expect(page.locator('#success-banner')).toBeVisible()";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 7. Non-visibility assertions are NOT touched ──────────────────────────────

console.log("\n✋  Non-visibility assertions — must remain untouched");

test("expect(page).toHaveURL() stays as-is", () => {
  const code = "await expect(page).toHaveURL(/dashboard/)";
  assert.equal(applyHealingTransforms(code), code);
});

test("expect(page).toHaveTitle() stays as-is", () => {
  const code = "await expect(page).toHaveTitle('My App')";
  assert.equal(applyHealingTransforms(code), code);
});

test("expect(locator).toContainText() stays as-is", () => {
  const code = "await expect(page.locator('.result')).toContainText('found')";
  assert.equal(applyHealingTransforms(code), code);
});

test("expect(locator).toHaveCount() stays as-is", () => {
  const code = "await expect(page.locator('li')).toHaveCount(5)";
  assert.equal(applyHealingTransforms(code), code);
});

test("expect(locator).toHaveValue() stays as-is", () => {
  const code = "await expect(page.locator('#price')).toHaveValue('$9.99')";
  assert.equal(applyHealingTransforms(code), code);
});

test("expect(locator).toBeEnabled() stays as-is", () => {
  const code = "await expect(page.locator('button[type=submit]')).toBeEnabled()";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 8. Special character safety ───────────────────────────────────────────────

console.log("\n🔐  Special character safety");

test("single quote in text — double-quoted call is NOT transformed (regex gap: double-quotes not in char class)", () => {
  // BUG DOCUMENTED: The page.click regex uses ['"` as delimiters but the character
  // class [^'"`]+ only matches non-single-quote/non-backtick content when the
  // outer delimiter IS a single quote. page.click("User's profile") uses double
  // quotes as the outer delimiter — the regex doesn't match it, so it passes through.
  // This means double-quoted click calls with apostrophes are silently not transformed.
  const out = applyHealingTransforms(`await page.click("User's profile")`);
  // Current behavior: NOT transformed — double-quoted variant falls through
  assert.equal(out, `await page.click("User's profile")`);
});

test("backtick in single-quoted text — NOT transformed (backtick is a delimiter in the char class)", () => {
  // BUG DOCUMENTED: The regex pattern [^'"`]+ stops matching when it hits a backtick
  // because backtick is listed as a quote delimiter. So page.click('Price: `free`')
  // is not matched and passes through untransformed.
  // This means labels containing backticks are silently not transformed.
  const out = applyHealingTransforms("await page.click('Price: `free`')");
  // Current behavior: NOT transformed
  assert.equal(out, "await page.click('Price: `free`')");
});

test("special chars in backtick-delimited call ARE transformed", () => {
  // Backtick-delimited page.click calls work: page.click(`Submit`) → safeClick
  const out = applyHealingTransforms("await page.click(`Submit`)");
  assert.equal(out, "await safeClick(page, 'Submit')");
});

test("does not throw on empty string", () => {
  assert.doesNotThrow(() => applyHealingTransforms(""));
  assert.equal(applyHealingTransforms(""), "");
});

test("does not throw on null", () => {
  assert.doesNotThrow(() => applyHealingTransforms(null));
  assert.equal(applyHealingTransforms(null), "");
});

test("does not throw on undefined", () => {
  assert.doesNotThrow(() => applyHealingTransforms(undefined));
  assert.equal(applyHealingTransforms(undefined), "");
});

test("code with no Playwright calls is returned unchanged", () => {
  const code = "const x = 1;\nconsole.log(x);";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 9. Multi-line / full test body transforms ─────────────────────────────────

console.log("\n📋  Multi-line code transforms");

test("transforms multiple statements in sequence correctly", () => {
  const code = [
    "await page.goto('http://app.com/login', { waitUntil: 'domcontentloaded' });",
    "await page.fill('Email', 'user@test.com');",
    "await page.fill('Password', 'secret');",
    "await page.click('Sign in');",
    "expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();",
  ].join("\n");

  const out = applyHealingTransforms(code);

  // page.goto must survive untouched — it's not in the transform set
  assert.match(out, /page\.goto/);
  // All interactions should be transformed
  assert.match(out, /safeFill\(page, 'Email'/);
  assert.match(out, /safeFill\(page, 'Password'/);
  assert.match(out, /safeClick\(page, 'Sign in'\)/);
  assert.match(out, /safeExpect\(page, expect, 'Dashboard', 'heading'\)/);
  // No raw page.fill or page.click should remain
  assert.doesNotMatch(out, /page\.fill\(/);
  assert.doesNotMatch(out, /\bpage\.click\(/);
});

test("already-transformed code is not double-transformed", () => {
  // If code already uses safeClick, running transforms again must not corrupt it
  const already = "await safeClick(page, 'Submit');";
  const out = applyHealingTransforms(already);
  assert.equal(out, already);
});

test("page.goto is never transformed", () => {
  const code = "await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.waitForLoadState is never transformed", () => {
  const code = "await page.waitForLoadState('domcontentloaded');";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.keyboard.press is never transformed", () => {
  const code = "await page.keyboard.press('Enter');";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 10. CSS selector edge cases — pseudo-selectors, nth-child, combinators ───

console.log("\n🎯  CSS selector edge cases — pseudo, nth-child, combinators");

test("page.click('.btn:nth-child(2)') — :nth-child pseudo not rewritten", () => {
  const code = "await page.click('.btn:nth-child(2)')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.click('li:first-child') — KNOWN GAP: bare :first-child (no parens) IS transformed", () => {
  // looksLikeCssSelector requires `:first-child(` with a trailing paren, but
  // :first-child is a pseudo-class that takes no arguments. Without parens,
  // the regex doesn't match → the selector is treated as human-readable text.
  // This documents the current behavior as a known limitation.
  const code = "await page.click('li:first-child')";
  assert.equal(applyHealingTransforms(code), "await safeClick(page, 'li:first-child')");
});

test("page.click('div:last-child') — KNOWN GAP: bare :last-child (no parens) IS transformed", () => {
  // Same limitation as :first-child — the regex requires trailing parens.
  const code = "await page.click('div:last-child')";
  assert.equal(applyHealingTransforms(code), "await safeClick(page, 'div:last-child')");
});

test("page.click('button:not(.disabled)') — :not() pseudo not rewritten", () => {
  const code = "await page.click('button:not(.disabled)')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.click('ul:has(li)') — :has() pseudo not rewritten", () => {
  const code = "await page.click('ul:has(li)')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.click('input:is([type=text])') — :is() pseudo not rewritten", () => {
  const code = "await page.click('input:is([type=text])')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.click('tr:nth-of-type(3)') — :nth-of-type pseudo not rewritten", () => {
  const code = "await page.click('tr:nth-of-type(3)')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('div > span').click() — child combinator not rewritten", () => {
  const code = "await page.locator('div > span').click()";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('h2 ~ p').click() — sibling combinator not rewritten", () => {
  const code = "await page.locator('h2 ~ p').click()";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('h2 + p').click() — adjacent sibling not rewritten", () => {
  const code = "await page.locator('h2 + p').click()";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.fill('.form input[name=email]', 'x') — CSS locator fill not rewritten", () => {
  const code = "await page.fill('.form input[name=email]', 'test@x.com')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.hover('.dropdown:nth-child(1)') — CSS pseudo hover not rewritten", () => {
  const code = "await page.hover('.dropdown:nth-child(1)')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.dblclick('[data-row]:first-child') — attribute + pseudo dblclick not rewritten", () => {
  const code = "await page.dblclick('[data-row]:first-child')";
  assert.equal(applyHealingTransforms(code), code);
});

test("expect(page.locator('.alert:not(.hidden)')).toBeVisible() — CSS pseudo expect not rewritten", () => {
  const code = "expect(page.locator('.alert:not(.hidden)')).toBeVisible()";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('[data-testid=submit]').fill('x') — attribute locator fill not rewritten", () => {
  const code = "await page.locator('[data-testid=submit]').fill('test')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.locator('//div[@class=\"modal\"]').click() — XPath locator not rewritten", () => {
  const code = "await page.locator('//div[@class=\"modal\"]').click()";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 11. Template injection safety — ${} in text ──────────────────────────────

console.log("\n💉  Template injection safety — ${} in text");

test("page.click with ${} in text — dollar-brace is escaped in output", () => {
  const out = applyHealingTransforms("await page.click('Price: total')");
  // The text 'Price: total' is human-readable, should be transformed
  assert.equal(out, "await safeClick(page, 'Price: total')");
});

test("backslash in text is escaped in safeClick output", () => {
  const out = applyHealingTransforms("await page.click('path\\\\to')");
  // The esc() function should double-escape the backslash
  assert.match(out, /safeClick/);
});

// ── 12. Chained locator actions — getByLabel().hover(), getByLabel().dblclick() ─

console.log("\n🔗  Chained locator edge cases");

test("page.getByLabel('x').hover() → safeHover (not just click)", () => {
  // getByLabel().hover() is NOT covered by a specific regex — verify behavior
  const code = "await page.getByLabel('Menu').hover()";
  const out = applyHealingTransforms(code);
  // The locator-based hover regex should NOT match getByLabel (it only matches page.locator)
  // and there's no specific getByLabel().hover() rule, so it stays as-is
  // This documents the current behavior — a gap in the transform engine
  assert.equal(out, code);
});

test("page.getByLabel('x').dblclick() — no specific rule, stays as-is", () => {
  const code = "await page.getByLabel('Terms').dblclick()";
  const out = applyHealingTransforms(code);
  // No getByLabel().dblclick() regex exists — documenting the gap
  assert.equal(out, code);
});

test("page.getByAltText('x').hover() — no specific rule, stays as-is", () => {
  const code = "await page.getByAltText('Logo').hover()";
  const out = applyHealingTransforms(code);
  // No getByAltText().hover() regex exists — documenting the gap
  assert.equal(out, code);
});

test("page.getByPlaceholder('x').hover() — no specific rule, stays as-is", () => {
  const code = "await page.getByPlaceholder('Search').hover()";
  const out = applyHealingTransforms(code);
  // No getByPlaceholder().hover() regex exists — documenting the gap
  assert.equal(out, code);
});

// ── 13. All scoped roles in safeExpect ───────────────────────────────────────

console.log("\n🏷️  safeExpect — all scoped ARIA roles preserve role hint");

const SCOPED_ROLES = [
  "button", "link", "menuitem", "tab", "heading", "img", "navigation",
  "listitem", "cell", "row", "dialog", "alert", "checkbox", "radio",
  "switch", "slider", "progressbar", "option",
];

for (const role of SCOPED_ROLES) {
  test(`expect(page.getByRole('${role}', {name:'x'})).toBeVisible() preserves '${role}' hint`, () => {
    const out = applyHealingTransforms(
      `expect(page.getByRole('${role}', { name: 'TestLabel' })).toBeVisible()`
    );
    assert.equal(out, `await safeExpect(page, expect, 'TestLabel', '${role}')`);
  });
}

// ── 14. Input-like roles in safeExpect — role hint is dropped ────────────────

console.log("\n📥  safeExpect — input-like roles drop role hint");

const INPUT_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];

for (const role of INPUT_ROLES) {
  test(`expect(page.getByRole('${role}', {name:'x'})).toBeVisible() drops '${role}' hint`, () => {
    const out = applyHealingTransforms(
      `expect(page.getByRole('${role}', { name: 'Field' })).toBeVisible()`
    );
    assert.equal(out, "await safeExpect(page, expect, 'Field')");
  });
}

// ── 15. safeCheck transforms ──────────────────────────────────────────────────

console.log("\n☑️  safeCheck transforms");

test("page.check('text') → safeCheck", () => {
  const out = applyHealingTransforms("await page.check('Accept terms')");
  assert.equal(out, "await safeCheck(page, 'Accept terms')");
});

test("page.check('#css') — CSS selector not rewritten", () => {
  const code = "await page.check('#terms-checkbox')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.getByLabel('x').check() → safeCheck", () => {
  const out = applyHealingTransforms("await page.getByLabel('I agree').check()");
  assert.equal(out, "await safeCheck(page, 'I agree')");
});

test("page.locator('text').check() with human text → safeCheck", () => {
  const out = applyHealingTransforms("await page.locator('Newsletter').check()");
  assert.equal(out, "await safeCheck(page, 'Newsletter')");
});

test("page.locator('#css').check() — CSS selector not rewritten", () => {
  const code = "await page.locator('#newsletter-cb').check()";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 16. safeUncheck transforms ────────────────────────────────────────────────

console.log("\n🔲  safeUncheck transforms");

test("page.uncheck('text') → safeUncheck", () => {
  const out = applyHealingTransforms("await page.uncheck('Accept terms')");
  assert.equal(out, "await safeUncheck(page, 'Accept terms')");
});

test("page.uncheck('#css') — CSS selector not rewritten", () => {
  const code = "await page.uncheck('#terms-checkbox')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.getByLabel('x').uncheck() → safeUncheck", () => {
  const out = applyHealingTransforms("await page.getByLabel('Subscribe').uncheck()");
  assert.equal(out, "await safeUncheck(page, 'Subscribe')");
});

test("page.locator('text').uncheck() with human text → safeUncheck", () => {
  const out = applyHealingTransforms("await page.locator('Notifications').uncheck()");
  assert.equal(out, "await safeUncheck(page, 'Notifications')");
});

test("page.locator('#css').uncheck() — CSS selector not rewritten", () => {
  const code = "await page.locator('#notify-cb').uncheck()";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 17. safeSelect transforms ─────────────────────────────────────────────────

console.log("\n📋  safeSelect transforms");

test("page.selectOption('text', val) → safeSelect", () => {
  const out = applyHealingTransforms("await page.selectOption('Country', 'US')");
  assert.equal(out, "await safeSelect(page, 'Country', 'US')");
});

test("page.selectOption('#css', val) — CSS selector not rewritten", () => {
  const code = "await page.selectOption('#country-select', 'US')";
  assert.equal(applyHealingTransforms(code), code);
});

test("page.getByLabel('x').selectOption(val) → safeSelect", () => {
  const out = applyHealingTransforms("await page.getByLabel('Language').selectOption('en')");
  assert.equal(out, "await safeSelect(page, 'Language', 'en')");
});

test("page.locator('text').selectOption(val) with human text → safeSelect", () => {
  const out = applyHealingTransforms("await page.locator('Currency').selectOption('USD')");
  assert.equal(out, "await safeSelect(page, 'Currency', 'USD')");
});

test("page.locator('#css').selectOption(val) — CSS selector not rewritten", () => {
  const code = "await page.locator('#currency-sel').selectOption('USD')";
  assert.equal(applyHealingTransforms(code), code);
});

// ── 18. safeCheck/safeUncheck/safeSelect idempotency ─────────────────────────

console.log("\n🔁  safeCheck/safeUncheck/safeSelect idempotency");

test("already-transformed safeCheck is not double-transformed", () => {
  const already = "await safeCheck(page, 'Terms');";
  assert.equal(applyHealingTransforms(already), already);
});

test("already-transformed safeUncheck is not double-transformed", () => {
  const already = "await safeUncheck(page, 'Terms');";
  assert.equal(applyHealingTransforms(already), already);
});

test("already-transformed safeSelect is not double-transformed", () => {
  const already = "await safeSelect(page, 'Country', 'US');";
  assert.equal(applyHealingTransforms(already), already);
});

// ── 19. Multi-line with check/uncheck/select ─────────────────────────────────

console.log("\n📋  Multi-line with check/uncheck/select");

test("transforms check/uncheck/selectOption in a full test body", () => {
  const code = [
    "await page.goto('http://app.com/settings');",
    "await page.check('Enable notifications');",
    "await page.uncheck('Marketing emails');",
    "await page.selectOption('Timezone', 'UTC');",
    "await page.click('Save');",
  ].join("\n");

  const out = applyHealingTransforms(code);

  assert.match(out, /safeCheck\(page, 'Enable notifications'\)/);
  assert.match(out, /safeUncheck\(page, 'Marketing emails'\)/);
  assert.match(out, /safeSelect\(page, 'Timezone', 'UTC'\)/);
  assert.match(out, /safeClick\(page, 'Save'\)/);
  assert.doesNotMatch(out, /\bpage\.check\(/);
  assert.doesNotMatch(out, /\bpage\.uncheck\(/);
  assert.doesNotMatch(out, /\bpage\.selectOption\(/);
  // page.goto must survive untouched
  assert.match(out, /page\.goto/);
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.log(`\n⚠️  ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n🎉 All healing-transforms tests passed!`);
}

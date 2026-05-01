/**
 * @module pipeline/autoLogin
 * @description Selector-less login helper. Given a Playwright page, a username
 * and password, locates the three login form elements (username field,
 * password field, submit button) via a semantic-first waterfall of locator
 * strategies so users don't have to hand-author CSS selectors when creating
 * a project.
 *
 * ### Strategies (in order, per field)
 *
 * **Username field**
 *   1. `page.locator('input[type="email"]').first()`
 *   2. `page.getByLabel(/email|user|login/i)`
 *   3. `page.getByPlaceholder(/email|user|login/i)`
 *   4. `page.getByRole('textbox', { name: /email|user|login/i })`
 *   5. `page.locator('input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]')`
 *   6. First visible non-password `<input>` on the page (last resort).
 *
 * **Password field**
 *   1. `page.locator('input[type="password"]').first()` — almost always wins.
 *
 * **Submit button**
 *   1. `page.getByRole('button', { name: /sign in|log in|login|submit|continue/i })`
 *   2. `page.locator('button[type="submit"], input[type="submit"]').first()`
 *   3. `form button:not([type="button"])` scoped to the password field's form.
 *   4. Fallback: press `Enter` inside the password field (browsers submit
 *      the form natively).
 *
 * Honest limitations: this is a best-effort heuristic, not an AI solver.
 * It handles ~90% of conventional login pages (email + password + button)
 * but will miss exotic flows (multi-step SSO, captchas, phone-number-first
 * forms, shadow-DOM components without semantic roles). Those sites can
 * still fall back to the recorder or legacy explicit selectors.
 *
 * ### Backwards compatibility
 * Projects that already persist explicit `usernameSelector` / `passwordSelector`
 * / `submitSelector` values continue to use them (fast path). This module is
 * only invoked when those fields are blank.
 *
 * @example
 * const ok = await performAutoLogin(page, {
 *   username: "alice@example.com",
 *   password: "secret",
 * }, { timeout: 5000, logger: (m) => console.log(m) });
 */

/**
 * Try each candidate locator until one resolves to a visible element or we
 * run out. Returns the first winning Locator or null.
 *
 * Types intentionally kept loose (`object` / `Function`) so vanilla jsdoc
 * can parse them — the `import('@playwright/test').Page` / `.Locator` syntax
 * is valid TypeScript but unsupported by the jsdoc CLI we use in CI.
 *
 * @param {object} page - Playwright `Page` instance.
 * @param {Array<Function>} strategies - Locator-building functions.
 * @param {number} timeout - per-strategy visibility timeout (ms).
 * @returns {Promise<object|null>} Playwright `Locator` or null.
 * @private
 */
async function firstVisible(page, strategies, timeout) {
  for (const build of strategies) {
    try {
      const locator = build();
      await locator.first().waitFor({ state: "visible", timeout });
      return locator.first();
    } catch { /* next strategy */ }
  }
  return null;
}

/**
 * Resolve the three login form elements by running the waterfall strategies.
 *
 * @param {object} page - Playwright `Page` instance.
 * @param {number} timeout
 * @returns {Promise<object>} Shape: `{ username, password, submit }`. Each
 *   value is a Playwright `Locator` or null. `submit` may be null if no
 *   button is found — the caller should fall back to pressing Enter on the
 *   password field.
 * @private
 */
async function resolveLoginFields(page, timeout) {
  const username = await firstVisible(page, [
    () => page.locator('input[type="email"]'),
    () => page.getByLabel(/e-?mail|user(name)?|login/i),
    () => page.getByPlaceholder(/e-?mail|user(name)?|login/i),
    () => page.getByRole("textbox", { name: /e-?mail|user(name)?|login/i }),
    () => page.locator(
      'input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]'
    ),
    // Last resort: first visible non-password text input.
    () => page.locator('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])'),
  ], timeout);

  const password = await firstVisible(page, [
    () => page.locator('input[type="password"]'),
  ], timeout);

  const submit = await firstVisible(page, [
    () => page.getByRole("button", { name: /sign\s*in|log\s*in|login|submit|continue|next/i }),
    () => page.locator('button[type="submit"], input[type="submit"]'),
    // Any button inside a form that contains a password field.
    () => page.locator('form:has(input[type="password"]) button:not([type="button"])'),
  ], timeout);

  return { username, password, submit };
}

/**
 * Attempt to log in by auto-detecting the login form elements.
 *
 * @param {object} page - Playwright `Page` already navigated to the login URL.
 * @param {object} creds - `{ username, password }` strings.
 * @param {object} [opts]
 * @param {number}   [opts.timeout=5000]   - Per-strategy visibility timeout (ms).
 * @param {Function} [opts.logger]         - Optional logger `(msg) => void`.
 * @returns {Promise<object>} Result envelope `{ ok: boolean, reason?: string }`.
 *   Never throws — transient Playwright errors are captured in `reason`.
 */
export async function performAutoLogin(page, { username, password }, { timeout = 5000, logger } = {}) {
  const log = typeof logger === "function" ? logger : () => {};
  if (!username || !password) {
    return { ok: false, reason: "username and password are required" };
  }

  try {
    const { username: userEl, password: passEl, submit: submitEl } = await resolveLoginFields(page, timeout);

    if (!userEl) return { ok: false, reason: "Could not locate username/email field" };
    if (!passEl) return { ok: false, reason: "Could not locate password field" };

    await userEl.fill(username);
    await passEl.fill(password);

    if (submitEl) {
      await submitEl.click({ timeout });
    } else {
      // No submit button found — pressing Enter submits the form natively
      // in virtually all browsers when the focus is inside a password field
      // that lives inside a <form>.
      log("No submit button found, pressing Enter to submit");
      await passEl.press("Enter");
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

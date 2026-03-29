/**
 * selfHealing.js — Self-Healing Utility for Playwright
 */

const DEFAULT_TIMEOUT = 5000;
const RETRY_COUNT = 3;
const RETRY_DELAY = 400;

// ─────────────────────────────────────────────────────────────────────────────
// Utility: sleep
// ─────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Utility: retry wrapper
// ─────────────────────────────────────────────────────────────────────────────
async function retry(fn, retries = RETRY_COUNT, delay = RETRY_DELAY) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await sleep(delay);
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: findElement (robust + debuggable)
// ─────────────────────────────────────────────────────────────────────────────
async function findElement(page, strategies, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT;
  let lastError;

  for (const strategy of strategies) {
    try {
      // .first() prevents strict mode violations when a locator matches
      // multiple elements (e.g. Google has 2 "Google Search" buttons).
      const locator = strategy(page).first();

      await locator.waitFor({
        state: 'visible',
        timeout,
      });

      return locator;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `❌ Element not found using any strategy.\nLast error: ${lastError}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: ensure element is ready
// ─────────────────────────────────────────────────────────────────────────────
async function ensureReady(locator) {
  await locator.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

  try {
    await locator.scrollIntoViewIfNeeded();
  } catch {}

  // Optional stricter checks (safe fallback if not supported)
  try {
    await locator.waitFor({ state: 'attached' });
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-healing helpers (runtime injection)
// ─────────────────────────────────────────────────────────────────────────────
export function getSelfHealingHelperCode() {
  return `
    const DEFAULT_TIMEOUT = 5000;
    const RETRY_COUNT = 3;
    const RETRY_DELAY = 400;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function retry(fn, retries = RETRY_COUNT, delay = RETRY_DELAY) {
      let lastError;
      for (let i = 0; i < retries; i++) {
        try {
          return await fn();
        } catch (err) {
          lastError = err;
          await sleep(delay);
        }
      }
      throw lastError;
    }

    async function findElement(page, strategies, options = {}) {
      const timeout = options.timeout || DEFAULT_TIMEOUT;
      let lastError;

      for (const strategy of strategies) {
        try {
          // .first() prevents strict mode violations when a locator matches
          // multiple elements (e.g. Google has 2 "Google Search" buttons —
          // one visible, one in a hidden form). Playwright strict mode throws
          // on locator.waitFor() if the locator resolves to 2+ elements.
          const locator = strategy(page).first();
          await locator.waitFor({ state: 'visible', timeout });
          return locator;
        } catch (err) {
          lastError = err;
        }
      }

      throw new Error(
        'Element not found using any strategy. Last error: ' + lastError
      );
    }

    async function ensureReady(locator) {
      await locator.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

      try { await locator.scrollIntoViewIfNeeded(); } catch {}
      try { await locator.waitFor({ state: 'attached' }); } catch {}
    }

    async function safeClick(page, text) {
      const strategies = [
        p => p.getByRole('button', { name: text }),
        p => p.getByRole('link',   { name: text }),
        p => p.getByText(text, { exact: true }),
        p => p.getByText(text),
        p => p.locator(\`[aria-label*="\${text}"]\`),
        p => p.locator(\`[title*="\${text}"]\`),
      ];

      const el = await findElement(page, strategies);

      await retry(async () => {
        await ensureReady(el);
        await el.click({ timeout: DEFAULT_TIMEOUT });
      });
    }

    async function safeFill(page, labelOrPlaceholder, value) {
      // Strategies ordered from most-specific to broadest.
      // NOTE: We do NOT use input[name*=normalized] — that maps the human label
      // (e.g. "Search") to a name attribute guess (e.g. name*="search") which is
      // almost always wrong. Google's search box has name="q", not name="search".
      // Instead we fall through to aria-label, title, and finally any visible input.
      const strategies = [
        p => p.getByLabel(labelOrPlaceholder),
        p => p.getByPlaceholder(labelOrPlaceholder),
        p => p.getByRole('searchbox', { name: labelOrPlaceholder }),
        p => p.getByRole('combobox',  { name: labelOrPlaceholder }),
        p => p.getByRole('textbox',   { name: labelOrPlaceholder }),
        p => p.locator(\`input[aria-label*="\${labelOrPlaceholder}"]\`),
        p => p.locator(\`textarea[aria-label*="\${labelOrPlaceholder}"]\`),
        p => p.locator(\`input[title*="\${labelOrPlaceholder}"]\`),
        p => p.locator('input:visible, textarea:visible').first(),
      ];

      const el = await findElement(page, strategies);

      await retry(async () => {
        await ensureReady(el);
        await el.fill('');
        await el.fill(value);
      });
    }

    // safeExpect(page, expect, text, assertion?)
    //
    // Problem this solves: AI-generated assertions like
    //   expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible()
    // fail when the actual ARIA role differs from the AI's guess (Google's
    // search box has role="combobox", not "textbox").
    //
    // safeExpect finds the element using the same multi-strategy waterfall as
    // safeFill / safeClick, then asserts .toBeVisible() on whichever locator
    // actually resolves. This makes visibility assertions as self-healing as
    // the interactions themselves.
    //
    // Usage:
    //   await safeExpect(page, expect, 'Search');            // toBeVisible
    //   await safeExpect(page, expect, 'Sign in', 'button'); // scoped to role
    async function safeExpect(page, expect, text, role) {
      const strategies = role
        ? [
            p => p.getByRole(role, { name: text }),
            p => p.getByText(text, { exact: true }),
            p => p.getByText(text),
            p => p.getByLabel(text),
            p => p.locator(\`[aria-label*="\${text}"]\`),
          ]
        : [
            // Input / field visibility (covers searchbox, combobox, textbox)
            p => p.getByRole('searchbox', { name: text }),
            p => p.getByRole('combobox',  { name: text }),
            p => p.getByRole('textbox',   { name: text }),
            p => p.getByLabel(text),
            p => p.getByPlaceholder(text),
            p => p.locator(\`input[aria-label*="\${text}"]\`),
            p => p.locator(\`input[title*="\${text}"]\`),
            // Clickable element visibility
            p => p.getByRole('button', { name: text }),
            p => p.getByRole('link',   { name: text }),
            p => p.getByText(text, { exact: true }),
            p => p.getByText(text),
            p => p.locator(\`[aria-label*="\${text}"]\`),
          ];

      const el = await findElement(page, strategies);
      await expect(el).toBeVisible();
    }
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safer Transform Engine
// ─────────────────────────────────────────────────────────────────────────────
export function applyHealingTransforms(code) {
  return code
    // ── Interaction transforms ──────────────────────────────────────────────
    .replace(
      /\bpage\.click\(['"`]([^'"`]+)['"`]\)/g,
      "safeClick(page, '$1')"
    )
    .replace(
      /\bpage\.fill\(['"`]([^'"`]+)['"`],\s*([^)]+)\)/g,
      "safeFill(page, '$1', $2)"
    )
    .replace(
      /page\.getByText\(['"`]([^'"`]+)['"`]\)\.click\(\)/g,
      "safeClick(page, '$1')"
    )
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`]\)\.fill\(([^)]+)\)/g,
      "safeFill(page, '$1', $2)"
    )
    .replace(
      /page\.getByPlaceholder\(['"`]([^'"`]+)['"`]\)\.fill\(([^)]+)\)/g,
      "safeFill(page, '$1', $2)"
    )
    // ── Assertion transforms ────────────────────────────────────────────────
    // Rewrite brittle role-based visibility assertions into safeExpect so the
    // ARIA role guess from the AI doesn't cause the test to fail.
    //
    // expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible()
    //   → await safeExpect(page, expect, 'Search')
    //
    // expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    //   → await safeExpect(page, expect, 'Sign in', 'button')
    //
    // Non-role assertions (toHaveURL, toContainText, etc.) are left alone.
    .replace(
      /expect\(page\.getByRole\(['"`](button|link)['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\)\.toBeVisible\(\)/g,
      "await safeExpect(page, expect, '$2', '$1')"
    )
    .replace(
      /expect\(page\.getByRole\(['"`](?:textbox|searchbox|combobox)['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\)\.toBeVisible\(\)/g,
      "await safeExpect(page, expect, '$1')"
    )
    .replace(
      /expect\(page\.getByLabel\(['"`]([^'"`]+)['"`]\)\)\.toBeVisible\(\)/g,
      "await safeExpect(page, expect, '$1')"
    )
    .replace(
      /expect\(page\.getByText\(['"`]([^'"`]+)['"`](?:,\s*\{[^}]*\})?\)\)\.toBeVisible\(\)/g,
      "await safeExpect(page, expect, '$1')"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Rules (unchanged but stricter tone)
// ─────────────────────────────────────────────────────────────────────────────
export const SELF_HEALING_PROMPT_RULES = `
STRICT RULE: Use ONLY self-healing helpers for ALL interactions AND visibility assertions.

INTERACTIONS — use these exclusively:
  ✓ await safeClick(page, text)            — for any click
  ✓ await safeFill(page, label, value)     — for any input fill

VISIBILITY ASSERTIONS — use safeExpect instead of raw locators:
  ✓ await safeExpect(page, expect, text)           — assert any element is visible
  ✓ await safeExpect(page, expect, text, 'button') — scoped to a role

OTHER ASSERTIONS — these are fine as-is (do not wrap them):
  ✓ await expect(page).toHaveURL(...)
  ✓ await expect(page).toHaveTitle(...)
  ✓ await expect(locator).toContainText(...)
  ✓ await expect(locator).toHaveValue(...)
  ✓ await expect(locator).toBeEnabled()

FORBIDDEN — never use these:
  ✗ page.click(...)
  ✗ page.fill(...)
  ✗ page.locator(...).click()
  ✗ page.getByRole(...).click()
  ✗ page.getByText(...).click()
  ✗ page.getByLabel(...).fill()
  ✗ expect(page.getByRole(...)).toBeVisible()   ← use safeExpect instead
  ✗ expect(page.getByText(...)).toBeVisible()   ← use safeExpect instead
`.trim();
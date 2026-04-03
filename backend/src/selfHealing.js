/**
 * selfHealing.js — Self-Healing Utility for Playwright
 *
 * Features:
 * - Multi-strategy element finding with retry logic
 * - Healing history: records which strategy index succeeded per element so
 *   future runs try the winning strategy first (adaptive self-healing)
 * - Comprehensive ARIA role coverage in assertion transforms
 */

// ─────────────────────────────────────────────────────────────────────────────
// Healing History — server-side store
// ─────────────────────────────────────────────────────────────────────────────
// Tracks which strategy index succeeded for a given action+label combination
// so future runs can prioritise the winning strategy.
//
// Key format: "<testId>::<action>::<label>"
// Value: { strategyIndex: number, succeededAt: string, failCount: number }

/**
 * Record a successful healing result in the DB.
 */
export function recordHealing(db, testId, action, label, strategyIndex) {
  if (!db?.healingHistory) return;
  const key = `${testId}::${action}::${label}`;
  db.healingHistory[key] = {
    strategyIndex,
    succeededAt: new Date().toISOString(),
    failCount: (db.healingHistory[key]?.failCount || 0),
  };
}

/**
 * Record a failed healing attempt (all strategies exhausted).
 */
export function recordHealingFailure(db, testId, action, label) {
  if (!db?.healingHistory) return;
  const key = `${testId}::${action}::${label}`;
  const existing = db.healingHistory[key] || { strategyIndex: -1, succeededAt: null, failCount: 0 };
  existing.failCount++;
  db.healingHistory[key] = existing;
}

/**
 * Get the previously-successful strategy index for an action+label, or -1.
 */
export function getHealingHint(db, testId, action, label) {
  if (!db?.healingHistory) return -1;
  const key = `${testId}::${action}::${label}`;
  return db.healingHistory[key]?.strategyIndex ?? -1;
}

/**
 * Serialise healing history for a test so it can be injected into runtime code.
 */
export function getHealingHistoryForTest(db, testId) {
  if (!db?.healingHistory) return {};
  const prefix = `${testId}::`;
  const result = {};
  for (const [key, val] of Object.entries(db.healingHistory)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = val.strategyIndex;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-healing helpers (runtime injection)
// ─────────────────────────────────────────────────────────────────────────────
// Read self-healing runtime defaults from env (baked into generated code at call time)
const HEALING_ELEMENT_TIMEOUT = parseInt(process.env.HEALING_ELEMENT_TIMEOUT, 10) || 5000;
const HEALING_RETRY_COUNT     = parseInt(process.env.HEALING_RETRY_COUNT, 10) || 3;
const HEALING_RETRY_DELAY     = parseInt(process.env.HEALING_RETRY_DELAY, 10) || 400;

export function getSelfHealingHelperCode(healingHints) {
  // healingHints is an optional map of "<action>::<label>" → strategyIndex
  const hintsJSON = JSON.stringify(healingHints || {});
  return `
    const DEFAULT_TIMEOUT = ${HEALING_ELEMENT_TIMEOUT};
    const RETRY_COUNT = ${HEALING_RETRY_COUNT};
    const RETRY_DELAY = ${HEALING_RETRY_DELAY};

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ── Healing history from previous runs ──────────────────────────────────
    // Maps "action::label" → winning strategy index so we try it first.
    const __healingHints = ${hintsJSON};
    // Accumulates healing events during this run for the runner to persist.
    const __healingEvents = [];

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

    // History-aware findElement: if a previous run recorded a winning strategy
    // for this action+label, try it first before falling through to the full
    // waterfall. This avoids wasting time on strategies that previously failed.
    async function findElement(page, strategies, options = {}) {
      const timeout = options.timeout || DEFAULT_TIMEOUT;
      const hintKey = options.healingKey || null;
      const hintIdx = hintKey ? (__healingHints[hintKey] ?? -1) : -1;
      let lastError;
      let winningIndex = -1;

      // If we have a hint from a previous run, try that strategy first
      if (hintIdx >= 0 && hintIdx < strategies.length) {
        try {
          const locator = strategies[hintIdx](page).first();
          await locator.waitFor({ state: 'visible', timeout });
          winningIndex = hintIdx;
          if (hintKey) {
            __healingEvents.push({ key: hintKey, strategyIndex: hintIdx, healed: false });
          }
          return locator;
        } catch (err) {
          lastError = err;
        }
      }

      // Full waterfall — try every strategy in order
      for (let i = 0; i < strategies.length; i++) {
        if (i === hintIdx) continue; // already tried above
        try {
          const locator = strategies[i](page).first();
          await locator.waitFor({ state: 'visible', timeout });
          winningIndex = i;
          if (hintKey) {
            // Record that we healed: a different strategy won than the hint (or no hint existed)
            __healingEvents.push({ key: hintKey, strategyIndex: i, healed: hintIdx !== i });
          }
          return locator;
        } catch (err) {
          lastError = err;
        }
      }

      // All strategies failed
      if (hintKey) {
        __healingEvents.push({ key: hintKey, strategyIndex: -1, healed: false, failed: true });
      }

      // Extract a human-readable message from the last error.
      // Playwright can throw AggregateError (with .errors[]) or regular Error.
      // String-concatenating an Error object directly produces unhelpful output
      // like "[object Object]" or just "AggregateError".
      let errMsg = 'unknown error';
      if (lastError) {
        if (lastError.errors && lastError.errors.length) {
          // AggregateError — join the sub-error messages
          errMsg = lastError.errors.map(e => e?.message || String(e)).join('; ');
        } else {
          errMsg = lastError.message || String(lastError);
        }
      }

      throw new Error(
        'Element not found using any strategy. Last error: ' + errMsg
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
        p => p.getByRole('menuitem', { name: text }),
        p => p.getByRole('tab',    { name: text }),
        p => p.getByText(text, { exact: true }),
        p => p.getByText(text),
        p => p.locator(\`[aria-label*="\${text}"]\`),
        p => p.locator(\`[title*="\${text}"]\`),
      ];

      const el = await findElement(page, strategies, { healingKey: 'click::' + text });

      await retry(async () => {
        await ensureReady(el);
        await el.click({ timeout: DEFAULT_TIMEOUT });
      });

      // After clicking, give the page a moment to settle — navigation links
      // and SPAs need time to load the new content before the next assertion.
      // Use domcontentloaded (not networkidle) because SPAs and e-commerce
      // sites fire continuous background requests and never reach networkidle,
      // causing a guaranteed timeout.
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    }

    // Helper: restrict a locator to only fillable elements so we never
    // try to .fill() a link, div, or other non-editable element.
    // Playwright's getByLabel/getByPlaceholder can match <a aria-label="...">,
    // which causes "Element is not an <input>, <textarea> or <select>" errors.
    const FILLABLE_SELECTOR = 'input, textarea, select, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';
    function onlyFillable(locator) {
      return locator.locator(FILLABLE_SELECTOR);
    }

    async function safeFill(page, labelOrPlaceholder, value) {
      const strategies = [
        p => onlyFillable(p.getByLabel(labelOrPlaceholder)),
        p => p.getByPlaceholder(labelOrPlaceholder),
        p => p.getByRole('searchbox', { name: labelOrPlaceholder }),
        p => p.getByRole('combobox',  { name: labelOrPlaceholder }),
        p => p.getByRole('textbox',   { name: labelOrPlaceholder }),
        p => p.getByRole('spinbutton', { name: labelOrPlaceholder }),
        p => p.locator(\`input[aria-label*="\${labelOrPlaceholder}"]\`),
        p => p.locator(\`textarea[aria-label*="\${labelOrPlaceholder}"]\`),
        p => p.locator(\`input[title*="\${labelOrPlaceholder}"]\`),
      ];

      const el = await findElement(page, strategies, { healingKey: 'fill::' + labelOrPlaceholder });

      await retry(async () => {
        await ensureReady(el);
        await el.fill('');
        await el.fill(value);
      });
    }

    // safeExpect — self-healing visibility assertions
    //
    // Covers ALL common ARIA roles so the AI's role guess doesn't break the test.
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
            // Input / field visibility
            p => p.getByRole('searchbox', { name: text }),
            p => p.getByRole('combobox',  { name: text }),
            p => p.getByRole('textbox',   { name: text }),
            p => p.getByRole('spinbutton', { name: text }),
            p => p.getByLabel(text),
            p => p.getByPlaceholder(text),
            p => p.locator(\`input[aria-label*="\${text}"]\`),
            p => p.locator(\`input[title*="\${text}"]\`),
            // Clickable / structural element visibility
            p => p.getByRole('button',     { name: text }),
            p => p.getByRole('link',       { name: text }),
            p => p.getByRole('menuitem',   { name: text }),
            p => p.getByRole('tab',        { name: text }),
            p => p.getByRole('heading',    { name: text }),
            p => p.getByRole('img',        { name: text }),
            p => p.getByRole('navigation', { name: text }),
            p => p.getByRole('listitem',   { name: text }),
            p => p.getByRole('cell',       { name: text }),
            p => p.getByRole('row',        { name: text }),
            p => p.getByRole('dialog',     { name: text }),
            p => p.getByRole('alert',      { name: text }),
            p => p.getByRole('checkbox',   { name: text }),
            p => p.getByRole('radio',      { name: text }),
            p => p.getByRole('switch',     { name: text }),
            p => p.getByRole('slider',     { name: text }),
            p => p.getByRole('progressbar', { name: text }),
            p => p.getByRole('option',     { name: text }),
            p => p.getByText(text, { exact: true }),
            p => p.getByText(text),
            p => p.locator(\`[aria-label*="\${text}"]\`),
          ];

      const el = await findElement(page, strategies, { healingKey: 'expect::' + text });
      // Wait for the element to stabilise before asserting — prevents flaky
      // failures during page transitions, SPA re-renders, and CSS animations.
      await el.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT }).catch(() => {});
      await expect(el).toBeVisible();
    }
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safer Transform Engine
// ─────────────────────────────────────────────────────────────────────────────

// Detect CSS/XPath selectors that should NOT be rewritten to text-based helpers.
// Matches arguments starting with #, ., [, //, or containing CSS combinators
// (whitespace-delimited >, ~, +) or pseudo-selectors (`:hover`, `:nth-child`).
// Human-readable text like "Email:", "Price: $10", or "Add + Continue" is NOT
// matched — we only flag combinators surrounded by selector-like context and
// pseudo-selectors that follow a word boundary (e.g. `div:hover`, `a:nth-child`).
// The pseudo-selector pattern requires a tag-like word followed by : and another
// word-char (e.g. `div:hover`, `input:focus`) — a trailing colon like "Email:"
// won't match because the colon is followed by a space or end-of-string.
// The combinator pattern requires selector-like context on BOTH sides:
// a word-char or closing-bracket before the combinator, and a word-char,
// dot, hash, or bracket after it. This avoids matching human-readable
// text like "Add + Continue" or "Terms + Conditions" where both sides
// are just words separated by spaces.
const CSS_SELECTOR_RE = /^[#.\[/]|^\/\/|(?:[\w\])])\s[>~+]\s(?:[\w#.\[:])|(?:\w):(?::|(?=[a-zA-Z-]\w))|\w\[/;

function looksLikeCssSelector(arg) {
  return CSS_SELECTOR_RE.test(arg.trim());
}

// Escape single quotes in captured text so injecting into '...' strings is safe.
function esc(s) { return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }

export function applyHealingTransforms(code) {
  return code
    // ── Interaction transforms ──────────────────────────────────────────────
    // page.click / page.fill — only transform human-readable text, NOT CSS selectors.
    // e.g. page.click('Sign in') → safeClick, but page.click('#btn') stays as-is.
    .replace(
      /\bpage\.click\(['"`]([^'"`]+)['"`]\)/g,
      (match, arg) => looksLikeCssSelector(arg) ? match : `safeClick(page, '${esc(arg)}')`
    )
    .replace(
      /\bpage\.fill\(['"`]([^'"`]+)['"`],\s*([^)]+)\)/g,
      (match, arg, val) => looksLikeCssSelector(arg) ? match : `safeFill(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByText\(['"`]([^'"`]+)['"`]\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    // page.locator(...).click() — leave CSS-based locators alone
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.click\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeClick(page, '${esc(sel)}')`
    )
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`]\)\.fill\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByPlaceholder\(['"`]([^'"`]+)['"`]\)\.fill\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.fill\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    // ── Assertion transforms ────────────────────────────────────────────────
    // Rewrite ALL role-based visibility assertions into safeExpect.
    // Covers every common ARIA role — not just the original 5.
    //
    // Scoped roles (button, link, menuitem, tab) keep the role hint:
    //   expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    //   → await safeExpect(page, expect, 'Sign in', 'button')
    //
    // Input-like roles drop the role (safeExpect tries all input roles):
    //   expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible()
    //   → await safeExpect(page, expect, 'Search')
    //
    // Structural roles (heading, img, dialog, etc.) keep the role hint:
    //   expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    //   → await safeExpect(page, expect, 'Dashboard', 'heading')
    //
    // Non-role assertions (toHaveURL, toContainText, etc.) are left alone.

    // Scoped roles — keep role hint
    .replace(
      /(?:await\s+)?expect\(page\.getByRole\(['"`](button|link|menuitem|tab|heading|img|navigation|listitem|cell|row|dialog|alert|checkbox|radio|switch|slider|progressbar|option)['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\)\.toBeVisible\(\)/g,
      (match, role, name) => `await safeExpect(page, expect, '${esc(name)}', '${esc(role)}')`
    )
    // Input-like roles — drop role (safeExpect waterfall covers all input types)
    .replace(
      /(?:await\s+)?expect\(page\.getByRole\(['"`](?:textbox|searchbox|combobox|spinbutton)['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\)\.toBeVisible\(\)/g,
      (match, name) => `await safeExpect(page, expect, '${esc(name)}')`
    )
    // Catch-all for any remaining getByRole(...).toBeVisible() with unknown roles
    .replace(
      /(?:await\s+)?expect\(page\.getByRole\(['"`]([^'"`]+)['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\)\.toBeVisible\(\)/g,
      (match, role, name) => `await safeExpect(page, expect, '${esc(name)}', '${esc(role)}')`
    )
    .replace(
      /(?:await\s+)?expect\(page\.getByLabel\(['"`]([^'"`]+)['"`]\)\)\.toBeVisible\(\)/g,
      (match, name) => `await safeExpect(page, expect, '${esc(name)}')`
    )
    .replace(
      /(?:await\s+)?expect\(page\.getByText\(['"`]([^'"`]+)['"`](?:,\s*\{[^}]*\})?\)\)\.toBeVisible\(\)/g,
      (match, name) => `await safeExpect(page, expect, '${esc(name)}')`
    )
    .replace(
      /(?:await\s+)?expect\(page\.getByPlaceholder\(['"`]([^'"`]+)['"`]\)\)\.toBeVisible\(\)/g,
      (match, name) => `await safeExpect(page, expect, '${esc(name)}')`
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
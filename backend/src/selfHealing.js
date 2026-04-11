/**
 * @module selfHealing
 * @description Self-Healing Utility for Playwright test execution.
 *
 * ### Features
 * - Multi-strategy element finding with retry logic
 * - Healing history: records which strategy index succeeded per element so
 *   future runs try the winning strategy first (adaptive self-healing)
 * - Comprehensive ARIA role coverage in assertion transforms
 * - Code transform engine that rewrites raw Playwright calls into self-healing helpers
 *
 * ### Exports
 * - {@link recordHealing} — Record a successful healing result.
 * - {@link recordHealingFailure} — Record a failed healing attempt.
 * - {@link getHealingHint} — Get the previously-successful strategy index.
 * - {@link getHealingHistoryForTest} — Serialise healing history for runtime injection.
 * - {@link getSelfHealingHelperCode} — Generate the runtime helper code string.
 * - {@link applyHealingTransforms} — Rewrite Playwright code to use self-healing helpers.
 * - {@link SELF_HEALING_PROMPT_RULES} — Prompt rules for AI code generation.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Healing History — server-side store
// ─────────────────────────────────────────────────────────────────────────────
// Tracks which strategy index succeeded for a given action+label combination
// so future runs can prioritise the winning strategy.
//
// Key format: "<testId>::<action>::<label>"
// Value: { strategyIndex: number, succeededAt: string, failCount: number }

import * as healingRepo from "./database/repositories/healingRepo.js";

/**
 * Record a successful healing result.
 *
 * @param {string} testId         - Test ID (e.g. `"TC-1"`).
 * @param {string} action         - Action type (`"click"`, `"fill"`, `"expect"`).
 * @param {string} label          - Element label/text used in the action.
 * @param {number} strategyIndex  - Index of the winning strategy in the waterfall.
 */
export function recordHealing(testId, action, label, strategyIndex) {
  if (!testId || !action || typeof label !== "string") return;
  const idx = Number.isInteger(strategyIndex) && strategyIndex >= 0 ? strategyIndex : -1;
  if (idx < 0) return;
  const key = `${testId}::${action}::${label}`;
  const existing = healingRepo.get(key);
  healingRepo.set(key, {
    strategyIndex: idx,
    succeededAt: new Date().toISOString(),
    failCount: existing?.failCount || 0,
  });
}

/**
 * Record a failed healing attempt (all strategies exhausted).
 *
 * @param {string} testId  - Test ID.
 * @param {string} action  - Action type.
 * @param {string} label   - Element label/text.
 */
export function recordHealingFailure(testId, action, label) {
  if (!testId || !action || typeof label !== "string") return;
  const key = `${testId}::${action}::${label}`;
  const existing = healingRepo.get(key) || { strategyIndex: -1, succeededAt: null, failCount: 0 };
  existing.failCount++;
  healingRepo.set(key, existing);
}

/**
 * Get the previously-successful strategy index for an action+label, or -1.
 *
 * @param {string} testId  - Test ID.
 * @param {string} action  - Action type.
 * @param {string} label   - Element label/text.
 * @returns {number}         Strategy index (0-based), or `-1` if no history.
 */
export function getHealingHint(testId, action, label) {
  if (!testId || !action || typeof label !== "string") return -1;
  const key = `${testId}::${action}::${label}`;
  const entry = healingRepo.get(key);
  if ((entry?.failCount || 0) >= HEALING_HINT_MAX_FAILS) return -1;
  return entry?.strategyIndex ?? -1;
}

/**
 * Serialise healing history for a test so it can be injected into runtime code.
 *
 * @param {string} testId  - Test ID.
 * @returns {Object<string, number>} Map of `"action::label"` → winning strategy index.
 */
export function getHealingHistoryForTest(testId) {
  const entries = healingRepo.getByTestId(testId);
  const result = {};
  for (const [shortKey, val] of Object.entries(entries)) {
    const idx = val.strategyIndex;
    if ((val?.failCount || 0) >= HEALING_HINT_MAX_FAILS) continue;
    if (!Number.isInteger(idx) || idx < 0) continue;
    result[shortKey] = idx;
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
const HEALING_HINT_MAX_FAILS  = parseInt(process.env.HEALING_HINT_MAX_FAILS, 10) || 3;
const HEALING_VISIBLE_WAIT_CAP = parseInt(process.env.HEALING_VISIBLE_WAIT_CAP, 10) || 1200;

/**
 * Generate the self-healing runtime helper code as a string for injection
 * into Playwright test execution context. Includes `findElement`, `safeClick`,
 * `safeFill`, `safeExpect`, and retry logic.
 *
 * @param {Object<string, number>} [healingHints] - Map of `"action::label"` → strategy index from previous runs.
 * @returns {string} JavaScript code string to be prepended to test execution.
 */
export function getSelfHealingHelperCode(healingHints) {
  // healingHints is an optional map of "<action>::<label>" → strategyIndex.
  // Guard: if the caller passes null, a number, or an array, coerce to {}
  // so the injected `const __healingHints = ...` is always a valid object literal.
  const safeHints = (healingHints && typeof healingHints === "object" && !Array.isArray(healingHints))
    ? healingHints
    : {};
  const hintsJSON = JSON.stringify(safeHints);
  return `
    const DEFAULT_TIMEOUT = ${HEALING_ELEMENT_TIMEOUT};
    const RETRY_COUNT = ${HEALING_RETRY_COUNT};
    const RETRY_DELAY = ${HEALING_RETRY_DELAY};
    const FIRST_VISIBLE_WAIT_CAP = ${HEALING_VISIBLE_WAIT_CAP};

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const looksLikeSelector = (value) => {
      if (!value || typeof value !== 'string') return false;
      const s = value.trim();
      return /^(#|\\.|\\[|\\/\\/)/.test(s)
        || /(?:[\\w\\])])\\s[>~+]\\s(?:[\\w#.\\[:])/.test(s)
        || /\\w\\[[^\\]]+\\]/.test(s)
        || /:(?:nth-child|nth-of-type|first-child|last-child|has|is|not)\\(/.test(s);
    };

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
    // Given a base locator (which may match multiple DOM elements), return
    // the first element that is actually visible.  Falls back to .first()
    // only when no visible element is found — so the caller gets a clear
    // "not visible" error instead of silently picking a hidden duplicate
    // (e.g. a button inside a collapsed mobile menu).
    async function firstVisible(baseLocator, timeout) {
      // Guard: if a strategy factory returned null/undefined instead of a
      // Locator, fail fast with a clear message rather than a cryptic
      // "Cannot read properties of undefined (reading 'count')" deep inside Playwright.
      if (!baseLocator) {
        throw new Error('Strategy returned a null/undefined locator');
      }
      const count = await baseLocator.count().catch(() => 0);
      for (let n = 0; n < count; n++) {
        const candidate = baseLocator.nth(n);
        const visible = await candidate.isVisible().catch(() => false);
        if (visible) return candidate;
      }
      // No element is visible yet — wait for the first one to appear.
      // This preserves the original timeout-based retry behaviour.
      const first = baseLocator.first();
      const waitTimeout = Math.min(timeout, FIRST_VISIBLE_WAIT_CAP);
      await first.waitFor({ state: 'visible', timeout: waitTimeout });
      return first;
    }

    async function findElement(page, strategies, options = {}) {
      const timeout = options.timeout || DEFAULT_TIMEOUT;
      const hintKey = options.healingKey || null;
      const hintIdx = hintKey ? (__healingHints[hintKey] ?? -1) : -1;
      let lastError;

      // Helper: invoke a strategy factory and feed the result to firstVisible.
      // The factory call (e.g. p => p.locator(badXPath)) can throw synchronously
      // if Playwright rejects the selector at construction time. Wrapping it here
      // ensures a synchronous throw is caught just like an async timeout, so the
      // waterfall continues to the next strategy instead of aborting entirely.
      async function tryStrategy(strategyFn, page, timeout) {
        const locator = strategyFn(page);  // may throw synchronously
        return await firstVisible(locator, timeout);
      }

      // If we have a hint from a previous run, try that strategy first
      if (hintIdx >= 0 && hintIdx < strategies.length) {
        try {
          const locator = await tryStrategy(strategies[hintIdx], page, timeout);
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
          const locator = await tryStrategy(strategies[i], page, timeout);
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
      // All steps are best-effort: if the element is momentarily detached
      // or hidden, we still want to attempt scroll + attach before giving up.
      // The caller's retry loop will re-attempt the full sequence if needed.
      try { await locator.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT }); } catch {}
      try { await locator.scrollIntoViewIfNeeded(); } catch {}
      try { await locator.waitFor({ state: 'attached' }); } catch {}
      // Brief DOM stability pause — gives SPAs time to finish re-rendering
      // after the element appears. Without this, actions can fire while the
      // DOM is still mutating (e.g. text changing from "Loading..." to real
      // content), causing stale-element or wrong-value assertions.
      try { await locator.page().waitForTimeout(100); } catch {}
    }

    async function safeClick(page, text) {
      // Guard: undefined/null text would silently pass looksLikeSelector (returns false),
      // then every strategy gets getByRole('button', { name: undefined }) — matching
      // random elements instead of failing fast.
      if (text == null || typeof text !== 'string' || !text.trim()) {
        throw new Error('safeClick: text argument is required (got ' + typeof text + ')');
      }
      // When the text is a CSS/XPath selector, only use page.locator() —
      // text-based strategies (getByRole, getByText, aria-label) will never
      // match a selector string and just waste time + produce confusing errors.
      const strategies = looksLikeSelector(text)
        ? [p => p.locator(text)]
        : [
          p => p.getByRole('button', { name: text }),
          p => p.getByRole('link',   { name: text }),
          p => p.getByRole('menuitem', { name: text }),
          p => p.getByRole('tab',    { name: text }),
          p => p.getByRole('checkbox', { name: text }),
          p => p.getByRole('radio',    { name: text }),
          p => p.getByRole('switch',   { name: text }),
          p => p.getByRole('option',   { name: text }),
          p => p.getByText(text, { exact: true }),
          p => p.getByText(text),
          p => p.locator(\`[aria-label*="\${text}"]\`),
          p => p.locator(\`[title*="\${text}"]\`),
        ];

      const healingKey = 'click::' + text;

      await retry(async () => {
        // Re-resolve on every attempt so a DOM re-render (common in SPAs)
        // doesn't leave us retrying with a stale/detached locator reference.
        const el = await findElement(page, strategies, { healingKey });
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

    async function safeHover(page, text) {
      if (text == null || typeof text !== 'string' || !text.trim()) {
        throw new Error('safeHover: text argument is required (got ' + typeof text + ')');
      }
      const strategies = looksLikeSelector(text)
        ? [p => p.locator(text)]
        : [
          p => p.getByRole('button', { name: text }),
          p => p.getByRole('link',   { name: text }),
          p => p.getByRole('menuitem', { name: text }),
          p => p.getByRole('tab',    { name: text }),
          p => p.getByRole('img',    { name: text }),
          p => p.getByText(text, { exact: true }),
          p => p.getByText(text),
          p => p.locator(\`[aria-label*="\${text}"]\`),
          p => p.locator(\`[title*="\${text}"]\`),
        ];

      const healingKey = 'hover::' + text;

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey });
        await ensureReady(el);
        await el.hover({ timeout: DEFAULT_TIMEOUT });
      });

      // Brief pause after hover to let menus/tooltips render
      await sleep(300);
    }

    async function safeDblClick(page, text) {
      if (text == null || typeof text !== 'string' || !text.trim()) {
        throw new Error('safeDblClick: text argument is required (got ' + typeof text + ')');
      }
      const strategies = looksLikeSelector(text)
        ? [p => p.locator(text)]
        : [
          p => p.getByRole('button', { name: text }),
          p => p.getByRole('link',   { name: text }),
          p => p.getByRole('menuitem', { name: text }),
          p => p.getByRole('tab',    { name: text }),
          p => p.getByRole('checkbox', { name: text }),
          p => p.getByRole('radio',    { name: text }),
          p => p.getByRole('switch',   { name: text }),
          p => p.getByRole('option',   { name: text }),
          p => p.getByText(text, { exact: true }),
          p => p.getByText(text),
          p => p.locator(\`[aria-label*="\${text}"]\`),
          p => p.locator(\`[title*="\${text}"]\`),
        ];

      const healingKey = 'dblclick::' + text;

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey });
        await ensureReady(el);
        await el.dblclick({ timeout: DEFAULT_TIMEOUT });
      });

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
      // Guard: same rationale as safeClick — undefined label matches random elements.
      if (labelOrPlaceholder == null || typeof labelOrPlaceholder !== 'string' || !labelOrPlaceholder.trim()) {
        throw new Error('safeFill: labelOrPlaceholder argument is required (got ' + typeof labelOrPlaceholder + ')');
      }
      // Playwright's .fill() requires a string argument. AI-generated code
      // sometimes passes a number (e.g. safeFill(page, 'Age', 25)), which
      // causes a runtime TypeError. Coerce to string to be safe.
      const strValue = (value == null) ? '' : String(value);

      const strategies = looksLikeSelector(labelOrPlaceholder)
        ? [p => onlyFillable(p.locator(labelOrPlaceholder))]
        : [
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

      const healingKey = 'fill::' + labelOrPlaceholder;

      await retry(async () => {
        // Re-resolve on every attempt so a DOM re-render (common in SPAs)
        // doesn't leave us retrying with a stale/detached locator reference.
        const el = await findElement(page, strategies, { healingKey });
        await ensureReady(el);
        await el.fill('');
        await el.fill(strValue);
      });
    }

    async function safeSelect(page, labelOrText, value) {
      if (labelOrText == null || typeof labelOrText !== 'string' || !labelOrText.trim()) {
        throw new Error('safeSelect: labelOrText argument is required (got ' + typeof labelOrText + ')');
      }
      // Playwright's selectOption() accepts string, { label?, value?, index? },
      // or arrays for multi-select. Only coerce primitives (number/boolean) to
      // string — preserve objects and arrays so callers can use forms like
      // { label: 'United States' } or { index: 1 }.
      let selectValue;
      if (value == null) {
        selectValue = '';
      } else if (typeof value === 'object') {
        selectValue = value; // array or { label/value/index } — pass through
      } else {
        selectValue = String(value);
      }
      const strategies = looksLikeSelector(labelOrText)
        ? [p => p.locator(labelOrText)]
        : [
          p => p.getByLabel(labelOrText),
          p => p.getByRole('combobox', { name: labelOrText }),
          p => p.getByRole('listbox', { name: labelOrText }),
          p => p.locator(\`select[aria-label*="\${labelOrText}"]\`),
        ];

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'select::' + labelOrText });
        await ensureReady(el);
        await el.selectOption(selectValue);
      });
    }

    async function safeCheck(page, labelOrText) {
      if (labelOrText == null || typeof labelOrText !== 'string' || !labelOrText.trim()) {
        throw new Error('safeCheck: labelOrText argument is required (got ' + typeof labelOrText + ')');
      }
      const strategies = looksLikeSelector(labelOrText)
        ? [p => p.locator(labelOrText)]
        : [
          p => p.getByRole('checkbox', { name: labelOrText }),
          p => p.getByLabel(labelOrText),
          p => p.locator(\`[aria-label*="\${labelOrText}"]\`),
        ];

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'check::' + labelOrText });
        await ensureReady(el);
        await el.check();
      });
    }

    async function safeUncheck(page, labelOrText) {
      if (labelOrText == null || typeof labelOrText !== 'string' || !labelOrText.trim()) {
        throw new Error('safeUncheck: labelOrText argument is required (got ' + typeof labelOrText + ')');
      }
      const strategies = looksLikeSelector(labelOrText)
        ? [p => p.locator(labelOrText)]
        : [
          p => p.getByRole('checkbox', { name: labelOrText }),
          p => p.getByLabel(labelOrText),
          p => p.locator(\`[aria-label*="\${labelOrText}"]\`),
        ];

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'uncheck::' + labelOrText });
        await ensureReady(el);
        await el.uncheck();
      });
    }

    // safeExpect — self-healing visibility assertions
    //
    // Covers ALL common ARIA roles so the AI's role guess doesn't break the test.
    async function safeExpect(page, expect, text, role) {
      // Guard: same rationale as safeClick — undefined text matches random elements.
      if (text == null || typeof text !== 'string' || !text.trim()) {
        throw new Error('safeExpect: text argument is required (got ' + typeof text + ')');
      }
      // When the text is a CSS/XPath selector, only use page.locator() —
      // role/text/aria-label strategies will never match a raw selector string.
      const strategies = looksLikeSelector(text)
        ? [p => p.locator(text)]
        : [
          ...(role
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
              p => p.getByLabel(text),
              p => p.locator(\`[aria-label*="\${text}"]\`),
            ]),
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
// This is the server-side counterpart of the runtime `looksLikeSelector` injected
// by getSelfHealingHelperCode(). Both must agree on what constitutes a selector.
//
// Matches:
//   - Starts with #, ., [, //           (ID, class, attribute, XPath)
//   - CSS combinators (>, ~, +)          with selector-like context on both sides
//   - Attribute selectors (tag[attr])    e.g. input[name=q]
//   - Pseudo-selectors (:nth-child, …)  e.g. div:hover, a:nth-child(2)
//
// Does NOT match human-readable text like "Email:", "Price: $10", "Add + Continue".
function looksLikeCssSelector(arg) {
  if (!arg || typeof arg !== 'string') return false;
  const s = arg.trim();
  return /^[#.\[/]|^\/\//.test(s)
    || /(?:[\w\])])\s[>~+]\s(?:[\w#.\[:])/.test(s)
    || /\w\[[^\]]+\]/.test(s)
    || /:(?:nth-child|nth-of-type|first-child|last-child|has|is|not)\(/.test(s);
}

// Escape special characters in captured text so injecting into generated code
// strings is safe. Handles:
//   - backslashes  (must be first to avoid double-escaping)
//   - single quotes (the generated code uses '...' strings)
//   - backticks     (the runtime helpers use `...` template literals for
//                    aria-label/title selectors — an unescaped backtick would
//                    prematurely close the template)
//   - ${            (inside template literals, ${...} triggers interpolation;
//                    text like "Price: ${total}" would execute as code)
function esc(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/**
 * Rewrite raw Playwright code to use self-healing helpers (`safeClick`, `safeFill`, `safeExpect`).
 * Only transforms human-readable text selectors — CSS/XPath selectors are left untouched.
 *
 * @param {string} code - Raw Playwright test code.
 * @returns {string} Transformed code with self-healing helper calls.
 */
export function applyHealingTransforms(code) {
  // Guard: passing undefined/null crashes with "TypeError: undefined is not iterable"
  // at the first .replace() call. Return empty string instead of throwing so
  // callers that chain transforms don't need individual null checks.
  if (!code || typeof code !== "string") return code || "";
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
    // page.getByLabel(...).click() — label-based clicks on form elements
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`]\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    // page.getByPlaceholder(...).click() — clicking into inputs by placeholder
    .replace(
      /page\.getByPlaceholder\(['"`]([^'"`]+)['"`]\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    // page.getByTestId(...).click() — very common AI pattern
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    // page.getByAltText(...).click() — image clicks
    .replace(
      /page\.getByAltText\(['"`]([^'"`]+)['"`]\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    // ── Hover transforms → safeHover ────────────────────────────────────────
    .replace(
      /\bpage\.hover\(['"`]([^'"`]+)['"`]\)/g,
      (match, arg) => looksLikeCssSelector(arg) ? match : `safeHover(page, '${esc(arg)}')`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.hover\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeHover(page, '${esc(sel)}')`
    )
    .replace(
      /page\.getByText\(['"`]([^'"`]+)['"`]\)\.hover\(\)/g,
      (match, arg) => `safeHover(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.hover\(\)/g,
      (match, arg) => `safeHover(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.hover\(\)/g,
      (match, arg) => `safeHover(page, '${esc(arg)}')`
    )
    // ── Double-click transforms → safeDblClick ──────────────────────────────
    .replace(
      /\bpage\.dblclick\(['"`]([^'"`]+)['"`]\)/g,
      (match, arg) => looksLikeCssSelector(arg) ? match : `safeDblClick(page, '${esc(arg)}')`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.dblclick\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeDblClick(page, '${esc(sel)}')`
    )
    .replace(
      /page\.getByText\(['"`]([^'"`]+)['"`]\)\.dblclick\(\)/g,
      (match, arg) => `safeDblClick(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.dblclick\(\)/g,
      (match, arg) => `safeDblClick(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.dblclick\(\)/g,
      (match, arg) => `safeDblClick(page, '${esc(arg)}')`
    )
    // ── Fill transforms ─────────────────────────────────────────────────────
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
    // page.getByTestId(...).fill(val) — very common AI pattern
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.fill\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    // page.locator(...).fill(val) — e.g. page.locator('#email').fill('test@x.com')
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.fill\(([^)]+)\)/g,
      (match, sel, val) => looksLikeCssSelector(sel) ? match : `safeFill(page, '${esc(sel)}', ${val})`
    )
    .replace(
      /\bpage\.check\(['"`]([^'"`]+)['"`]\)/g,
      (match, arg) => looksLikeCssSelector(arg) ? match : `safeCheck(page, '${esc(arg)}')`
    )
    .replace(
      /\bpage\.uncheck\(['"`]([^'"`]+)['"`]\)/g,
      (match, arg) => looksLikeCssSelector(arg) ? match : `safeUncheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`]\)\.check\(\)/g,
      (match, arg) => `safeCheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.check\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeCheck(page, '${esc(sel)}')`
    )
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`]\)\.uncheck\(\)/g,
      (match, arg) => `safeUncheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.uncheck\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeUncheck(page, '${esc(sel)}')`
    )
    .replace(
      /\bpage\.selectOption\(['"`]([^'"`]+)['"`],\s*([^)]+)\)/g,
      (match, arg, val) => looksLikeCssSelector(arg) ? match : `safeSelect(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`]\)\.selectOption\(([^)]+)\)/g,
      (match, arg, val) => `safeSelect(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.selectOption\(([^)]+)\)/g,
      (match, sel, val) => looksLikeCssSelector(sel) ? match : `safeSelect(page, '${esc(sel)}', ${val})`
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
    )
    // expect(page.getByTestId(...)).toBeVisible() — very common AI pattern
    .replace(
      /(?:await\s+)?expect\(page\.getByTestId\(['"`]([^'"`]+)['"`]\)\)\.toBeVisible\(\)/g,
      (match, name) => `await safeExpect(page, expect, '${esc(name)}')`
    )
    // expect(page.getByAltText(...)).toBeVisible() — image visibility
    .replace(
      /(?:await\s+)?expect\(page\.getByAltText\(['"`]([^'"`]+)['"`]\)\)\.toBeVisible\(\)/g,
      (match, name) => `await safeExpect(page, expect, '${esc(name)}')`
    )
    // expect(page.locator(...)).toBeVisible() — leave CSS selectors alone
    .replace(
      /(?:await\s+)?expect\(page\.locator\(['"`]([^'"`]+)['"`]\)\)\.toBeVisible\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `await safeExpect(page, expect, '${esc(sel)}')`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Rules (unchanged but stricter tone)
// ─────────────────────────────────────────────────────────────────────────────
export const SELF_HEALING_PROMPT_RULES = `
STRICT RULE: Use ONLY self-healing helpers for ALL interactions AND visibility assertions.

INTERACTIONS — use these exclusively:
  ✓ await safeClick(page, text)            — for any click
  ✓ await safeDblClick(page, text)         — for any double-click
  ✓ await safeHover(page, text)            — for any hover (menus, tooltips)
  ✓ await safeFill(page, label, value)     — for any input fill
  ✓ await safeSelect(page, label, value)   — for any select/dropdown
  ✓ await safeCheck(page, label)           — for checkbox/radio checked state
  ✓ await safeUncheck(page, label)         — for checkbox/radio unchecked state

VISIBILITY ASSERTIONS — use safeExpect instead of raw locators:
  ✓ await safeExpect(page, expect, text)           — assert any element is visible
  ✓ await safeExpect(page, expect, text, 'button') — scoped to a role

COUNT / VALUE ASSERTIONS — use page.locator() scoped to a semantic selector:
  ✓ await expect(page.locator(...)).toHaveCount(5);
  ✓ await expect(page.locator(...)).toHaveValue('expected');
  ✓ await expect(page.locator(...)).not.toHaveCount(0);
    BAD:  const items = page.locator(...); await expect(items).toHaveCount(5);
    GOOD: await expect(page.locator(...)).toHaveCount(5);
  ✗ NEVER assert a hard-coded count on a generic container that may change (e.g. toHaveCount(5) on search results).
    Instead verify AT LEAST one result is visible: await expect(page.locator(...)).not.toHaveCount(0);

OTHER ASSERTIONS — these are fine as-is (do not wrap them):
  ✓ await expect(page).toHaveURL(...)
  ✓ await expect(page).toHaveTitle(...)
  ✓ await expect(locator).toContainText(...)
  ✓ await expect(locator).toHaveValue(...)
  ✓ await expect(locator).toBeEnabled()

FORBIDDEN — never use these (they bypass self-healing and will break on selector changes):

  Clicks (use safeClick instead):
  ✗ page.click(...)
  ✗ page.locator(...).click()
  ✗ page.getByRole(...).click()
  ✗ page.getByText(...).click()
  ✗ page.getByLabel(...).click()
  ✗ page.getByPlaceholder(...).click()
  ✗ page.getByTestId(...).click()
  ✗ page.getByAltText(...).click()
  ✗ page.tap(...)

  Fills / typing (use safeFill instead):
  ✗ page.fill(...)
  ✗ page.type(...)
  ✗ page.locator(...).fill(...)
  ✗ page.locator(...).type(...)
  ✗ page.getByLabel(...).fill(...)
  ✗ page.getByPlaceholder(...).fill(...)   ← already handled by safeFill
  ✗ page.getByTestId(...).fill(...)

  Form controls (use safeSelect/safeCheck/safeUncheck):
  ✗ page.check(...)
  ✗ page.uncheck(...)
  ✗ page.selectOption(...)
  ✗ page.locator(...).check()
  ✗ page.locator(...).uncheck()
  ✗ page.locator(...).selectOption(...)

  Double-clicks (use safeDblClick instead):
  ✗ page.dblclick(...)
  ✗ page.locator(...).dblclick()
  ✗ page.getByText(...).dblclick()
  ✗ page.getByRole(...).dblclick()
  ✗ page.getByTestId(...).dblclick()

  Hovers (use safeHover instead):
  ✗ page.hover(...)
  ✗ page.locator(...).hover()
  ✗ page.getByText(...).hover()
  ✗ page.getByRole(...).hover()
  ✗ page.getByTestId(...).hover()

  Other interactions (no self-healing equivalent — avoid if possible):
  ✗ page.press(...)                        ← use page.keyboard.press() only when absolutely needed
  ✗ page.focus(...)
  ✗ page.dragTo(...)
  ✗ page.setInputFiles(...)

  Visibility assertions (use safeExpect instead):
  ✗ expect(page.getByRole(...)).toBeVisible()
  ✗ expect(page.getByText(...)).toBeVisible()
  ✗ expect(page.getByLabel(...)).toBeVisible()
  ✗ expect(page.getByPlaceholder(...)).toBeVisible()
  ✗ expect(page.getByTestId(...)).toBeVisible()
  ✗ expect(page.getByAltText(...)).toBeVisible()
  ✗ expect(page.locator(...)).toBeVisible()  ← use safeExpect with the text/label instead

  Variable-based locator declarations (always inline inside expect()):
  ✗ const searchInput = page.locator(...);   ← declare AND use in one line, or use safeFill/safeClick
  ✗ const results = page.locator(...);  ← inline: expect(page.locator(...)).toHaveCount(N)
  ✗ const searchButton = page.locator(...);     ← use safeClick(page, text) instead
`.trim();

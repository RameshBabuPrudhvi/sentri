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
 * - {@link CORE_RULES} — Native Playwright rules for local models (~200 tokens).
 * - {@link SELF_HEALING_PROMPT_RULES} — Full self-healing helper rules for cloud models.
 * - {@link getPromptRules} — Tier-aware getter: returns CORE_RULES or full rules.
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
import { looksLikeCssSelector } from "./utils/selectorHeuristics.js";

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
    strategyVersion: STRATEGY_VERSION,
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
  // Ignore hints from a different strategy version — the strategyIndex
  // may point to a different strategy after strategies were reordered.
  if (entry?.strategyVersion != null && entry.strategyVersion !== STRATEGY_VERSION) return -1;
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
    // Skip hints from a different strategy version
    if (val.strategyVersion != null && val.strategyVersion !== STRATEGY_VERSION) continue;
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

// Strategy version — bump this whenever the strategy waterfall order changes
// (e.g. adding/removing/reordering strategies in safeClick, safeFill, etc.).
// Healing hints recorded with a different version are ignored so stale
// strategyIndex values don't point to the wrong strategy after an upgrade.
export const STRATEGY_VERSION = 3;

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

    // pierce: selector prefix — used for elements discovered inside shadow roots.
    // Playwright's CSS engine supports ">>" to pierce shadow DOM, and its built-in
    // "pierce/" prefix resolves through shadow boundaries. We normalise to the
    // Playwright css:pierce engine syntax here.
    function buildPierceLocator(page, selector) {
      // Strip our internal "pierce:" prefix if present before building the locator.
      const rawSelector = selector.startsWith('pierce:') ? selector.slice(7) : selector;
      // Playwright supports piercing shadow DOM via the css engine with the
      // ":shadow" pseudo or via ">> css=" chains. The most broadly compatible
      // approach is page.locator('css=selector') with Playwright's built-in
      // pierce support for shadow-including descendant combinators.
      return page.locator(\`css=\${rawSelector}\`);
    }

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
      // Fast path: check if any element is already visible without waiting.
      // This avoids the expensive waitFor timeout for strategies that clearly
      // don't match, reducing worst-case waterfall time significantly.
      const count = await baseLocator.count().catch(() => 0);
      if (count === 0) {
        // No elements at all — fail fast instead of waiting the full timeout.
        throw new Error('No elements matched this strategy');
      }
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

      // ── Scroll-retry: elements below the fold (e.g. footer links) ────────
      // Some elements exist in the DOM but are off-screen. isVisible() returns
      // false for them and waitFor({ state: 'visible' }) times out because
      // nobody scrolls to them. Before giving up, scroll to the bottom of the
      // page and retry the full waterfall once. This handles footer links,
      // lazy-loaded sections, and "load more" content on any website.
      try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500); // let lazy content render
        for (let i = 0; i < strategies.length; i++) {
          try {
            const locator = await tryStrategy(strategies[i], page, timeout);
            if (hintKey) {
              __healingEvents.push({ key: hintKey, strategyIndex: i, healed: true });
            }
            return locator;
          } catch (err) {
            lastError = err;
          }
        }
      } catch { /* scroll failed — page may be closed */ }

      // All strategies failed (even after scroll-retry)
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
          // pierce: strategy — finds elements inside shadow DOM roots that the
          // standard locators above cannot reach (Angular, Lit, Stencil, LWC).
          // Only attempt when text looks like a CSS selector; human-readable
          // text like "Sign in" produces invalid css= locators.
          ...(looksLikeSelector(text) ? [p => buildPierceLocator(p, text)] : []),
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
      if (typeof page?.waitForLoadState === 'function') {
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      }
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
          // pierce: strategy — reaches input elements inside shadow DOM roots.
          // Only attempt when text looks like a CSS selector.
          ...(looksLikeSelector(labelOrPlaceholder) ? [p => onlyFillable(buildPierceLocator(p, labelOrPlaceholder))] : []),
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

    function buildCheckboxStrategies(labelOrText) {
      if (looksLikeSelector(labelOrText)) {
        return [p => p.locator(labelOrText)];
      }
      return [
        p => p.getByRole('checkbox', { name: labelOrText }),
        p => p.getByLabel(labelOrText),
        p => p.locator(\`[aria-label*="\${labelOrText}"]\`),
        // List/row scoped fallbacks — common in TodoMVC, task trackers,
        // bug queues, settings lists. The checkbox sits inside the li/tr/
        // .item/.row and the readable label is a sibling of (not on) the
        // checkbox, so getByRole+name / getByLabel never match. Scope to
        // the container by hasText first, then pick the checkbox within.
        p => p.locator('li', { hasText: labelOrText }).getByRole('checkbox').first(),
        p => p.locator('tr', { hasText: labelOrText }).getByRole('checkbox').first(),
        p => p.locator('[role="listitem"]', { hasText: labelOrText }).getByRole('checkbox').first(),
        p => p.locator('[role="row"]', { hasText: labelOrText }).getByRole('checkbox').first(),
        p => p.locator('.item, .row, .todo, .task', { hasText: labelOrText }).getByRole('checkbox').first(),
        p => p.locator('li', { hasText: labelOrText }).locator('input[type="checkbox"]').first(),
        p => p.locator('tr', { hasText: labelOrText }).locator('input[type="checkbox"]').first(),
      ];
    }

    async function safeCheck(page, labelOrText) {
      if (labelOrText == null || typeof labelOrText !== 'string' || !labelOrText.trim()) {
        throw new Error('safeCheck: labelOrText argument is required (got ' + typeof labelOrText + ')');
      }
      const strategies = buildCheckboxStrategies(labelOrText);

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
      const strategies = buildCheckboxStrategies(labelOrText);

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'uncheck::' + labelOrText });
        await ensureReady(el);
        await el.uncheck();
      });
    }

    // ── safeDrag — drag and drop with self-healing source/target lookup ──────
    async function safeDrag(page, sourceText, targetText) {
      if (sourceText == null || typeof sourceText !== 'string' || !sourceText.trim()) {
        throw new Error('safeDrag: sourceText argument is required (got ' + typeof sourceText + ')');
      }
      if (targetText == null || typeof targetText !== 'string' || !targetText.trim()) {
        throw new Error('safeDrag: targetText argument is required (got ' + typeof targetText + ')');
      }
      const makeStrategies = (text) => looksLikeSelector(text)
        ? [p => p.locator(text)]
        : [
          p => p.getByText(text, { exact: true }),
          p => p.getByText(text),
          p => p.getByRole('listitem', { name: text }),
          p => p.getByRole('treeitem', { name: text }),
          p => p.locator(\`[aria-label*="\${text}"]\`),
          p => p.locator(\`[title*="\${text}"]\`),
        ];

      await retry(async () => {
        const src = await findElement(page, makeStrategies(sourceText), { healingKey: 'drag-src::' + sourceText });
        const tgt = await findElement(page, makeStrategies(targetText), { healingKey: 'drag-tgt::' + targetText });
        await ensureReady(src);
        await src.dragTo(tgt);
      });
    }

    // ── safeUpload — file upload with self-healing element lookup ────────────
    async function safeUpload(page, labelOrSelector, files) {
      if (labelOrSelector == null || typeof labelOrSelector !== 'string' || !labelOrSelector.trim()) {
        throw new Error('safeUpload: labelOrSelector argument is required (got ' + typeof labelOrSelector + ')');
      }
      const strategies = looksLikeSelector(labelOrSelector)
        ? [p => p.locator(labelOrSelector)]
        : [
          p => p.getByTestId(labelOrSelector),
          p => p.getByLabel(labelOrSelector),
          p => p.getByRole('button', { name: labelOrSelector }),
          p => p.getByText(labelOrSelector, { exact: true }),
          p => p.locator(\`input[type="file"][aria-label*="\${labelOrSelector}"]\`),
          p => p.locator('input[type="file"]'),
        ];

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'upload::' + labelOrSelector });
        await el.setInputFiles(files);
      });
    }

    // ── safeFocus — focus with self-healing element lookup ───────────────────
    async function safeFocus(page, labelOrText) {
      if (labelOrText == null || typeof labelOrText !== 'string' || !labelOrText.trim()) {
        throw new Error('safeFocus: labelOrText argument is required (got ' + typeof labelOrText + ')');
      }
      const strategies = looksLikeSelector(labelOrText)
        ? [p => p.locator(labelOrText)]
        : [
          p => onlyFillable(p.getByLabel(labelOrText)),
          p => p.getByPlaceholder(labelOrText),
          p => p.getByRole('textbox', { name: labelOrText }),
          p => p.getByRole('button', { name: labelOrText }),
          p => p.getByText(labelOrText, { exact: true }),
          p => p.locator(\`[aria-label*="\${labelOrText}"]\`),
        ];

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'focus::' + labelOrText });
        await ensureReady(el);
        await el.focus();
      });
    }

    // ── safeTap — touch tap with self-healing (mobile viewports) ────────────
    async function safeTap(page, text) {
      if (text == null || typeof text !== 'string' || !text.trim()) {
        throw new Error('safeTap: text argument is required (got ' + typeof text + ')');
      }
      const strategies = looksLikeSelector(text)
        ? [p => p.locator(text)]
        : [
          p => p.getByRole('button', { name: text }),
          p => p.getByRole('link',   { name: text }),
          p => p.getByText(text, { exact: true }),
          p => p.getByText(text),
          p => p.locator(\`[aria-label*="\${text}"]\`),
        ];

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'tap::' + text });
        await ensureReady(el);
        await el.tap();
      });
    }

    // ── safePress — keyboard press on a specific element ────────────────────
    async function safePress(page, labelOrSelector, key) {
      if (labelOrSelector == null || typeof labelOrSelector !== 'string' || !labelOrSelector.trim()) {
        throw new Error('safePress: labelOrSelector argument is required (got ' + typeof labelOrSelector + ')');
      }
      const strategies = looksLikeSelector(labelOrSelector)
        ? [p => p.locator(labelOrSelector)]
        : [
          p => onlyFillable(p.getByLabel(labelOrSelector)),
          p => p.getByPlaceholder(labelOrSelector),
          p => p.getByRole('textbox', { name: labelOrSelector }),
          p => p.getByRole('button', { name: labelOrSelector }),
          p => p.getByText(labelOrSelector, { exact: true }),
          p => p.locator(\`[aria-label*="\${labelOrSelector}"]\`),
        ];

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'press::' + labelOrSelector });
        await ensureReady(el);
        await el.press(key);
      });
    }

    // ── safeRightClick — context-menu click with self-healing ────────────────
    async function safeRightClick(page, text) {
      if (text == null || typeof text !== 'string' || !text.trim()) {
        throw new Error('safeRightClick: text argument is required (got ' + typeof text + ')');
      }
      const strategies = looksLikeSelector(text)
        ? [p => p.locator(text)]
        : [
          p => p.getByRole('button', { name: text }),
          p => p.getByRole('link',   { name: text }),
          p => p.getByRole('treeitem', { name: text }),
          p => p.getByRole('listitem', { name: text }),
          p => p.getByText(text, { exact: true }),
          p => p.getByText(text),
          p => p.locator(\`[aria-label*="\${text}"]\`),
        ];

      await retry(async () => {
        const el = await findElement(page, strategies, { healingKey: 'rightclick::' + text });
        await ensureReady(el);
        await el.click({ button: 'right', timeout: DEFAULT_TIMEOUT });
      });
    }

    // ── safeSelectFrame — switch into an iframe with self-healing ────────────
    function safeSelectFrame(page, selectorOrName) {
      if (selectorOrName == null || typeof selectorOrName !== 'string' || !selectorOrName.trim()) {
        throw new Error('safeSelectFrame: selectorOrName argument is required');
      }
      // Returns a FrameLocator — callers chain further locator calls on it.
      // Try the raw selector first, then fall back to name/title attributes.
      if (looksLikeSelector(selectorOrName)) {
        return page.frameLocator(selectorOrName);
      }
      // Attempt by title, name, or aria-label
      return page.frameLocator(\`iframe[title*="\${selectorOrName}"], iframe[name*="\${selectorOrName}"], iframe[aria-label*="\${selectorOrName}"]\`);
    }

    // ── safeExpect — self-healing visibility assertions
    //
    // Covers ALL common ARIA roles so the AI's role guess doesn't break the test.
    async function safeExpect(page, expect, text, role) {
      // Guard: same rationale as safeClick — undefined text matches random elements.
      // If the AI passed a Playwright Locator object instead of a string (common
      // Ollama mistake), fall back to asserting visibility on it directly rather
      // than crashing with a confusing error.
      if (text != null && typeof text === 'object') {
        // Looks like a Locator — has waitFor and isVisible methods
        if (typeof text.waitFor === 'function') {
          await text.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT }).catch(() => {});
          await expect(text).toBeVisible();
          return;
        }
      }
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
              // pierce: strategy — asserts visibility of elements inside shadow roots.
              // Only attempt when text looks like a CSS selector.
              ...(looksLikeSelector(text) ? [p => buildPierceLocator(p, text)] : []),
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
    // ── Type transforms → safeFill (page.type is deprecated but AI emits it) ─
    .replace(
      /\bpage\.type\(['"`]([^'"`]+)['"`],\s*([^)]+)\)/g,
      (match, arg, val) => looksLikeCssSelector(arg) ? match : `safeFill(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.type\(([^)]+)\)/g,
      (match, sel, val) => looksLikeCssSelector(sel) ? match : `safeFill(page, '${esc(sel)}', ${val})`
    )
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`]\)\.type\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByPlaceholder\(['"`]([^'"`]+)['"`]\)\.type\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.type\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.type\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    // ── Missing check/uncheck/selectOption locator variants ──────────────────
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.check\(\)/g,
      (match, arg) => `safeCheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.uncheck\(\)/g,
      (match, arg) => `safeUncheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.selectOption\(([^)]+)\)/g,
      (match, arg, val) => `safeSelect(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.check\(\)/g,
      (match, arg) => `safeCheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.uncheck\(\)/g,
      (match, arg) => `safeUncheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.selectOption\(([^)]+)\)/g,
      (match, arg, val) => `safeSelect(page, '${esc(arg)}', ${val})`
    )
    .replace(
      /page\.getByPlaceholder\(['"`]([^'"`]+)['"`]\)\.check\(\)/g,
      (match, arg) => `safeCheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByPlaceholder\(['"`]([^'"`]+)['"`]\)\.uncheck\(\)/g,
      (match, arg) => `safeUncheck(page, '${esc(arg)}')`
    )
    .replace(
      /page\.getByPlaceholder\(['"`]([^'"`]+)['"`]\)\.selectOption\(([^)]+)\)/g,
      (match, arg, val) => `safeSelect(page, '${esc(arg)}', ${val})`
    )
    // ── Tap transforms → safeTap ────────────────────────────────────────────
    .replace(
      /\bpage\.tap\(['"`]([^'"`]+)['"`]\)/g,
      (match, arg) => looksLikeCssSelector(arg) ? match : `safeTap(page, '${esc(arg)}')`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.tap\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeTap(page, '${esc(sel)}')`
    )
    // ── Focus transforms → safeFocus ────────────────────────────────────────
    .replace(
      /\bpage\.focus\(['"`]([^'"`]+)['"`]\)/g,
      (match, arg) => looksLikeCssSelector(arg) ? match : `safeFocus(page, '${esc(arg)}')`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.focus\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeFocus(page, '${esc(sel)}')`
    )
    // ── DragTo transforms → safeDrag ────────────────────────────────────────
    .replace(
      /\bpage\.dragAndDrop\(['"`]([^'"`]+)['"`],\s*['"`]([^'"`]+)['"`]\)/g,
      (match, src, tgt) => `safeDrag(page, '${esc(src)}', '${esc(tgt)}')`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.dragTo\(page\.locator\(['"`]([^'"`]+)['"`]\)\)/g,
      (match, src, tgt) => looksLikeCssSelector(src) || looksLikeCssSelector(tgt) ? match : `safeDrag(page, '${esc(src)}', '${esc(tgt)}')`
    )
    .replace(
      /page\.getByText\(['"`]([^'"`]+)['"`](?:,\s*\{[^}]*\})?\)\.dragTo\(page\.getByText\(['"`]([^'"`]+)['"`](?:,\s*\{[^}]*\})?\)\)/g,
      (match, src, tgt) => `safeDrag(page, '${esc(src)}', '${esc(tgt)}')`
    )
    // ── File upload transforms → safeUpload ─────────────────────────────────
    .replace(
      /\bpage\.setInputFiles\(['"`]([^'"`]+)['"`],\s*([^)]+)\)/g,
      (match, target, files) => looksLikeCssSelector(target) ? match : `safeUpload(page, '${esc(target)}', ${files})`
    )
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.setInputFiles\(([^)]+)\)/g,
      (match, target, files) => looksLikeCssSelector(target) ? match : `safeUpload(page, '${esc(target)}', ${files})`
    )
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`]\)\.setInputFiles\(([^)]+)\)/g,
      (match, target, files) => `safeUpload(page, '${esc(target)}', ${files})`
    )
    .replace(
      /page\.getByTestId\(['"`]([^'"`]+)['"`]\)\.setInputFiles\(([^)]+)\)/g,
      (match, target, files) => `safeUpload(page, '${esc(target)}', ${files})`
    )
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.setInputFiles\(([^)]+)\)/g,
      (match, target, files) => `safeUpload(page, '${esc(target)}', ${files})`
    )
    .replace(
      /frame\.locator\(['"`]([^'"`]+)['"`]\)\.setInputFiles\(([^)]+)\)/g,
      (match, target, files) => looksLikeCssSelector(target) ? match : `safeUpload(frame, '${esc(target)}', ${files})`
    )
    // ── Press transforms → safePress ────────────────────────────────────────
    .replace(
      /\bpage\.press\(['"`]([^'"`]+)['"`],\s*['"`]([^'"`]+)['"`]\)/g,
      (match, sel, key) => looksLikeCssSelector(sel) ? match : `safePress(page, '${esc(sel)}', '${esc(key)}')`
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
    )
    // ── Additional transforms for patterns Ollama frequently produces ────────
    // NOTE: expect(page.getByRole('role')).toBeVisible() without { name } is
    // valid Playwright — left as-is (no transform needed).

    // page.getByLabel(...).fill(val) with options object — e.g. { exact: true }
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`],\s*\{[^}]*\}\)\.fill\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    // page.getByLabel(...).click() with options — e.g. { exact: true }
    .replace(
      /page\.getByLabel\(['"`]([^'"`]+)['"`],\s*\{[^}]*\}\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    // page.getByText(...).click() with options — e.g. { exact: true }
    .replace(
      /page\.getByText\(['"`]([^'"`]+)['"`],\s*\{[^}]*\}\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    // page.getByText(...).fill(val) — Ollama sometimes chains fill on getByText
    .replace(
      /page\.getByText\(['"`]([^'"`]+)['"`](?:,\s*\{[^}]*\})?\)\.fill\(([^)]+)\)/g,
      (match, arg, val) => `safeFill(page, '${esc(arg)}', ${val})`
    )
    // page.locator(...).first().click() — Ollama often adds .first()
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.first\(\)\.click\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeClick(page, '${esc(sel)}')`
    )
    // page.locator(...).nth(N).click() — Ollama sometimes adds .nth()
    .replace(
      /page\.locator\(['"`]([^'"`]+)['"`]\)\.nth\(\d+\)\.click\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `safeClick(page, '${esc(sel)}')`
    )
    // page.getByRole(...).first().click() — chain with .first()
    .replace(
      /page\.getByRole\(['"`][^'"`]+['"`],\s*\{\s*name:\s*['"`]([^'"`]+)['"`]\s*\}\)\.first\(\)\.click\(\)/g,
      (match, arg) => `safeClick(page, '${esc(arg)}')`
    )
    // NOTE: expect(page.getByText('...', { exact: true })).toBeVisible() is already
    // handled by the getByText assertion transform above (line 1123) which uses
    // (?:,\s*\{[^}]*\})? to optionally match the options object.

    // expect(page.locator(...).first()).toBeVisible() — locator with .first()
    .replace(
      /(?:await\s+)?expect\(page\.locator\(['"`]([^'"`]+)['"`]\)\.first\(\)\)\.toBeVisible\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `await safeExpect(page, expect, '${esc(sel)}')`
    )
    // expect(page.locator(...).nth(N)).toBeVisible() — locator with .nth()
    .replace(
      /(?:await\s+)?expect\(page\.locator\(['"`]([^'"`]+)['"`]\)\.nth\(\d+\)\)\.toBeVisible\(\)/g,
      (match, sel) => looksLikeCssSelector(sel) ? match : `await safeExpect(page, expect, '${esc(sel)}')`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Rules — tiered for cloud vs local models (MNT-009)
// ─────────────────────────────────────────────────────────────────────────────
// CORE_RULES   (~200 tokens) — native Playwright instructions for local models.
//              Local models write standard Playwright code; the transform engine
//              (applyHealingTransforms) rewrites it to self-healing helpers at runtime.
// SELF_HEALING_PROMPT_RULES — full exhaustive self-healing helper rules for cloud models.
// ─────────────────────────────────────────────────────────────────────────────

export const CORE_RULES = `
Write standard Playwright code. The runtime automatically adds self-healing.

INTERACTIONS — use standard Playwright methods:
  await page.getByRole('button', { name: 'Submit' }).click()
  await page.getByLabel('Email').fill('user@test.com')
  await page.getByRole('combobox', { name: 'Country' }).selectOption('US')
  await page.getByRole('checkbox', { name: 'Agree' }).check()
  await page.getByText('Sign in').click()
  await page.keyboard.press('Enter')

ASSERTIONS — inline semantic locators inside expect():
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('Welcome')).toBeVisible()
  await expect(page.locator('.results')).toHaveCount(3)
  await expect(page.getByText('search term')).toBeVisible()
  await expect(page).toHaveURL(/hostname/i)  — hostname-only regex, never exact URL

RULES:
  ✓ Prefer getByRole, getByLabel, getByText, getByPlaceholder over CSS
  ✓ Inline locators inside expect() — never assign to a variable
  ✓ Use { waitUntil: 'domcontentloaded' } after page.goto
  ✗ NEVER use page.click('sel') or page.fill('sel', val) — use locator chains
  ✗ NEVER use expect(page.locator('css')).toBeVisible()/.toContainText() —
       use getByText/getByRole for visibility/text
  ✗ NEVER hard-code dynamic values (dates, IDs, counts) — use regex patterns`.trim();

// Full self-healing helper rules for cloud models.
export const SELF_HEALING_PROMPT_RULES = `
STRICT RULE: Use ONLY self-healing helpers for ALL interactions AND visibility assertions.

INTERACTIONS — use these exclusively:
  ✓ await safeClick(page, text)            — for any click
  ✓ await safeDblClick(page, text)         — for any double-click
  ✓ await safeHover(page, text)            — for any hover (menus, tooltips)
  ✓ await safeFill(page, label, value)     — for any input fill (also replaces page.type)
  ✓ await safeSelect(page, label, value)   — for any select/dropdown
  ✓ await safeCheck(page, label)           — for checkbox/radio checked state
  ✓ await safeUncheck(page, label)         — for checkbox/radio unchecked state
  ✓ await safeDrag(page, sourceText, targetText) — for drag-and-drop
  ✓ await safeUpload(page, label, filePaths)     — for file upload (accepts string or string[])
  ✓ await safeFocus(page, label)           — for focusing an element
  ✓ await safeTap(page, text)              — for touch tap (mobile viewports)
  ✓ await safePress(page, label, key)      — for pressing a key on a focused element
  ✓ await safeRightClick(page, text)       — for context-menu / right-click

IFRAME / FRAME — use safeSelectFrame to get a FrameLocator, then chain helpers:
  ✓ const frame = safeSelectFrame(page, 'Payment')  — returns a FrameLocator
    Then use frame.locator(...) or frame.getByRole(...) inside the iframe.

DIALOGS (window.alert / confirm / prompt):
  Dialogs are auto-accepted by the runtime. If you need to dismiss instead:
  ✓ page.on('dialog', d => d.dismiss())    — register BEFORE the action that triggers it

NEW TABS / POPUPS:
  ✓ const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      safeClick(page, 'Open in new tab'),
    ]);
    await newPage.waitForLoadState('domcontentloaded');
    // ... interact with newPage ...
    await newPage.close();

DOWNLOADS:
  ✓ const [download] = await Promise.all([
      page.waitForEvent('download'),
      safeClick(page, 'Download PDF'),
    ]);
    const path = await download.path();

KEYBOARD (global, not element-scoped):
  ✓ await page.keyboard.press('Enter')     — for global key presses (Escape, Tab, etc.)
  ✓ await page.keyboard.type('search term') — for typing without a specific element

MOUSE (coordinate-based — use only when no element label exists):
  ✓ await page.mouse.click(x, y)
  ✓ await page.mouse.move(x, y)
  ✓ await page.mouse.wheel(0, 500)         — for scrolling

VISIBILITY ASSERTIONS — use safeExpect (NOT raw page.locator):
  ✓ await safeExpect(page, expect, text)           — assert any element is visible
  ✓ await safeExpect(page, expect, text, 'button') — scoped to a role
  ✗ await expect(page.locator('.class')).toBeVisible()  — rejected by the validator
  ✗ await expect(page.locator('#id')).toContainText('X') — rejected; use safeExpect(page, expect, 'X')
  ✗ await expect(page.locator('.x')).toHaveText('X')     — rejected; use safeExpect(page, expect, 'X')

COUNT / VALUE / STATE / ATTRIBUTE ASSERTIONS — page.locator() IS allowed:
  ✓ await expect(page.locator(...)).toHaveCount(5);
  ✓ await expect(page.locator(...)).toHaveValue('expected');
  ✓ await expect(page.locator(...)).not.toHaveCount(0);
  ✓ await expect(page.locator(...)).toBeHidden();             — scoped with a semantic selector
  ✓ await expect(page.locator(...)).toHaveAttribute('href', /expected/);
  ✓ await expect(page.locator(...)).toHaveClass(/active/);
  ✓ await expect(page.locator(...)).toHaveCSS('color', 'rgb(0, 0, 0)');
    BAD:  const items = page.locator(...); await expect(items).toHaveCount(5);
    GOOD: await expect(page.locator(...)).toHaveCount(5);
  ✗ NEVER assert a hard-coded count on a generic container that may change (e.g. toHaveCount(5) on search results).
    Instead verify AT LEAST one result is visible: await expect(page.locator(...)).not.toHaveCount(0);

OTHER ASSERTIONS — these are fine as-is (do not wrap them):
  ✓ await expect(page).toHaveURL(...)
  ✓ await expect(page).toHaveTitle(...)
  ✓ await expect(locator).toHaveValue(...)
  ✓ await expect(locator).toBeEnabled()
  ✓ await expect(locator).toBeDisabled()
  ✓ await expect(locator).toBeChecked()

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

  Taps (use safeTap instead):
  ✗ page.tap(...)
  ✗ page.locator(...).tap()

  Fills / typing (use safeFill instead):
  ✗ page.fill(...)
  ✗ page.type(...)
  ✗ page.locator(...).fill(...)
  ✗ page.locator(...).type(...)
  ✗ page.getByLabel(...).fill(...)
  ✗ page.getByLabel(...).type(...)
  ✗ page.getByPlaceholder(...).fill(...)
  ✗ page.getByPlaceholder(...).type(...)
  ✗ page.getByTestId(...).fill(...)
  ✗ page.getByTestId(...).type(...)
  ✗ page.getByRole(...).fill(...)
  ✗ page.getByRole(...).type(...)

  Form controls (use safeSelect/safeCheck/safeUncheck):
  ✗ page.check(...)
  ✗ page.uncheck(...)
  ✗ page.selectOption(...)
  ✗ page.locator(...).check()
  ✗ page.locator(...).uncheck()
  ✗ page.locator(...).selectOption(...)
  ✗ page.getByRole(...).check()
  ✗ page.getByRole(...).uncheck()
  ✗ page.getByRole(...).selectOption(...)
  ✗ page.getByLabel(...).selectOption(...)
  ✗ page.getByTestId(...).check()
  ✗ page.getByTestId(...).uncheck()
  ✗ page.getByTestId(...).selectOption(...)
  ✗ page.getByPlaceholder(...).check()
  ✗ page.getByPlaceholder(...).uncheck()
  ✗ page.getByPlaceholder(...).selectOption(...)

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

  Drag-and-drop (use safeDrag instead):
  ✗ page.dragAndDrop(...)
  ✗ locator.dragTo(...)

  File upload (use safeUpload instead):
  ✗ page.setInputFiles(...)
  ✗ locator.setInputFiles(...)

  Focus (use safeFocus instead):
  ✗ page.focus(...)
  ✗ locator.focus()

  Press on selector (use safePress instead):
  ✗ page.press(selector, key)              ← use safePress(page, label, key)

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
  ✗ const results = page.locator(...);       ← inline: expect(page.locator(...)).toHaveCount(N)
  ✗ const searchButton = page.locator(...);  ← use safeClick(page, text) instead
`.trim();

/**
 * Return the appropriate prompt rules for the given tier.
 *
 * - `"cloud"` — full exhaustive rules (`SELF_HEALING_PROMPT_RULES`)
 * - `"local"` — compact core rules only (`CORE_RULES`)
 *
 * @param {"cloud"|"local"} tier - The prompt tier.
 * @returns {string} Prompt rules string.
 */
export function getPromptRules(tier) {
  return tier === "local" ? CORE_RULES : SELF_HEALING_PROMPT_RULES;
}

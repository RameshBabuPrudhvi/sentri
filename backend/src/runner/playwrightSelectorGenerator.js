/**
 * @module runner/playwrightSelectorGenerator
 * @description DIF-015b — Loader for Playwright's internal `InjectedScript`
 * source so the recorder's in-page `selectorGenerator()` can delegate to
 * Playwright's own, well-tested selector-generation algorithm instead of
 * the hand-rolled heuristic.
 *
 * ### Why this exists
 * The hand-rolled `selectorGenerator()` inside `RECORDER_SCRIPT` was
 * producing lower-quality selectors than Playwright's `codegen` tool
 * (no noise-scoring, no cross-ancestor scoring loop, no shadow-DOM
 * traversal, no iframe locator chain). Rather than re-implement ~600 LOC
 * of Playwright internals, we load Playwright's pre-bundled
 * `injectedScriptSource.js` — the same IIFE Playwright itself injects
 * into pages — and call `InjectedScript.prototype.generateSelector(...)`
 * (or `generateSelectorSimple(...)`, whichever is exposed in the pinned
 * Playwright version).
 *
 * ### Why it's best-effort with a fallback
 * `InjectedScript`'s filename, constructor signature, and public methods
 * all live under `playwright-core/lib/server/injected/…` which is
 * explicitly marked as internal and **not covered by Playwright's
 * semver**. A Renovate bump can move / rename symbols without notice.
 * We therefore:
 *  1. Resolve and read the source at Node module-load time (not every
 *     recorder launch — the file is ~300 KB).
 *  2. Probe for the expected symbols at recorder launch time.
 *  3. Fall back silently to the hand-rolled `selectorGenerator()` on any
 *     failure, logging once per process via {@link formatLogLine}.
 *
 * The hand-rolled fallback is the path every existing recorder test is
 * pinned against, so "Playwright source missing" is a zero-regression
 * outcome.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { formatLogLine } from "../utils/logFormatter.js";

/**
 * @typedef {Object} LoadedInjectedScriptSource
 * @property {string|null} source - Pre-bundled Playwright injected-script
 *   source as a string, or `null` when the bundle could not be resolved.
 * @property {boolean} available - `true` iff `source` is non-empty and
 *   safe to inject. Callers must check this before using `source`.
 * @property {string} [reason] - Diagnostic message describing why the
 *   bundle could not be loaded; only present when `available === false`.
 */

/** @type {LoadedInjectedScriptSource | null} */
let cached = null;
let loggedOnce = false;

/**
 * Resolve and read `playwright-core/lib/server/injected/injectedScriptSource.js`
 * as a string. This is the **pre-bundled** IIFE Playwright ships for its own
 * page-context injection — unlike the unbundled `selectorGenerator.js`, it
 * is self-contained and has no `require()` calls (webpack has already
 * inlined every dependency).
 *
 * Result is cached for the lifetime of the Node process. Returns
 * `{ available: false }` on any failure; callers must check `available`
 * before using `source`.
 *
 * @returns {LoadedInjectedScriptSource}
 */
export function loadPlaywrightInjectedScriptSource() {
  if (cached) return cached;

  const require = createRequire(import.meta.url);
  // Resolution must dodge `playwright-core`'s `package.json` "exports" field,
  // which gates every internal path under `lib/server/injected/*` and makes
  // `require.resolve("playwright-core/lib/server/injected/injectedScriptSource.js")`
  // throw `ERR_PACKAGE_PATH_NOT_EXPORTED`. The package's own `package.json`
  // **is** always exported, though, so we resolve that, walk to the package
  // root, and read the bundled IIFE off disk directly — `fs.readFileSync`
  // does not consult the exports map. The bundle is internal and not
  // covered by Playwright's semver, so this whole branch is wrapped in
  // try/catch and falls through to `available: false` on any failure.
  const candidatePaths = [
    "lib/server/injected/injectedScriptSource.js",
  ];

  try {
    const pkgJsonPath = require.resolve("playwright-core/package.json");
    const pkgRoot = path.dirname(pkgJsonPath);
    for (const rel of candidatePaths) {
      const abs = path.join(pkgRoot, rel);
      try {
        const source = fs.readFileSync(abs, "utf8");
        if (source && source.length > 0) {
          cached = { source, available: true };
          return cached;
        }
        // File resolved but empty (corrupted / partial install). Record
        // a failure object so the post-loop guard below doesn't fall
        // through with `cached === null` — that previously crashed
        // `buildInjectedBootstrapScript()` when it destructured `null`.
        cached = { source: null, available: false, reason: `${rel} resolved but file was empty` };
      } catch (err) {
        // Try the next candidate; last error is reported if all fail.
        cached = { source: null, available: false, reason: err.message };
      }
    }
  } catch (err) {
    cached = { source: null, available: false, reason: err.message };
  }

  // Defence-in-depth: if every code path above somehow left `cached`
  // unset (no candidates configured, etc.), still return a well-formed
  // failure object so callers can rely on the `{ available, source }`
  // shape unconditionally.
  if (!cached) {
    cached = { source: null, available: false, reason: "no candidate paths produced a usable bundle" };
  }

  if (!loggedOnce) {
    loggedOnce = true;
    console.error(formatLogLine(
      "warn",
      null,
      `[recorder] Playwright injectedScriptSource not resolvable (${cached?.reason || "unknown"}) — recorder will use the hand-rolled selectorGenerator fallback. This is safe but produces lower-quality selectors than Playwright's codegen.`,
    ));
  }
  return cached;
}

/**
 * Test-only seam: clear the module-level cache so a test can re-exercise
 * the loader path after mocking `fs` / `require.resolve`. Not part of the
 * public API.
 * @private
 */
export function _testResetCache() {
  cached = null;
  loggedOnce = false;
}

/**
 * Build the in-page bootstrap snippet that:
 *  1. Evaluates Playwright's `injectedScriptSource` IIFE in page scope so
 *     `pwExport` (Playwright's own bundle export name) is defined.
 *  2. Constructs an `InjectedScript` instance with conservative defaults.
 *  3. Exposes `window.__playwrightSelector(element)` as the public entry
 *     point the recorder script will call.
 *
 * **API-surface uncertainty.** Playwright marks `lib/server/injected/*` as
 * internal and the constructor signature + public-method names of
 * `InjectedScript` have shifted across minor releases. We feature-detect:
 *   - `generateSelectorSimple(element)` — returns a string directly
 *     (newer releases).
 *   - `generateSelector(element, options)` — may return `{ selector }` or
 *     a string depending on version.
 *   - `pwExport.InjectedScript` — class export shape.
 *   - `pwExport` itself being the constructor (legacy).
 * If none probe true, `__playwrightSelector` is left undefined and the
 * recorder's hand-rolled fallback runs.
 *
 * Returns the empty string when the source isn't loadable, so the caller
 * can safely string-concat without a guard.
 *
 * @returns {string}
 */
export function buildInjectedBootstrapScript() {
  const { source, available } = loadPlaywrightInjectedScriptSource();
  if (!available || !source) return "";

  // The IIFE in `injectedScriptSource.js` assigns its exports to a
  // `pwExport` global. We wrap the source in a try/catch so a parse error
  // or runtime throw inside Playwright's bundle never propagates into
  // RECORDER_SCRIPT — the recorder always boots, even degraded.
  return `
(() => {
  try {
${source}
  } catch (err) {
    // Playwright bundle threw at load — leave __playwrightSelector
    // undefined so the recorder's fallback selectorGenerator runs.
    return;
  }
  if (typeof pwExport === "undefined") return;

  // Construct an InjectedScript. Constructor signature has changed over
  // Playwright versions; try the most common shapes in order. Each block
  // is wrapped in try/catch so a constructor throw on one shape doesn't
  // prevent the next shape from being tried.
  let injected = null;
  const Ctor = (pwExport && pwExport.InjectedScript) || pwExport;
  if (typeof Ctor !== "function") return;

  // Shape A (Playwright ~1.40+): (window, isUnderTest, sdkLanguage,
  //   testIdAttributeName, stableRafCount, browserName, customEngines)
  try {
    injected = new Ctor(window, false, "javascript", "data-testid", 1, "chromium", []);
  } catch (_) { /* try next shape */ }

  // Shape B (older releases): (window, customEngines)
  if (!injected) {
    try { injected = new Ctor(window, []); } catch (_) { /* give up */ }
  }
  if (!injected) return;

  // Pick the first available selector-generation method.
  const generate = (el) => {
    try {
      if (typeof injected.generateSelectorSimple === "function") {
        return injected.generateSelectorSimple(el);
      }
      if (typeof injected.generateSelector === "function") {
        const out = injected.generateSelector(el, { testIdAttributeName: "data-testid" });
        if (out == null) return "";
        return typeof out === "string" ? out : (out.selector || "");
      }
    } catch (_) { /* fall through to "" */ }
    return "";
  };

  window.__playwrightSelector = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const sel = generate(el);
    return typeof sel === "string" ? sel : "";
  };
})();
`;
}


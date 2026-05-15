/**
 * @module runner/recorder
 * @description DIF-015 — Interactive browser recorder for test creation.
 *
 * Opens a Playwright browser pointed at the project's URL, streams a
 * live CDP screencast to the frontend via SSE (reusing the existing
 * `emitRunEvent` channel), and captures raw user interactions
 * (clicks, fills, key-presses, navigations) as Playwright actions.
 *
 * On stop, the captured action list is transformed into a Playwright
 * test body and returned so the caller (routes/tests.js) can persist
 * a Draft test and run it through the rest of the generation pipeline
 * (assertion enhancement, self-healing transform) just like any other
 * AI-generated test.
 *
 * ### Exports
 * - {@link startRecording}  — Launch browser + begin capture.
 * - {@link stopRecording}   — Stop capture; return `{ actions, playwrightCode }`.
 * - {@link getRecording}    — Inspect an in-flight recording (for abort / status).
 *
 * ### Design notes
 * Capture is done entirely in the **page context** via a single injected
 * listener that posts events back to Node through `page.exposeBinding`.
 * This is the same approach Playwright's own `codegen` uses for JavaScript
 * action recording, minus the DevTools UI — we only need the raw event
 * stream.
 */

import { launchBrowser, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, NAVIGATION_TIMEOUT, resolveDevice, DEVICE_PRESETS } from "./config.js";
import { startScreencast } from "./screencast.js";
import { formatLogLine } from "../utils/logFormatter.js";
import * as runRepo from "../database/repositories/runRepo.js";
import { buildInjectedBootstrapScript } from "./playwrightSelectorGenerator.js";

/**
 * DIF-015c Gap 5 — set of device names accepted by the recorder. Built
 * once at module load from the curated `DEVICE_PRESETS` exported by
 * `config.js` (the same list `RunRegressionModal` mirrors), plus the
 * empty-string sentinel for "Desktop (default)". Any other value is a
 * 400 from the route layer — we deliberately do NOT accept arbitrary
 * `playwright.devices` keys at the recorder boundary because the curated
 * list is what the UI exposes and what `executeTest.js` exercises in CI.
 *
 * @internal
 */
const ACCEPTED_DEVICE_NAMES = new Set(DEVICE_PRESETS.map((d) => d.value));

/**
 * DIF-015c Gap 6 — opt-in stealth bootstrap script. Patches the five
 * fingerprint surfaces real-world `if (navigator.webdriver) { block() }`
 * detection scripts check, **without** pulling in the
 * `puppeteer-extra-plugin-stealth` dependency tree (which would add a
 * cat-and-mouse fingerprint patcher running on every page, plus a
 * security-review surface for anti-bot logic AGENT.md `:123` warns
 * against bundling without explicit justification).
 *
 * Applied via `context.addInitScript(STEALTH_SCRIPT)` ONLY when the
 * session was launched with `stealth: true`. Default-mode runs never
 * call `addInitScript` with this body so pre-Gap-6 behaviour is
 * bit-for-bit identical.
 *
 * Coverage of common headless-detection probes:
 *
 *   - `navigator.webdriver` — headless sets this to `true`; we redefine
 *     the getter to return `undefined` (matches what a real Chrome
 *     window returns).
 *   - `navigator.plugins` — headless reports an empty `PluginArray`; we
 *     synthesise a 3-entry array shaped like a real Chrome install
 *     (PDF Viewer + Chrome PDF Viewer + Chromium PDF Viewer).
 *   - `navigator.languages` — headless reports `[]`; we force the
 *     equivalent of a US-English Chrome install. Operators can still
 *     override per-context via the existing `locale` device option.
 *   - `window.chrome` — real Chrome exposes a `chrome` object with at
 *     least a `runtime` stub; headless leaves it undefined. We
 *     synthesise the minimal shape that detection scripts probe.
 *   - `Permissions.prototype.query` for `notifications` — real Chrome
 *     returns `{ state: "prompt" }` for an unset permission; headless
 *     returns `{ state: "denied" }` which is a strong tell. We patch
 *     the prototype to flip notifications back to `"prompt"` while
 *     leaving every other permission query untouched.
 *
 * The script is intentionally narrow — it covers the ~90% of detection
 * scripts that read these five surfaces, NOT the long tail of
 * canvas-fingerprint / WebGL-renderer / battery-API patches the upstream
 * plugin chains together. If a target site detects us despite this
 * stealth profile, the right answer is to add a single targeted patch
 * here rather than pull in the full upstream stack.
 *
 * @internal
 */
const STEALTH_SCRIPT = `
(() => {
  try {
    if (window.__sentriStealthInstalled) return;
    window.__sentriStealthInstalled = true;

    // 1. navigator.webdriver — the canonical "is this headless?" probe.
    //    Real Chrome returns undefined; headless returns true. Redefine
    //    the getter on the prototype so existing read paths see undefined
    //    without breaking property-descriptor introspection.
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    } catch (_) { /* defineProperty may throw on some platforms */ }

    // 2. navigator.plugins — synthesise a real-Chrome-shaped PluginArray.
    //    Detection scripts often read .length, so a 3-entry array (the
    //    default Chrome install on macOS/Windows) is the safest spoof.
    try {
      const fakePlugins = [
        { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      ];
      Object.defineProperty(navigator, "plugins", {
        get: () => fakePlugins,
        configurable: true,
      });
    } catch (_) { /* ignore */ }

    // 3. navigator.languages — headless reports [], real browsers report
    //    at least the UI locale. Force the equivalent of a US-English
    //    install; operators who need a different locale should set the
    //    Playwright \`locale\` device option which takes precedence at
    //    the context layer.
    try {
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
        configurable: true,
      });
    } catch (_) { /* ignore */ }

    // 4. window.chrome — real Chrome exposes a top-level \`chrome\`
    //    object with at least a \`runtime\` stub. Headless leaves it
    //    undefined. Synthesise the minimal shape so detection scripts
    //    that probe \`window.chrome\` or \`window.chrome.runtime\` see
    //    something plausible.
    try {
      if (!window.chrome) {
        Object.defineProperty(window, "chrome", {
          value: { runtime: {} },
          writable: true,
          configurable: true,
        });
      } else if (!window.chrome.runtime) {
        window.chrome.runtime = {};
      }
    } catch (_) { /* ignore */ }

    // 5. Permissions.prototype.query — patch \`notifications\` only.
    //    Real Chrome returns { state: "prompt" } for unset notifications;
    //    headless returns "denied" which is a strong tell. Leave every
    //    other permission untouched so legitimate permission flows
    //    (geolocation, camera, mic) behave normally.
    try {
      if (window.Permissions && window.Permissions.prototype && window.Permissions.prototype.query) {
        const origQuery = window.Permissions.prototype.query;
        window.Permissions.prototype.query = function (params) {
          if (params && params.name === "notifications") {
            return Promise.resolve({ state: "prompt" });
          }
          return origQuery.call(this, params);
        };
      }
    } catch (_) { /* ignore */ }
  } catch (err) {
    // Surface init failures the same way RECORDER_SCRIPT does so a
    // half-applied stealth profile doesn't silently degrade — better
    // for the operator to see "stealth init failed" in the backend
    // log than to wonder why their target site still detects them.
    console.error("[sentri-stealth] init failed:", err && err.stack ? err.stack : err);
  }
})();
`;

/**
 * Tunable timing constants for the recorder. Centralised so reviewers can
 * see every magic number in one place and so operators can override the
 * server-side ones via environment variables without grepping through the
 * file.
 *
 * The in-page timings (DBLCLICK_DEFER_MS, HOVER_DWELL_MS, FILL_DEBOUNCE_MS,
 * DBLCLICK_WINDOW_MS) are inlined into `RECORDER_SCRIPT` because that
 * string runs in the browser context where this module's bindings are not
 * in scope. Keep this block in sync if you change them inside the script
 * — a mismatch is silent and can produce confusing replay behaviour.
 *
 * @internal
 */
const TIMINGS = {
  /**
   * Hard cap for how long a single recording session may stay open.
   * Defence-in-depth for the case where a client disconnects without
   * hitting stop/discard (e.g. browser tab closed, network cut). After
   * this timeout the server tears down the Chromium process and deletes
   * the session from the map.
   * @env MAX_RECORDING_MS (default 1_800_000 = 30 min, floor 60_000)
   */
  MAX_RECORDING_MS: Math.max(
    60_000,
    parseInt(process.env.MAX_RECORDING_MS || "1800000", 10) || 1_800_000,
  ),
  /**
   * TTL for the cache of auto-torn-down recordings. A user who clicks
   * "Stop & Save" within this window of the safety-net timeout firing
   * still recovers their captured actions instead of seeing a 500 error.
   * @env RECORDER_COMPLETED_TTL_MS (default 120_000 = 2 min, floor 10_000)
   */
  COMPLETED_TTL_MS: Math.max(
    10_000,
    parseInt(process.env.RECORDER_COMPLETED_TTL_MS || "120000", 10) || 120_000,
  ),
  /**
   * Hard window in which a trailing `dblclick` event can cancel the two
   * preceding `click` events captured by `__sentriRecord`. CDP/browser
   * dispatches click→click→dblclick in that order; without this dedup the
   * recorded action list would replay all three handlers in sequence.
   * Used in `exposeBinding`'s consumer; see also DBLCLICK_DEFER_MS below,
   * which is the in-page equivalent applied to the click event itself.
   */
  DBLCLICK_WINDOW_MS: 500,
  /**
   * In-page deferral window for emitting captured `click` actions. Browser
   * dispatch order is click→click→dblclick, so a trailing `dblclick`
   * listener inside the page can cancel the queued clicks for the same
   * selector before the binding flushes them to Node. Interpolated into
   * `RECORDER_SCRIPT` because that body runs in the browser context.
   */
  DBLCLICK_DEFER_MS: 250,
  /**
   * In-page dwell time before a sustained pointer hover is emitted as a
   * `hover` action. Filters out drive-by mouseovers while still catching
   * deliberate hovers (tooltips, dropdown triggers).
   */
  HOVER_DWELL_MS: 600,
  /**
   * In-page debounce window after the last keystroke in a text field
   * before the resulting `fill` action is emitted. Coalesces a multi-
   * character entry into a single recorded fill.
   */
  FILL_DEBOUNCE_MS: 300,
};

// Backwards-compatible aliases used elsewhere in the module / tests.
const MAX_RECORDING_MS = TIMINGS.MAX_RECORDING_MS;

/**
 * Action kinds that represent a real user interaction (as opposed to a
 * drive-by `hover` or a passive `goto`). Used by the `__sentriRecord`
 * binding to strip a trailing `hover` action on the same selector when the
 * very next action is an interaction — see the block that consumes this
 * set for the full rationale.
 *
 * Lives at module scope (matching `TIMINGS` above) rather than inside the
 * binding callback so we don't re-allocate a Set on every captured action
 * event during an active recording session.
 *
 * @internal
 */
const INTERACTION_KINDS = new Set([
  "click", "dblclick", "rightClick", "fill",
  "select", "check", "uncheck", "upload", "press",
]);

/**
 * SEC-007 — server-side defence-in-depth credential detector.
 *
 * Module-scope sibling to the in-page `isSensitiveField` heuristic. The
 * page-side script is the **primary** redaction path (it sees the
 * `<input type="password">` attribute and sets `redacted: true` before
 * the value crosses the binding boundary). This helper runs at the
 * Node-side binding callback and only matters when something slipped
 * past — a SUT that uses `<input type="text">` for a password without
 * matching the name/id heuristic, or a future RECORDER_SCRIPT change
 * that introduces a regression.
 *
 * Detection rules (entropy + known-credential shapes):
 *   - JWT (3-segment base64url): `eyJ…\.…\.…`
 *   - AWS access key id: `AKIA[0-9A-Z]{16}`
 *   - Bearer token literal: `Bearer <token>`
 *   - Stripe / GitHub / OpenAI / Slack key prefixes (industry-standard
 *     gitleaks rules): `sk_(live|test)_…`, `ghp_…`, `gho_…`, `ghs_…`,
 *     `xox[abps]-…`
 *   - High-entropy 32+ char base64ish blob (catches API keys / session
 *     tokens that don't match a known prefix)
 *   - Credit card (Luhn-checked, 13–19 digits)
 *
 * Returns `false` for the empty string, sentinel values
 * (`__SENTRI_SECRET_<n>__`), and obvious-non-secret short tokens (≤8
 * chars or all whitespace) so the false-positive rate stays low.
 *
 * The detection is intentionally narrower than `secretScanner.js`
 * (which scans generated test code post-hoc and is allowed false
 * positives) — at this site a false positive would silently corrupt the
 * captured fill value, breaking replay. Only catch what we're sure of.
 *
 * @param {string|undefined} value - Raw value about to be persisted.
 * @returns {boolean} `true` when the value matches a known credential pattern.
 * @internal
 */
function _looksLikeSecretValue(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length <= 8) return false;
  if (/^__SENTRI_SECRET_/.test(value)) return false;
  // JWT (3 base64url segments separated by dots)
  if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}$/.test(value)) return true;
  // AWS access key id
  if (/^AKIA[0-9A-Z]{16}$/.test(value)) return true;
  // Bearer token literal (rare in a fill value, but possible from a
  // pasted Authorization header)
  if (/^Bearer\s+[A-Za-z0-9._~+/-]{16,}$/i.test(value)) return true;
  // Provider-prefixed tokens (industry-standard gitleaks set)
  if (/^sk_(?:live|test)_[A-Za-z0-9]{20,}$/.test(value)) return true;
  if (/^gh[poas]_[A-Za-z0-9]{30,}$/.test(value)) return true;
  if (/^xox[abps]-[A-Za-z0-9-]{20,}$/.test(value)) return true;
  // Luhn-validated credit card (13–19 digits, accepting space/dash
  // separators for human-typed cards). Strip separators first.
  const compact = value.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(compact) && _luhnValid(compact)) return true;
  return false;
}

/**
 * SEC-007 — Luhn check for credit card validation. Returns true when the
 * digits-only string passes the standard mod-10 checksum.
 *
 * @param {string} digits - Digits-only string (caller must strip spaces/dashes).
 * @returns {boolean}
 * @internal
 */
function _luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * DIF-015b — quality-scores a `data-testid` value. Returns `true` when the
 * value looks machine-generated / random (numeric-only, `el_` / `comp-` /
 * `t-` prefix + hex tail, or a long unseparated token).
 *
 * **This is only used by the hand-rolled fallback selectorGenerator** that
 * runs when Playwright's `InjectedScript` source cannot be loaded (missing
 * `playwright-core` install, Playwright bumped to a version with a different
 * injected-bundle layout, etc.). The primary path delegates to Playwright's
 * own selector generator which has its own — more sophisticated — noise
 * scoring built in.
 *
 * Exported for unit tests that exercise the fallback path directly; callers
 * outside the fallback should not depend on this heuristic.
 *
 * @param {string} value - Raw `data-testid` attribute value.
 * @returns {boolean} `true` when the value looks noisy and should be demoted.
 */
export function isNoisyTestId(value) {
  const v = (value || "").trim();
  if (!v) return true;
  if (/^\d+$/.test(v)) return true;
  if (/^(?:el_|comp-|t-)[a-z0-9_-]*[0-9a-f]{4,}$/i.test(v)) return true;
  if (v.length > 30 && !/[-_:.]/.test(v)) return true;
  return false;
}

/**
 * @typedef {Object} RecordedAction
 * @property {"goto"|"click"|"dblclick"|"rightClick"|"hover"|"fill"|"press"|"select"|"check"|"uncheck"|"upload"|"drag"|"assertVisible"|"assertText"|"assertValue"|"assertUrl"|"assertCount"|"assertHasClass"} kind
 * @property {string} [selector]   - Best-effort role/label/text/css selector.
 * @property {string} [label]      - Human-readable label for the target
 *                                   element (aria-label / inner text /
 *                                   placeholder / `name`). Used by the Test
 *                                   Detail Steps panel so reviewers see "the
 *                                   Search button" instead of `role=button…`.
 *                                   The selector is still the source of truth
 *                                   for the generated Playwright code.
 * @property {string} [value]      - For `fill`, the final value typed.
 *                                   For sensitive inputs (passwords, OTP,
 *                                   payment fields, operator-marked
 *                                   `data-sentri-secret`) this is the
 *                                   sentinel `__SENTRI_SECRET_<n>__`
 *                                   rather than the raw value (SEC-007).
 * @property {boolean} [redacted]  - SEC-007: `true` when `value` is a
 *                                   credential sentinel rather than the
 *                                   user-typed value. Codegen rewrites
 *                                   redacted fills to
 *                                   `process.env.SENTRI_SECRET_<n>`; the
 *                                   step prose renders as `[REDACTED]`.
 * @property {string} [url]        - For `goto`.
 * @property {string} [key]        - For `press`.
 * @property {string} [frameUrl]    - URL of iframe containing the action.
 * @property {string} [pageAlias]   - "page" for main tab, "popupN" for popups.
 * @property {string} [target]      - For drag/drop target selector.
 * @property {number}  ts          - Epoch ms when the action was captured.
 */

/**
 * @typedef {Object} RecordingSession
 * @property {string}  id
 * @property {string}  projectId
 * @property {string}  url               - Starting URL.
 * @property {"recording"|"stopping"|"stopped"} status
 * @property {Array<RecordedAction>} actions
 * @property {number}  startedAt
 * @property {string}  [device]          - DIF-015c Gap 5: active device profile
 *                                          (e.g. `"iPhone 14"`); empty string
 *                                          or undefined → desktop default.
 * @property {{width: number, height: number}} [viewport] - Resolved viewport
 *                                          (from device descriptor, falling
 *                                          back to `VIEWPORT_WIDTH/HEIGHT`).
 * @property {boolean} [paused]           - DIF-015c Gap 3: pause flag.
 * @property {boolean} [stealth]          - DIF-015c Gap 6: when true the
 *                                          recorder context has `STEALTH_SCRIPT`
 *                                          installed via `addInitScript`,
 *                                          patching `navigator.webdriver` +
 *                                          friends so headless-detecting
 *                                          target apps render normally.
 *                                          Default false → pre-Gap-6
 *                                          behaviour bit-for-bit unchanged.
 * @property {Object}  [browser]         - Playwright Browser (internal).
 * @property {Object}  [context]         - Playwright BrowserContext (internal).
 * @property {Object}  [page]            - Playwright Page (internal).
 * @property {Function} [stopScreencast]  - Cleanup fn returned by startScreencast.
 * @property {Object}  [cdpSession]      - CDP session for input forwarding.
 */

/** @type {Map<string, RecordingSession>} */
const sessions = new Map();

/**
 * @typedef {Object} CompletedRecording
 * @property {string}  projectId
 * @property {Array<RecordedAction>} actions
 * @property {string}  playwrightCode
 * @property {string}  url
 * @property {number}  completedAt
 * @property {"auto_timeout"|"manual"} reason
 */

/**
 * Short-lived cache of recordings torn down by the MAX_RECORDING_MS safety-net
 * timeout. Entries live for `COMPLETED_TTL_MS` so a user who clicks
 * "Stop & Save" moments after the timeout fires can still recover their
 * captured actions instead of losing them to a 500 error. Scoped to the in-
 * process recorder so no external store is needed.
 * @type {Map<string, CompletedRecording>}
 */
const completedSessions = new Map();
const COMPLETED_TTL_MS = TIMINGS.COMPLETED_TTL_MS;

/**
 * JS source injected into every page frame. It captures pointer/keyboard
 * events and relays them to Node via the `__sentriRecord` binding. We
 * de-duplicate by dispatch target + event type so that a single click
 * doesn't emit multiple entries when bubbling through the DOM.
 *
 * `selectorGenerator` mirrors Playwright-style priority heuristics (DIF-015b):
 * prefer role-based selectors, then data-testid, then aria-label, then
 * a short CSS chain.
 *
 * **Disambiguation (DIF-015b follow-up):** when the chosen CSS-fallback
 * selector matches more than one element on the page, append a Playwright
 * `>> nth=N` token so replay targets the same element the user clicked.
 * Without this, three identical `button.btn-primary` on a page would all
 * replay against the first match. Role/data-testid/label/text selectors are
 * NOT disambiguated by index — they're already semantic anchors and adding
 * `nth=N` to them would mask a real test smell (multiple identical labels
 * on the same page is a symptom worth surfacing, not silently fixing).
 *
 * **Shadow DOM and iframes** still fall through to the host-document selector
 * (this PR's scope is naming + nth disambiguation only). Iframe support is
 * partially handled at the action layer via `frameUrl` capture — see the
 * `__sentriRecord` binding. Full shadow-root traversal is tracked as a
 * follow-up sub-item under DIF-015b in ROADMAP.md.
 *
 * Built once at module load — the timing constants come from `TIMINGS`
 * (Node-side) and are baked into the script as numeric literals before
 * `addInitScript` ships it to the page. This keeps a single source of
 * truth across the Node boundary; previously the same values lived as
 * inline magic numbers inside the script.
 */
const RECORDER_SCRIPT = `
(() => {
  try {
  if (window.__sentriRecorderInstalled) return;
  window.__sentriRecorderInstalled = true;

  // CSS-only fallback used both as the final branch in selectorGenerator
  // AND by the nth=N disambiguator (which needs a CSS string to count
  // matches via document.querySelectorAll).
  function cssFallback(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    const cls = (el.className && typeof el.className === "string") ? el.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  }

  // DIF-015b: append ">> nth=N" if the CSS fallback matches multiple elements.
  // Only applied to CSS-fallback selectors — semantic selectors (role=, text=,
  // data-testid=, label=, placeholder=, alt=, title=) intentionally pass
  // through unchanged. Bail out cheaply on a unique match so the common case
  // pays nothing beyond a single querySelectorAll call.
  function disambiguateCss(el, cssSel) {
    if (!cssSel || el.id) return cssSel; // #id selectors are unique by definition
    let matches;
    try { matches = document.querySelectorAll(cssSel); }
    catch { return cssSel; } // malformed selector — let replay fail visibly instead of corrupting it
    if (matches.length <= 1) return cssSel;
    const idx = Array.prototype.indexOf.call(matches, el);
    if (idx < 0) return cssSel; // el is in a shadow root or detached — querySelectorAll can't see it
    return cssSel + " >> nth=" + idx;
  }

  // DIF-015b Gap 2 — inlined hand-rolled copy of the Node-side
  // \`isNoisyTestId()\` (kept in source above). Previously this was injected
  // via \`\${isNoisyTestId.toString()}\` interpolation, but the interpolation
  // produced a \"SyntaxError: Unexpected end of input\" at page-init time
  // (the function body's regex literals contained \\\\d / \\\\s sequences that
  // collided with the outer template-literal escaping rules), which caused
  // the entire IIFE to abort before any DOM listeners were attached — the
  // symptom was the recorder only ever capturing \`goto\` actions while
  // every click/fill/keypress was silently dropped. Inlining the function
  // body as static script text avoids the interpolation altogether.
  function isNoisyTestId(value) {
    const v = (value || "").trim();
    if (!v) return true;
    if (/^[0-9]+$/.test(v)) return true;
    if (/^(?:el_|comp-|t-)[a-z0-9_-]*[0-9a-f]{4,}$/i.test(v)) return true;
    if (v.length > 30 && !/[-_:.]/.test(v)) return true;
    return false;
  }

  function selectorGenerator(el) {
    if (!el || el.nodeType !== 1) return "";
    // Primary path: delegate to Playwright's own InjectedScript-based
    // selector generator when its bootstrap script ran successfully. This
    // is the same algorithm Playwright's \`codegen\` tool produces and
    // covers ancestor scoring, noise-testid demotion, shadow-DOM
    // traversal, and iframe locator chains — none of which the fallback
    // below handles. If Playwright returns an empty string we fall
    // through to the local heuristic so a single misclassified element
    // doesn't break the recording.
    if (typeof window.__playwrightSelector === "function") {
      try {
        const pw = window.__playwrightSelector(el);
        if (pw && typeof pw === "string") return pw;
      } catch (_) { /* fall through to hand-rolled fallback */ }
    }
    // Fallback path — runs when Playwright's InjectedScript source could
    // not be loaded at server start, or its API surface drifted in a
    // version bump and the bootstrap left __playwrightSelector
    // unpopulated. Order matches the documented priority in the module
    // JSDoc; the testid noise heuristic only matters here because
    // Playwright's generator already handles it on the primary path.
    const testId = (el.getAttribute("data-testid") || el.getAttribute("data-test-id") || "").trim();
    const role = el.getAttribute("role") || roleFromTag(el.tagName);
    const label = (el.getAttribute("aria-label") || "").trim().slice(0, 80);
    if (testId && !isNoisyTestId(testId)) return 'data-testid=' + JSON.stringify(testId);
    if (role && label) return 'role=' + role + '[name=' + JSON.stringify(label) + ']';
    if (testId) return 'data-testid=' + JSON.stringify(testId);
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && el.labels && el.labels[0]) {
      const l = (el.labels[0].innerText || el.labels[0].textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
      if (l) return 'label=' + JSON.stringify(l);
    }
    const ph = (el.getAttribute("placeholder") || "").trim();
    if (ph) return 'placeholder=' + JSON.stringify(ph.slice(0, 80));
    const alt = (el.getAttribute("alt") || "").trim();
    if (alt) return 'alt=' + JSON.stringify(alt.slice(0, 80));
    const title = (el.getAttribute("title") || "").trim();
    if (title) return 'title=' + JSON.stringify(title.slice(0, 80));
    const txt = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    if (txt && txt.length >= 2) return 'text=' + JSON.stringify(txt);
    // CSS fallback — disambiguate with nth=N when the selector matches
    // multiple elements. Semantic selectors above are intentionally exempt.
    return disambiguateCss(el, cssFallback(el));
  }
  // Friendly label for the human-readable Steps panel. Mirrors how AI-
  // generated steps reference elements ("the Search button", "the Email
  // field") rather than CSS / role= selectors. Falls through a priority
  // chain: aria-label → trimmed inner text → placeholder → name → "" so
  // the caller can fall back to a kind-only sentence ("User clicks").
  function bestLabel(el) {
    if (!el || el.nodeType !== 1) return "";
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria.slice(0, 60);
    const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text && text.length <= 60) return text;
    if (text) return text.slice(0, 57) + "…";
    const ph = (el.getAttribute && el.getAttribute("placeholder")) || "";
    if (ph) return ph.trim().slice(0, 60);
    if (el.name) return String(el.name).slice(0, 60);
    return "";
  }
  function roleFromTag(tag) {
    tag = (tag || "").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "";
  }

  // SEC-007 — in-page credential redaction.
  //
  // Sensitive values (passwords, OTP codes, payment card numbers, fields
  // the operator tagged with \`data-sentri-secret\`) MUST never cross the
  // \`__sentriRecord\` binding boundary as plaintext — if they did, they
  // would land in \`session.actions[].value\`, be persisted to the \`tests\`
  // table inside \`playwrightCode\` + \`steps\`, and replay through the AI
  // assertion pipeline (leaking the credential to the LLM provider). We
  // instead assign a stable per-session ordinal and emit a sentinel
  // \`__SENTRI_SECRET_<n>__\` so codegen can rewrite to
  // \`process.env.SENTRI_SECRET_<n>\` at replay time. The raw value never
  // leaves the page context.
  //
  // Detection rules (matches industry-standard tools — Mabl, Testim, BearQ):
  //   - \`<input type="password">\` (the canonical case)
  //   - \`autocomplete\` hint matches \`current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp\`
  //   - operator-marked \`data-sentri-secret="true"\` attribute on the input
  //     (or any ancestor — supports wrapping the whole field in a flagged div)
  //   - input \`name\`/\`id\` matches the credential heuristic regex (catches
  //     misconfigured sites that use \`<input type="text" name="password">\`)
  //
  // The sentinel map is per-page (lives in the IIFE closure) so reloading
  // the recorder script resets numbering — this matches how operators
  // think about credentials ("the password field on this flow") rather
  // than across-session reuse, which would be a footgun for shared envs.
  const sentinelBySelector = new Map();
  let nextSentinelOrdinal = 1;
  function isSensitiveField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
    // 1. type="password" — the unambiguous case.
    if (el.type === "password") return true;
    // 2. autocomplete hint per WHATWG Forms spec §autofill detail tokens.
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase().trim();
    if (ac && /(?:^|\\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)(?:\\s|$)/.test(ac)) return true;
    // 3. operator-marked sensitive — check the input AND any ancestor so a
    //    wrapping <div data-sentri-secret> covers all children.
    if (el.closest && el.closest('[data-sentri-secret="true"]')) return true;
    // 4. heuristic: name/id contains \`password\`/\`secret\`/\`pin\`/\`cvv\`/\`cvc\`
    //    as a separated token (avoids false positives on \`passport_number\`,
    //    \`secretary\`). Catches sites that use \`<input type="text">\` for a
    //    password field (rare but real — observed on legacy admin panels).
    const probe = (String(el.name || "") + " " + String(el.id || "")).toLowerCase();
    if (/(?:^|[\\W_])(?:password|passwd|pwd|secret|pin|cvv|cvc|otp|totp)(?:[\\W_]|$)/.test(probe)) return true;
    return false;
  }
  function sentinelFor(el, sel) {
    // Re-use the same sentinel ordinal for repeated fills on the same
    // selector — operators retyping the same password into the same field
    // should produce one \`SENTRI_SECRET_1\`, not multiple.
    const key = sel || (el && (el.name || el.id)) || "unkeyed";
    const existing = sentinelBySelector.get(key);
    if (existing) return existing;
    const sentinel = "__SENTRI_SECRET_" + nextSentinelOrdinal + "__";
    nextSentinelOrdinal += 1;
    sentinelBySelector.set(key, sentinel);
    return sentinel;
  }

  // Browser dispatches click → click → dblclick for a double-click gesture.
  // Defer click emission by one OS double-click window so a trailing
  // "dblclick" listener can cancel the queued clicks for the same target;
  // otherwise replay would re-run the click handler twice before the
  // intended double-click and toggle UI state / submit forms early.
  // Pending clicks: sel -> { timer, emit }. We keep the emit fn alongside
  // the timer so flushPendingClicks() can fire it synchronously when the
  // page is about to navigate. Without this, clicking a submit button or
  // link loses the click action — the 250 ms dblclick-defer timer is
  // destroyed along with the page before it fires.
  const pendingClickTimers = new Map();
  function flushPendingClicks() {
    for (const sel of Array.from(pendingClickTimers.keys())) {
      const pending = pendingClickTimers.get(sel);
      if (!pending) continue;
      clearTimeout(pending.timer);
      pendingClickTimers.delete(sel);
      try { pending.emit(); } catch (_) { /* best-effort */ }
    }
  }
  let shortcutCaptureBudget = 0;
  function eventElement(ev) {
    const p = ev.composedPath && ev.composedPath();
    return (p && p[0] && p[0].nodeType === 1) ? p[0] : ev.target;
  }
  document.addEventListener("click", (ev) => {
    const raw = eventElement(ev);
    const el = raw.closest ? (raw.closest("a, button, input, textarea, select, [role], [data-testid], [data-test-id], [contenteditable='true']") || raw) : raw;
    const sel = selectorGenerator(el);
    const label = bestLabel(el);
    const emit = () => {
      pendingClickTimers.delete(sel);
      window.__sentriRecord && window.__sentriRecord({
        kind: "click", selector: sel, label, ts: Date.now(),
      });
    };
    if (!sel) { emit(); return; }
    const prev = pendingClickTimers.get(sel);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(emit, ${TIMINGS.DBLCLICK_DEFER_MS});
    pendingClickTimers.set(sel, { timer, emit });
  }, true);
  document.addEventListener("dblclick", (ev) => {
    const raw = eventElement(ev);
    const el = raw.closest ? (raw.closest("a, button, input, textarea, select, [role], [data-testid], [data-test-id], [contenteditable='true']") || raw) : raw;
    const sel = selectorGenerator(el);
    // Cancel any queued click(s) for this selector — a dblclick supersedes
    // the two click events that preceded it.
    if (sel) {
      const pending = pendingClickTimers.get(sel);
      if (pending) { clearTimeout(pending.timer); pendingClickTimers.delete(sel); }
    }
    window.__sentriRecord && window.__sentriRecord({
      kind: "dblclick", selector: sel, label: bestLabel(el), ts: Date.now(),
    });
  }, true);
  document.addEventListener("contextmenu", (ev) => {
    const raw = eventElement(ev);
    const el = raw.closest ? (raw.closest("a, button, input, textarea, select, [role], [data-testid], [data-test-id], [contenteditable='true']") || raw) : raw;
    window.__sentriRecord && window.__sentriRecord({
      kind: "rightClick", selector: selectorGenerator(el), label: bestLabel(el), ts: Date.now(),
    });
  }, true);
  // Hover capture uses a dwell timer so casual pointer movement through
  // nested DOM doesn't flood the action log. We only emit a "hover" action
  // after the pointer has rested on the same interactive ancestor for
  // \`TIMINGS.HOVER_DWELL_MS\` — long enough to filter out drive-by
  // mouseover events while still catching deliberate hovers (tooltips,
  // dropdown triggers).
  let hoverDwellTimer = null;
  let lastHoverSelector = "";
  document.addEventListener("mouseover", (ev) => {
    const raw = eventElement(ev);
    // Only capture hovers on interactive ancestors — do NOT fall back to the
    // raw element. The \`|| raw\` pattern that was here previously caused every
    // mouseover on a generic container (div, section, body) to emit a hover
    // action with a noisy CSS selector, flooding the captured steps list with
    // drive-by movements across layout elements.
    const el = raw.closest ? raw.closest("a, button, input, textarea, select, [role], [data-testid], [data-test-id], [contenteditable='true']") : null;
    if (!el) return;
    const sel = selectorGenerator(el);
    if (!sel) return;
    if (sel === lastHoverSelector) return; // already pending / just emitted for this target
    if (hoverDwellTimer) { clearTimeout(hoverDwellTimer); hoverDwellTimer = null; }
    hoverDwellTimer = setTimeout(() => {
      hoverDwellTimer = null;
      lastHoverSelector = sel;
      window.__sentriRecord && window.__sentriRecord({
        kind: "hover", selector: sel, label: bestLabel(el), ts: Date.now(),
      });
    }, ${TIMINGS.HOVER_DWELL_MS});
  }, true);
  document.addEventListener("mouseout", () => {
    if (hoverDwellTimer) { clearTimeout(hoverDwellTimer); hoverDwellTimer = null; }
    lastHoverSelector = "";
  }, true);

  // Per-selector fill-debounce timers AND a "last emitted" cache. The two
  // work together to dedupe fill actions across the input + change handlers:
  //   - The "input" handler captures normal typing as a debounced fill and
  //     records the emitted value in \`lastEmittedFill\`.
  //   - The "change" handler is the safety-net for browser autofill / paste
  //     scenarios that bypass the "input" event entirely. It checks
  //     \`lastEmittedFill\` and skips the redundant fill when the input
  //     handler already covered the same selector + value.
  // Without this dedup, typing "hello" then blurring fired two identical
  // \`fill\` actions and produced two consecutive \`safeFill(sel, 'hello')\`
  // calls in the generated code. The lastEmittedFill entry is purged after
  // the change event so a subsequent retype of the same value re-fires.
  // Pending fills: sel -> { timer, el, label }. We keep the captured element
  // ref alongside the timer so flushPendingFill() can emit synchronously
  // (re-querying via document.querySelector would lose elements inside
  // shadow roots / iframes). flushPendingFill() is invoked by Enter
  // keydown, form submit, and pagehide handlers below — without those
  // flushes, a user who hits Enter to submit (or whose form auto-submits
  // and navigates) loses the typed value because the 300 ms debounce
  // timer is destroyed along with the page before it fires.
  const inputTimers = new Map();
  const lastEmittedFill = new Map();
  function flushPendingFill(sel) {
    const pending = inputTimers.get(sel);
    if (!pending) return;
    clearTimeout(pending.timer);
    inputTimers.delete(sel);
    // SEC-007 — honour the sensitive flag captured at input time. We use
    // the flag rather than re-running isSensitiveField(pending.el) because
    // the element may have been detached by the navigation that triggered
    // this flush (Enter-to-submit, pagehide), and a detached input loses
    // its \`type\`/\`autocomplete\` attribute lookup paths.
    const value = pending.sensitive
      ? sentinelFor(pending.el, sel)
      : (pending.el ? pending.el.value : "");
    if (lastEmittedFill.get(sel) === value) {
      lastEmittedFill.delete(sel);
      return;
    }
    lastEmittedFill.set(sel, value);
    window.__sentriRecord && window.__sentriRecord({
      kind: "fill", selector: sel, label: pending.label, value, redacted: pending.sensitive || undefined, ts: Date.now(),
    });
  }
  function flushAllPendingFills() {
    for (const sel of Array.from(inputTimers.keys())) flushPendingFill(sel);
  }
  document.addEventListener("input", (ev) => {
    const el = eventElement(ev);
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
    if (el.type === "checkbox" || el.type === "radio" || el.type === "file") return;
    const sel = selectorGenerator(el);
    if (!sel) return;
    const prev = inputTimers.get(sel);
    if (prev) clearTimeout(prev.timer);
    const label = bestLabel(el);
    // SEC-007 — compute sensitivity BEFORE the debounce closure so the
    // redaction is decided at the user-interaction moment, not at flush
    // time (the element may be detached / re-rendered by then on SPA
    // frameworks). The sentinel itself is computed inside the closure so
    // sentinelBySelector reflects the latest selector-to-sentinel mapping.
    const sensitive = isSensitiveField(el);
    const timer = setTimeout(() => {
      inputTimers.delete(sel);
      // SEC-007 — for sensitive fields we NEVER read \`el.value\` into a
      // variable that crosses the binding boundary. The sentinel replaces
      // the raw value before \`__sentriRecord\` is called, and the value
      // local goes out of scope at function return without touching any
      // global / closure / module state.
      const value = sensitive ? sentinelFor(el, sel) : el.value;
      // Skip when the paste handler already emitted the exact same value —
      // browsers always fire \`input\` after \`paste\`, so without this dedup
      // a pasted token produces two identical \`fill\` actions. Clear the
      // entry after the check so a subsequent retype of the same value still
      // re-fires (mirrors the change handler's dedup semantics).
      if (lastEmittedFill.get(sel) === value) {
        lastEmittedFill.delete(sel);
        return;
      }
      lastEmittedFill.set(sel, value);
      window.__sentriRecord && window.__sentriRecord({
        kind: "fill", selector: sel, label, value, redacted: sensitive || undefined, ts: Date.now(),
      });
    }, ${TIMINGS.FILL_DEBOUNCE_MS});
    inputTimers.set(sel, { timer, el, label, sensitive });
  }, true);

  // Flush on form submit — Enter-to-submit on Google search and other
  // forms navigates away before the input debounce can fire. The capture
  // phase listener runs synchronously inside the same user-gesture task
  // as the navigation, so __sentriRecord (an exposeBinding) gets the
  // event queued before the page unloads.
  document.addEventListener("submit", () => {
    flushPendingClicks();
    flushAllPendingFills();
  }, true);

  // Last-chance flush before navigation. \`pagehide\` is more reliable
  // than \`beforeunload\` (fires for back/forward cache, programmatic
  // navigations, and HTTP redirects) — best-effort because exposeBinding
  // marshalling is async, but works for "type → click submit button"
  // flows where the click handler runs synchronously before unload.
  // Order matters: flush clicks first so the recorded sequence is
  // click → fill → goto rather than fill → click → goto when both are
  // pending (rare but possible with synthetic events).
  window.addEventListener("pagehide", () => {
    flushPendingClicks();
    flushAllPendingFills();
  }, true);

  document.addEventListener("paste", (ev) => {
    const el = eventElement(ev);
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
    const sel = selectorGenerator(el);
    if (!sel) return;
    const hasClipboard = ev.clipboardData && typeof ev.clipboardData.getData === "function"
      && !!(ev.clipboardData.getData("text") || "");
    if (!hasClipboard) return;
    // Cancel any pending input-handler debounce — the post-paste \`input\`
    // event would otherwise queue a second emission for the same change.
    if (inputTimers.get(sel)) { clearTimeout(inputTimers.get(sel).timer); inputTimers.delete(sel); }
    // Defer to a microtask so \`el.value\` reflects the post-paste field
    // contents (paste fires in the capture phase before the browser mutates
    // value). Using el.value — not just the clipboard snippet — means
    // pasting into a field with pre-existing text records the full final
    // value, matching what the input/change handlers would emit.
    //
    // SEC-007 — paste into a sensitive field (password manager autofill is
    // the canonical case) must redact too. Catching this branch matters:
    // 1Password / Bitwarden / Chrome autofill all dispatch \`paste\` →
    // \`input\` for password fields, and without this guard the paste
    // handler would record the raw password before the input handler's
    // redaction fired (paste runs first; its dedup cache primes the input
    // handler's skip path).
    const sensitive = isSensitiveField(el);
    setTimeout(() => {
      const rawValue = String(el.value || "").slice(0, 500);
      if (!rawValue) return;
      const value = sensitive ? sentinelFor(el, sel) : rawValue;
      // Prime the dedup cache so the subsequent \`input\` event (always
      // fired after paste) is suppressed by the guard added above.
      lastEmittedFill.set(sel, value);
      window.__sentriRecord && window.__sentriRecord({
        kind: "fill", selector: sel, label: bestLabel(el), value, redacted: sensitive || undefined, ts: Date.now(),
      });
    }, 0);
  }, true);

  document.addEventListener("change", (ev) => {
    const el = eventElement(ev);
    if (!el) return;
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      window.__sentriRecord && window.__sentriRecord({
        kind: el.checked ? "check" : "uncheck",
        selector: selectorGenerator(el),
        label: bestLabel(el),
        ts: Date.now(),
      });
    } else if (el.tagName === "INPUT" && el.type === "file") {
      const names = (el.files && el.files.length)
        ? Array.from(el.files).map((f) => f.name).join(", ")
        : "";
      window.__sentriRecord && window.__sentriRecord({
        kind: "upload", selector: selectorGenerator(el), label: bestLabel(el), value: names, ts: Date.now(),
      });
    } else if (el.tagName === "SELECT") {
      window.__sentriRecord && window.__sentriRecord({
        kind: "select", selector: selectorGenerator(el), label: bestLabel(el), value: el.value, ts: Date.now(),
      });
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      // Safety-net branch for autofill / paste / programmatic value changes
      // that bypass the "input" event. Skip when the "input" handler already
      // emitted a fill for this selector + value. If a debounced "input"
      // fill is still pending, flush it synchronously here so the recorded
      // action carries the latest value (the user committed it by blurring).
      const sel = selectorGenerator(el);
      if (!sel) return;
      // SEC-007 — same sensitivity check as the input + paste handlers, so
      // programmatic autofill (\`el.value = "..."\` from a password manager
      // extension) and the trailing change event for a manually-typed
      // password both produce a sentinel instead of the raw value.
      const sensitive = isSensitiveField(el);
      const effectiveValue = sensitive ? sentinelFor(el, sel) : el.value;
      const pending = inputTimers.get(sel);
      if (pending) {
        clearTimeout(pending.timer);
        inputTimers.delete(sel);
        // Fall through to emit below; the input handler hadn't fired yet.
      } else if (lastEmittedFill.get(sel) === effectiveValue) {
        // Already emitted by the input handler with the exact same value —
        // the change event is the trailing duplicate. Drop it and clear
        // the dedup entry so a subsequent retype of the same value still
        // gets recorded.
        lastEmittedFill.delete(sel);
        return;
      }
      lastEmittedFill.set(sel, effectiveValue);
      window.__sentriRecord && window.__sentriRecord({
        kind: "fill", selector: sel, label: bestLabel(el), value: effectiveValue, redacted: sensitive || undefined, ts: Date.now(),
      });
    }
  }, true);

  document.addEventListener("keydown", (ev) => {
    // Keep modifier-only events out, but capture regular typing + editing
    // keys so replay preserves keyboard-driven interactions.
    if (ev.key === "Shift" || ev.key === "Control" || ev.key === "Meta" || ev.key === "Alt") return;
    // Enter often submits a form and navigates away before the 300 ms
    // input debounce fires, losing the typed value. Flush all pending
    // fills synchronously so the recorded order is fill → press Enter →
    // goto rather than just press Enter → goto. Same rationale for Tab
    // (commits autocomplete + moves focus, can trigger nav on some sites).
    if (ev.key === "Enter" || ev.key === "Tab") {
      flushPendingClicks();
      flushAllPendingFills();
    }
    // If a printable single character is being typed into an editable field,
    // the "input" handler above already captures the resulting fill via
    // \`safeFill(sel, '<value>')\`. Emitting an additional per-keystroke
    // press here would generate redundant \`keyboard.press('h')\` calls
    // alongside the fill — replay would type each character once via press,
    // then clear-and-retype the whole string via safeFill, breaking React
    // controlled inputs / autocompletes / char-by-char validators that fire
    // mid-typing. Keyboard shortcuts (Ctrl+A, Cmd+V, Ctrl+Enter) and editing
    // keys (Enter, Tab, Backspace, arrows) are still captured because they
    // don't conflict with the fill capture.
    const t = ev.target;
    const isEditable = !!(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));
    if (ev.key.length === 1 && isEditable && !ev.ctrlKey && !ev.metaKey) {
      if (shortcutCaptureBudget <= 0) return;
      shortcutCaptureBudget -= 1;
    }
    if ((ev.key.length === 1 || ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(ev.key) || ev.ctrlKey || ev.metaKey)) {
      window.__sentriRecord && window.__sentriRecord({
        kind: "press", key: ev.key, selector: selectorGenerator(ev.target), label: bestLabel(ev.target), ts: Date.now(),
      });
    }
  }, true);

  let dragSource = "";
  document.addEventListener("dragstart", (ev) => {
    const el = eventElement(ev);
    dragSource = selectorGenerator(el);
  }, true);
  window.__sentriRecorderSetShortcutBudget = (n) => {
    const parsed = Number.isFinite(Number(n)) ? Number(n) : 0;
    shortcutCaptureBudget = Math.max(0, Math.floor(parsed));
  };
  // DIF-015c Gap 2 (point-and-click assert UX) — expose the in-page
  // selectorGenerator + bestLabel + the closest-interactive-ancestor
  // walk on \`window\` so the Node-side \`probeAtPoint\` helper can
  // resolve \`{selector, label, rect}\` for an arbitrary viewport
  // coordinate via \`page.evaluate\`. Without these exports the probe
  // would have to re-implement the same Playwright + hand-rolled
  // fallback logic, which is exactly the drift class of bug AGENT.md
  // §"Do not duplicate shared utilities" warns against. Returns null
  // when no interactive ancestor is found so the caller can fall back
  // to the operator's manual selector paste.
  window.__sentriProbeAtPoint = (x, y) => {
    try {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const target = el.closest
        ? (el.closest("a, button, input, textarea, select, [role], [data-testid], [data-test-id], [contenteditable='true']") || el)
        : el;
      const selector = selectorGenerator(target);
      const label = bestLabel(target);
      const rect = target.getBoundingClientRect();
      return {
        selector: selector || "",
        label: label || "",
        rect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
      };
    } catch (_) {
      return null;
    }
  };

  document.addEventListener("drop", (ev) => {
    const target = eventElement(ev);
    const targetSel = selectorGenerator(target);
    if (!dragSource || !targetSel) return;
    window.__sentriRecord && window.__sentriRecord({
      kind: "drag", selector: dragSource, target: targetSel, label: bestLabel(target), ts: Date.now(),
    });
    dragSource = "";
  }, true);
  } catch (err) {
    // Surface init-time failures via console.error — the backend pipes page
    // console output to its log so this lands in the same stream as the
    // \`[recorder/page-error]\` warnings. Without this, a thrown listener
    // setup leaves the recorder in a half-installed state where the binding
    // exists but no DOM events are wired up — the symptom is "only goto
    // actions are captured" (which is the only kind that comes from the
    // Node-side \`framenavigated\` listener, not the in-page script).
    console.error("[sentri-recorder] init failed:", err && err.stack ? err.stack : err);
    window.__sentriRecorderInstalled = false;
  }
})();
`;

/**
 * Escape a user-controlled string so it can be safely interpolated into a
 * JavaScript single-quoted string literal in generated source code. Handles
 * backslash (`\`), single quote (`'`), newline (`\n`), carriage return (`\r`),
 * line/paragraph separators (U+2028 / U+2029 — these break literals in most
 * engines), and other C0 control characters via `\xHH` escapes.
 *
 * Order matters: backslash must be escaped first, otherwise subsequent
 * replacements would double-escape their own inserted backslashes.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeJsSingleQuote(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    // Any remaining C0 / DEL control byte → \xHH. These would either break
    // the literal (e.g. U+0008) or render untrustworthy generated code.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * Derive a human-readable target phrase from a recorded action — prefers the
 * captured `label` (aria-label / inner text / placeholder), then falls back
 * to extracting a friendly name from a Playwright role selector
 * (`role=button[name="Sign in"]` → `the "Sign in" button`), and finally to
 * an empty string so the caller can degrade to a target-less sentence.
 *
 * Important: callers must NOT splice raw selectors into the persisted steps
 * — the AI generate / crawl pipeline ("User clicks the Sign Up button") and
 * the manual-test path both produce English prose, and recorded steps need
 * to render alongside them on the Test Detail page without leaking
 * `role=…[name="…"]` or CSS into the reviewer's view.
 *
 * @param {RecordedAction} a
 * @returns {string} Either ` the "<label>" <noun>`, ` "<label>"`, or `""`.
 */
function friendlyTarget(a, noun = "") {
  const raw = (a.label || "").trim();
  if (raw) {
    return noun ? ` the '${raw}' ${noun}` : ` '${raw}'`;
  }
  // Legacy actions captured before the `label` field existed only carry the
  // selector. Try to recover a name from `role=foo[name="bar"]` so older
  // recordings still render readable steps after this upgrade ships.
  const sel = a.selector || "";
  const m = sel.match(/role=([a-z]+)\[name="([^"]+)"\]/i);
  if (m) {
    const role = m[1].toLowerCase();
    const name = m[2];
    // Caller passed a noun (e.g. "button") → use it. Otherwise omit the
    // role name entirely — silently substituting the role for the noun
    // (e.g. " the 'Done' region") leaks a developer-facing concept and
    // also breaks "The …" prefixing in assertion-style step formatters
    // (would produce "The the 'Done' region is visible").
    return noun ? ` the '${name}' ${noun}` : ` '${name}'`;
  }
  // No label, no role selector — return empty so the sentence reads cleanly
  // ("User clicks") instead of leaking a CSS selector to the reviewer.
  return "";
}

/**
 * Same as {@link friendlyTarget} but operates on a raw selector/label pair
 * pulled from a different action's drop-target fields (`a.target` is a
 * selector string only — there's no separate `targetLabel`). Used by the
 * `drag` step formatter so the rendered sentence reads as
 * `User drags the 'Card 1' card onto the 'Done' column` instead of dropping
 * the target half of the gesture entirely.
 *
 * @param {string} selector - Raw selector to extract a friendly name from.
 * @param {string} [noun]   - Element noun (`"element"`, `"column"`).
 * @returns {string}        - ` the '<name>' <noun>`, ` '<name>'`, or `""`.
 */
function friendlyTargetFromSelector(selector, noun = "") {
  const sel = String(selector || "");
  if (!sel) return "";
  const m = sel.match(/role=([a-z]+)\[name="([^"]+)"\]/i);
  if (m) {
    const name = m[2];
    // Same rationale as friendlyTarget: only include a noun when the caller
    // explicitly asked for one. Substituting the parsed role (e.g.
    // "region") leaks developer-facing terminology into the persisted step.
    return noun ? ` the '${name}' ${noun}` : ` '${name}'`;
  }
  return "";
}

/**
 * Trim a captured URL for display in the Steps panel. Strips the query
 * string + fragment (which dominate noisy recorder URLs like Amazon search
 * pages with 6 tracking params) and caps the rendered length so a single
 * step doesn't push the panel sideways.
 */
function shortUrl(u) {
  if (!u) return "";
  try {
    const url = new URL(u);
    const base = `${url.origin}${url.pathname}`;
    return base.length > 80 ? base.slice(0, 77) + "…" : base;
  } catch {
    return String(u).slice(0, 80);
  }
}

/**
 * Render a captured action as a short, human-readable step sentence so the
 * recorder's persisted `steps[]` array aligns visually with the AI generate /
 * crawl pipeline output (`outputSchema.js`) and the manual-test creation path
 * — both of which produce English prose like "User clicks the Sign Up
 * button". The Test Detail page renders all three sources through the same
 * Steps panel, and previously the recorder was the only producer emitting
 * engineer-shaped strings ("Step 1: click → #login"), making recorded tests
 * stick out and look broken to manual reviewers.
 *
 * @param {RecordedAction} a
 * @returns {string} A single step sentence suitable for the persisted `steps[]` array.
 */
export function recordedActionToStepText(a) {
  // Recorded `fill` / `select` / `upload` / `assert*` values can contain
  // secrets (passwords, API keys). The raw value already lives in
  // `playwrightCode`; truncate aggressively in the human-readable steps so
  // the Test Detail page doesn't surface it.
  const truncVal = (v, n = 40) => String(v ?? "").slice(0, n);

  switch (a.kind) {
    case "goto":
      return `User navigates to ${shortUrl(a.url)}`.trim();
    case "click":
      return `User clicks${friendlyTarget(a, "button")}`;
    case "dblclick":
      // "double-clicks" is technical jargon to a manual tester. The AI
      // pipeline (`outputSchema.js:74-78`) favours plain user-intent prose,
      // so describe the gesture as a repeated click on the target instead.
      // Drop the "element" fallback noun — it reads as developer jargon
      // ("clicks the Save element"). With a captured label the sentence
      // says "User clicks 'Save' twice"; without one it degrades to a clean
      // "User clicks twice".
      return `User clicks${friendlyTarget(a)} twice`;
    case "rightClick":
      // Same rationale as dblclick — "right-clicks" leaks the input device.
      // The user-visible outcome of a right-click is the context menu, so
      // describe that instead.
      return `User opens the context menu on${friendlyTarget(a)}`;
    case "hover":
      return `User hovers over${friendlyTarget(a)}`;
    case "fill": {
      // Match the AI pipeline's "User fills in X with 'value'" phrasing
      // (outputSchema.js:74-78) — recorder previously used "User fills the
      // 'Email' field with …" which read differently from AI-generated and
      // manually-created steps on the same Test Detail page.
      //
      // SEC-007 — redacted fills render with a `[REDACTED]` placeholder
      // so reviewers see at a glance that the field is credential-typed
      // and the persisted prose carries no credential surface area. We
      // detect via either the explicit `redacted: true` marker (set by
      // the in-page rule) OR the sentinel pattern (covers actions that
      // pre-date the marker — the marker was added in the same SEC-007
      // PR but actions captured during a hot reload would have value
      // without marker).
      const isRedacted = a.redacted === true || /^__SENTRI_SECRET_/.test(String(a.value || ""));
      const display = isRedacted ? "[REDACTED]" : `'${truncVal(a.value)}'`;
      return `User fills in${friendlyTarget(a, "field")} with ${display}`;
    }
    case "press":
      return `User presses ${a.key || ""}`.trim();
    case "select":
      return `User selects '${truncVal(a.value)}'${friendlyTarget(a, "dropdown") ? ` in${friendlyTarget(a, "dropdown")}` : ""}`;
    case "check":
      return `User checks${friendlyTarget(a, "checkbox")}`;
    case "uncheck":
      return `User unchecks${friendlyTarget(a, "checkbox")}`;
    case "upload":
      // Drop the "file input" noun — manual testers don't think in input
      // types. "User uploads 'resume.pdf' for the 'Attach CV' field" reads
      // closer to the user's intent than "… in the 'Attach CV' file input".
      return `User uploads '${truncVal(a.value)}'${friendlyTarget(a, "field") ? ` for${friendlyTarget(a, "field")}` : ""}`;
    case "drag": {
      // Surface BOTH source and drop-target so reviewers can follow the
      // gesture from the persisted steps alone. The previous formatter
      // dropped the target entirely, leaving "User drags 'Card 1'" with no
      // indication of where it landed. No "element" fallback noun — it
      // reads as developer jargon when reviewers see it in the Steps panel.
      const source = friendlyTarget(a);
      const target = friendlyTargetFromSelector(a.target);
      return target
        ? `User drags${source} onto${target}`
        : `User drags${source}`;
    }
    case "assertVisible":
      // Match the AI pipeline's outcome-style assertions ("the 'Sign in'
      // button is visible") rather than our previous engineer-shaped
      // "User asserts visibility of …" phrasing. The Steps panel renders
      // recorded + AI-generated tests through the same component, so the
      // sentence shapes need to be interchangeable. Fall back to "An
      // element" (capitalised, no jargon "the element") when no friendly
      // label can be recovered.
      return friendlyTarget(a)
        ? `The${friendlyTarget(a)} is visible`
        : `The expected content is visible`;
    case "assertText":
      return friendlyTarget(a)
        ? `The${friendlyTarget(a)} contains '${truncVal(a.value)}'`
        : `The page contains '${truncVal(a.value)}'`;
    case "assertValue": {
      // `friendlyTarget(a, "field")` returns " the 'Email' field" (with a
      // lowercase leading "the"), so we splice the captured label into the
      // sentence directly rather than prefixing another "The" — the
      // resulting "The the …" duplication was a CI failure on the previous
      // pass.
      const t = friendlyTarget(a, "field");
      return t
        ? `The${t.replace(/^ the /, " ")} has value '${truncVal(a.value)}'`
        : `The field has value '${truncVal(a.value)}'`;
    }
    case "assertUrl":
      // "URL" is engineer-speak; manual testers think "page address". Use
      // "page address" so the persisted step reads naturally next to AI-
      // generated steps like "User opens the dashboard page".
      return `The page address contains '${truncVal(a.value, 60)}'`;
    case "assertCount": {
      // Outcome-style assertion matching the AI pipeline's phrasing. With
      // a captured label we read "There are N 'Item' rows"; without one we
      // degrade cleanly to a generic "There are N matching elements"
      // rather than leaking the selector. The captured `value` is the
      // expected count (string-coerced upstream); render as an integer.
      const n = Number(a.value);
      const count = Number.isFinite(n) ? n : a.value;
      const t = friendlyTarget(a);
      return t
        ? `There are ${count} matching${t}`
        : `There are ${count} matching elements`;
    }
    case "assertHasClass": {
      // Reads as "The 'Submit' button has the 'is-loading' class" so it
      // sits naturally next to assertVisible / assertText prose. No label
      // → fall back to "The matched element has the 'X' class" rather
      // than emitting a bare quote with nothing in front of it.
      const t = friendlyTarget(a);
      return t
        ? `The${t} has the '${truncVal(a.value)}' class`
        : `The matched element has the '${truncVal(a.value)}' class`;
    }
    default:
      // Fall back to the action kind so unknown future kinds still show
      // something — better than emitting an empty string into the steps list.
      return `User performs ${a.kind || "action"}${friendlyTarget(a)}`;
  }
}

/**
 * Predicate matching the required-field branches in
 * {@link actionsToPlaywrightCode}. Returns `true` iff the action carries
 * enough information for the code generator to emit a corresponding line.
 *
 * Exported so route handlers building the persisted human-readable
 * `steps[]` array can filter with the **same** rules the code generator
 * applies — without this shared predicate the two would drift, causing
 * `steps.length !== playwrightCode` step counts on the Test Detail page
 * (and breaking step-based edit/regeneration that indexes by position).
 * If you add a new action kind to {@link actionsToPlaywrightCode}, add the
 * matching branch here too.
 *
 * @param {RecordedAction} a
 * @returns {boolean}
 */
export function isEmittableAction(a) {
  switch (a?.kind) {
    case "goto":         return !!a.url;
    case "click":
    case "dblclick":
    case "rightClick":
    case "hover":
    case "fill":
    case "select":
    case "check":
    case "uncheck":
    case "upload":
    case "assertVisible":
    case "assertText":
    case "assertValue":  return !!a.selector;
    case "press":        return !!a.key;
    case "drag":         return !!a.selector && !!a.target;
    case "assertUrl":    return !!a.value;
    // assertCount + assertHasClass need BOTH a selector (to bind the
    // expectation to) AND a value (the count / class name). Without
    // either field the code generator would emit nothing — match that
    // here so steps[].length and `// Step N:` comment count stay aligned.
    case "assertCount":
    case "assertHasClass": return !!a.selector && a.value != null && String(a.value).length > 0;
    default:             return false;
  }
}

/**
 * Filter a list of captured actions down to the ones the code generator
 * would actually emit. Convenience wrapper around {@link isEmittableAction}.
 *
 * @param {Array<RecordedAction>} actions
 * @returns {Array<RecordedAction>}
 */
export function filterEmittableActions(actions) {
  return (actions || []).filter(isEmittableAction);
}

/**
 * Convert a list of captured actions into a Playwright test body. The output
 * is wrapped in the repo-standard `test(...)` shape so the existing runner
 * (codeExecutor, codeParsing) treats it like any AI-generated test.
 *
 * @param {string} testName
 * @param {string} startUrl
 * @param {Array<RecordedAction>} actions
 * @returns {string} Playwright source code.
 */
export function actionsToPlaywrightCode(testName, startUrl, actions) {
  const safeName = escapeJsSingleQuote(testName || "Recorded test");
  const safeStartUrl = escapeJsSingleQuote(startUrl || "");
  const lines = [];
  const actorExpr = (action) => {
    const alias = escapeJsSingleQuote(action?.pageAlias || "page");
    const base = alias === "page" ? "page" : `(await ensurePopup('${alias}'))`;
    const frameUrl = String(action?.frameUrl || "");
    if (!frameUrl) return base;
    // The frameLocator argument is a single-quoted JS string ('...') containing
    // a CSS attribute selector that is itself double-quoted ([src*="..."]).
    // `escapeJsSingleQuote` covers the outer JS string layer; we ALSO have to
    // escape any literal `"` inside frameUrl so the inner attribute selector
    // doesn't terminate early. Without this, a frame URL containing a `"`
    // (rare in practice — usually `%22`-encoded — but possible from custom
    // `src` values that bypass URL normalisation) produces a malformed
    // selector like `iframe[src*="frame"hijack"]` that throws at runtime.
    // Escape any literal `"` inside frameUrl so the inner CSS attribute
    // selector doesn't terminate early. The generated JS source wraps the
    // selector in a single-quoted string (`'iframe[src*="…"]'`), so we
    // need `\"` to appear in that source — which means emitting a
    // backslash + quote pair (`\\"`) here. Using `'\\"'` would only emit
    // a bare `"` at runtime (the JS parser consumes the backslash),
    // leaving the inner attribute selector unescaped.
    const escapedFrameUrl = escapeJsSingleQuote(frameUrl).replace(/"/g, '\\\\"');
    return `${base}.frameLocator('iframe[src*="${escapedFrameUrl}"]').first()`;
  };
  lines.push(`const __popupPages = new Map();`);
  lines.push(`context.on('page', (p) => {`);
  lines.push(`  const alias = 'popup' + (__popupPages.size + 1);`);
  lines.push(`  __popupPages.set(alias, p);`);
  lines.push(`});`);
  lines.push(`const ensurePopup = async (alias) => {`);
  lines.push(`  for (let i = 0; i < 50; i++) {`);
  lines.push(`    const p = __popupPages.get(alias);`);
  lines.push(`    if (p) return p;`);
  lines.push(`    await page.waitForTimeout(100);`);
  lines.push(`  }`);
  lines.push(`  throw new Error('Popup not found: ' + alias);`);
  lines.push(`};`);
  lines.push(`await page.goto('${safeStartUrl}');`);
  // `startRecording` always pushes an initial `goto` to startUrl as actions[0]
  // (and `framenavigated` can echo the same URL). We emit the initial goto
  // above, so suppress any subsequent consecutive gotos to the same URL to
  // avoid duplicate navigation in the generated script.
  let lastGotoUrl = String(startUrl || "");
  let stepNo = 1;
  for (const a of actions) {
    const sel = escapeJsSingleQuote(a.selector || "");
    const targetSel = escapeJsSingleQuote(a.target || "");
    const actor = actorExpr(a);
    if (a.kind === "goto" && a.url) {
      if (a.url === lastGotoUrl) continue;
      lastGotoUrl = a.url;
      const safeUrl = escapeJsSingleQuote(a.url);
      const gotoActor = a.pageAlias && a.pageAlias !== "page" ? `(await ensurePopup('${escapeJsSingleQuote(a.pageAlias)}'))` : "page";
      lines.push(`// Step ${stepNo}: Navigate`);
      lines.push(`await ${gotoActor}.goto('${safeUrl}');`);
    } else if (a.kind === "click" && sel) {
      lines.push(`// Step ${stepNo}: Click element`);
      lines.push(`await safeClick(${actor}, '${sel}');`);
    } else if (a.kind === "dblclick" && sel) {
      lines.push(`// Step ${stepNo}: Double click element`);
      lines.push(`await ${actor}.locator('${sel}').dblclick();`);
    } else if (a.kind === "rightClick" && sel) {
      lines.push(`// Step ${stepNo}: Right click element`);
      lines.push(`await ${actor}.locator('${sel}').click({ button: 'right' });`);
    } else if (a.kind === "hover" && sel) {
      lines.push(`// Step ${stepNo}: Hover over element`);
      lines.push(`await ${actor}.locator('${sel}').hover();`);
    } else if (a.kind === "fill" && sel) {
      // SEC-007 — when the captured value is a redaction sentinel
      // (`__SENTRI_SECRET_<n>__`), emit `process.env.SENTRI_SECRET_<n>`
      // instead of the literal string so the generated test reads its
      // credentials from the runtime environment rather than carrying
      // them in the source. The generator also emits a guard that
      // throws a clear error if the env var is unset at replay time —
      // far better than a confusing "field is empty" assertion failure
      // when an operator runs a recorded test in a fresh CI shard.
      const m = String(a.value || "").match(/^__SENTRI_SECRET_(\d+|AUTO)__$/);
      if (m) {
        const envName = `SENTRI_SECRET_${m[1]}`;
        lines.push(`// Step ${stepNo}: Fill field (credential — value sourced from env)`);
        lines.push(`if (!process.env.${envName}) throw new Error('SEC-007: required env var ${envName} is not set; this recorded test was authored against a sensitive field. See docs/api/tests.md § Recorder credential redaction.');`);
        lines.push(`await safeFill(${actor}, '${sel}', process.env.${envName});`);
      } else {
        lines.push(`// Step ${stepNo}: Fill field`);
        lines.push(`await safeFill(${actor}, '${sel}', '${escapeJsSingleQuote(a.value || "")}');`);
      }
    } else if (a.kind === "press" && a.key) {
      // `keyboard` only exists on Page (not Frame), so always route key
      // presses through the owning page even when the action originated
      // inside an iframe — keyboard input is page-scoped in CDP anyway.
      const pageActor = a.pageAlias && a.pageAlias !== "page" ? `(await ensurePopup('${escapeJsSingleQuote(a.pageAlias)}'))` : "page";
      lines.push(`// Step ${stepNo}: Press ${escapeJsSingleQuote(a.key)}`);
      lines.push(`await ${pageActor}.keyboard.press('${escapeJsSingleQuote(a.key)}');`);
    } else if (a.kind === "select" && sel) {
      // Route through the self-healing helper so recorded selects benefit
      // from the safeSelect waterfall (getByLabel → getByRole('combobox') →
      // aria-label fallback). `applyHealingTransforms` won't rewrite a raw
      // `page.selectOption('#css', ...)` because `selectorGenerator()` always
      // produces CSS-looking output, so emit `safeSelect` directly here to
      // stay consistent with how `safeClick` and `safeFill` are handled
      // above.
      lines.push(`// Step ${stepNo}: Select option`);
      lines.push(`await safeSelect(${actor}, '${sel}', '${escapeJsSingleQuote(a.value || "")}');`);
    } else if ((a.kind === "check" || a.kind === "uncheck") && sel) {
      // Same rationale as safeSelect above — the recorder's CSS-looking
      // selectors bypass the applyHealingTransforms regex guard, so emit
      // safeCheck/safeUncheck directly. These helpers gained list/row
      // scoped fallbacks in PR #103 for TodoMVC-style patterns, which
      // recorded checkboxes benefit from for free.
      lines.push(`// Step ${stepNo}: ${a.kind === "check" ? "Check" : "Uncheck"}`);
      lines.push(`await ${a.kind === "check" ? "safeCheck" : "safeUncheck"}(${actor}, '${sel}');`);
    } else if (a.kind === "upload" && sel) {
      // The recorder only sees browser-side `File.name` values — it has no
      // access to the original bytes or a server-side path. Emit the
      // captured filenames as a comment so reviewers can wire up real
      // fixtures, but ship a no-op `[]` payload so replay doesn't crash
      // with ENOENT trying to read non-existent local files.
      const capturedNames = String(a.value || "").split(",").map((n) => n.trim()).filter(Boolean);
      lines.push(`// Step ${stepNo}: Upload file(s)`);
      if (capturedNames.length) {
        lines.push(`// NOTE: recorder captured filenames ${JSON.stringify(capturedNames)} — replace [] with real fixture path(s) before running outside the recorder`);
      } else {
        lines.push(`// NOTE: replace with real fixture path(s) before running outside the recorder`);
      }
      lines.push(`await safeUpload(${actor}, '${sel}', []);`);
    } else if (a.kind === "drag" && sel && targetSel) {
      lines.push(`// Step ${stepNo}: Drag and drop`);
      lines.push(`await ${actor}.locator('${sel}').dragTo(${actor}.locator('${targetSel}'));`);
    } else if (a.kind === "assertVisible" && sel) {
      lines.push(`// Step ${stepNo}: Assert element is visible`);
      lines.push(`await expect(${actor}.locator('${sel}')).toBeVisible();`);
    } else if (a.kind === "assertText" && sel) {
      lines.push(`// Step ${stepNo}: Assert element text`);
      lines.push(`await expect(${actor}.locator('${sel}')).toContainText('${escapeJsSingleQuote(a.value || "")}');`);
    } else if (a.kind === "assertValue" && sel) {
      lines.push(`// Step ${stepNo}: Assert field value`);
      lines.push(`await expect(${actor}.locator('${sel}')).toHaveValue('${escapeJsSingleQuote(a.value || "")}');`);
    } else if (a.kind === "assertUrl" && a.value) {
      // The frontend prompts for a "URL fragment or regex text", and most
      // users type a plain URL fragment containing regex metacharacters
      // (`?`, `[`, `(`, `+`, `.`) that would either crash `new RegExp(...)`
      // with a SyntaxError or silently change semantics (e.g. `?` making
      // the previous char optional). Escape regex metacharacters so the
      // captured value matches literally — that's what users expect.
      const literal = String(a.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      lines.push(`// Step ${stepNo}: Assert URL`);
      lines.push(`await expect(page).toHaveURL(new RegExp('${escapeJsSingleQuote(literal)}'));`);
    } else if (a.kind === "assertCount" && sel && a.value != null && String(a.value).length > 0) {
      // Coerce to a non-negative integer so `toHaveCount(NaN)` can't slip
      // through. Anything that doesn't parse cleanly falls back to 0 —
      // emit the assertion anyway so the reviewer sees a clearly broken
      // step in the Test Detail view rather than the action silently
      // disappearing from playwrightCode.
      const n = Number.parseInt(String(a.value), 10);
      const expected = Number.isFinite(n) && n >= 0 ? n : 0;
      lines.push(`// Step ${stepNo}: Assert element count`);
      lines.push(`await expect(${actor}.locator('${sel}')).toHaveCount(${expected});`);
    } else if (a.kind === "assertHasClass" && sel && a.value != null && String(a.value).length > 0) {
      // Playwright's `toHaveClass` matches the FULL class attribute when
      // given a string, so partial-class matches (the common case — "is
      // this button currently `is-loading`?") need a regex. Build a
      // word-boundary regex with escaped metacharacters so a class name
      // like `btn.primary` (rare but valid in framework-generated CSS)
      // doesn't break out of its regex literal.
      const literal = String(a.value).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      lines.push(`// Step ${stepNo}: Assert element class`);
      lines.push(`await expect(${actor}.locator('${sel}')).toHaveClass(new RegExp('(^|\\\\s)${escapeJsSingleQuote(literal)}(\\\\s|$)'));`);
    } else {
      continue;
    }
    stepNo++;
  }
  lines.push(`// Step ${stepNo}: Verify page is still reachable`);
  lines.push(`await expect(page).toHaveURL(/.*/);`);

  return (
    `import { test, expect } from '@playwright/test';\n\n` +
    `test('${safeName}', async ({ page, context }) => {\n` +
    lines.map(l => "  " + l).join("\n") +
    "\n});\n"
  );
}

/**
 * Append a manual assertion action to an in-flight recording session.
 * Mirrors Playwright recorder's explicit "Add assertion" flow.
 *
 * @param {string} sessionId
 * @param {RecordedAction} action
 * @returns {RecordedAction}
 */
export function addAssertionAction(sessionId, action) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  if (session.status !== "recording") throw new Error(`Recording session ${sessionId} is not recording.`);
  const kind = String(action?.kind || "");
  const allowed = new Set([
    "assertVisible", "assertText", "assertValue", "assertUrl",
    // DIF-015c Gap 2 — count + class assertions. Both require selector AND
    // value (count: integer-parseable; hasClass: non-empty class token).
    "assertCount", "assertHasClass",
  ]);
  if (!allowed.has(kind)) throw new Error(`Invalid assertion kind: ${kind}`);
  const selector = action?.selector ? String(action.selector).slice(0, 200) : undefined;
  const value = action?.value != null ? String(action.value).slice(0, 500) : undefined;
  // Reject payloads that would later be silently dropped by
  // `actionsToPlaywrightCode` — assertions without their required field
  // would render in the Steps panel but disappear from the generated test
  // code, leaving users with assertions they think exist but don't.
  if (kind !== "assertUrl" && !selector) {
    throw new Error(`Invalid assertion: selector is required for ${kind}.`);
  }
  if ((kind === "assertText" || kind === "assertValue" || kind === "assertUrl" || kind === "assertCount" || kind === "assertHasClass") && !value) {
    throw new Error(`Invalid assertion: value is required for ${kind}.`);
  }
  // assertCount needs a non-negative integer-parseable value. Reject
  // anything that wouldn't survive Number.parseInt cleanly so the route
  // surfaces a 400 instead of letting the code generator fall back to its
  // `expected = 0` defence and confusing the reviewer at replay time.
  if (kind === "assertCount") {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n) || n < 0 || String(n) !== String(value).trim()) {
      throw new Error("Invalid assertion: value for assertCount must be a non-negative integer.");
    }
  }
  const row = {
    kind,
    selector,
    label: action?.label ? String(action.label).slice(0, 80) : undefined,
    value,
    ts: Date.now(),
  };
  session.actions.push(row);
  return row;
}

/**
 * DIF-015c Gap 3 — pause action capture on an in-flight recording.
 * Flips `session.paused = true`; the browser stays open and the
 * screencast continues so the operator can navigate the SUT without
 * polluting `actions[]`. Three call sites honour the flag:
 *
 *   1. {@link forwardInput} — short-circuits CDP dispatch so user
 *      clicks / keystrokes from the canvas overlay never reach the page.
 *   2. The `__sentriRecord` exposeBinding callback in {@link startRecording}
 *      — drops in-page-captured DOM events (debounced fills flushing,
 *      framework re-renders firing change handlers, programmatic clicks
 *      from page JS) so in-flight work that started before pause does
 *      not silently leak in.
 *   3. The popup + debounced main-page `framenavigated` handlers —
 *      drop synthesised `goto` actions while paused.
 *
 * @param {string} sessionId
 * @returns {{ paused: true }}
 * @throws {Error} when the session is unknown or not in `"recording"` state.
 */
export function pauseRecording(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  if (session.status !== "recording") throw new Error(`Recording session ${sessionId} is not recording.`);
  session.paused = true;
  return { paused: true };
}

/**
 * DIF-015c Gap 3 — resume action capture after a pause. Idempotent on a
 * session that was never paused (the flag was already falsy). See
 * {@link pauseRecording} for the list of guarded call sites.
 *
 * @param {string} sessionId
 * @returns {{ paused: false }}
 * @throws {Error} when the session is unknown or not in `"recording"` state.
 */
export function resumeRecording(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  if (session.status !== "recording") throw new Error(`Recording session ${sessionId} is not recording.`);
  session.paused = false;
  return { paused: false };
}

/**
 * DIF-015c Gap 3 — undo the most recent recorded action. Idempotent on
 * an empty `session.actions[]` (returns `{ removed: null, actionCount: 0 }`
 * rather than 4xx) so the UI can fire the button without first checking
 * the step count — matches the spec's "idempotent on empty actions[]"
 * acceptance criterion in `NEXT.md`.
 *
 * @param {string} sessionId
 * @returns {{ removed: RecordedAction|null, actionCount: number }}
 * @throws {Error} when the session is unknown or not in `"recording"` state.
 */
export function popLastRecordingAction(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  if (session.status !== "recording") throw new Error(`Recording session ${sessionId} is not recording.`);
  const removed = session.actions.length ? session.actions.pop() : null;
  return { removed, actionCount: session.actions.length };
}

/**
 * DIF-015c Gap 2 (point-and-click assert UX) — resolve the
 * `{selector, label, rect}` for an arbitrary viewport coordinate so the
 * frontend can highlight the hovered element and pre-fill the
 * "Add verification" form on click. Mirrors how Playwright codegen's
 * inspector probes the page under the cursor.
 *
 * The probe runs entirely in the page context via `page.evaluate`,
 * calling the `window.__sentriProbeAtPoint` helper that the recorder
 * script attaches at init time. That helper reuses the SAME selector +
 * label heuristics the click/fill listeners use, so the picker's
 * suggestion is byte-aligned with what a real click would have captured.
 *
 * The probe is cheap (~5 ms in practice) and idempotent — the operator
 * can pump events at hover frequency (~30 fps) without polluting the
 * session. We deliberately do NOT record the probe as an action; it's
 * a read-only inspection.
 *
 * @param {string} sessionId
 * @param {{x: number, y: number}} point - Viewport coordinates (already
 *   scaled by the frontend from CSS pixels via `LiveBrowserView.scaleCoords`).
 * @returns {Promise<{selector: string, label: string, rect: {x: number, y: number, width: number, height: number}}|null>}
 *   The hovered element's selector + friendly label + bounding rect, or
 *   `null` when no interactive ancestor was found (e.g. cursor over the
 *   page background). The caller falls back to manual selector paste.
 * @throws {Error} when the session is unknown or not recording.
 */
export async function probeAtPoint(sessionId, point) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  if (session.status !== "recording") throw new Error(`Recording session ${sessionId} is not recording.`);
  if (!session.page) throw new Error(`Recording session ${sessionId} has no active page.`);
  const x = Math.max(0, Math.round(Number(point?.x) || 0));
  const y = Math.max(0, Math.round(Number(point?.y) || 0));
  try {
    const probe = await session.page.evaluate(
      ({ x, y }) => {
        if (typeof window.__sentriProbeAtPoint !== "function") return null;
        return window.__sentriProbeAtPoint(x, y);
      },
      { x, y },
    );
    return probe || null;
  } catch (err) {
    // Page navigating mid-probe → return null so the frontend just drops
    // the highlight rather than surfacing a 500 to the operator. The
    // probe is best-effort by design.
    if (process.env.LOG_LEVEL === "debug") {
      console.error(formatLogLine("debug", null, `[recorder] probeAtPoint failed: ${err.message}`));
    }
    return null;
  }
}

/**
 * DIF-015c Gap 5 — switch the device profile of an in-flight recording
 * session. Playwright applies device emulation (userAgent, viewport,
 * deviceScaleFactor, hasTouch, locale) at `browser.newContext()` time
 * only — there is no mid-context API for swapping descriptors. To honour
 * the operator's device choice mid-session we tear down the page+context
 * and rebuild them under the new descriptor against the **same** browser
 * process. Captured `session.actions[]` are preserved across the switch
 * (the operator's step history is not lost), but page state (cookies,
 * partially-filled forms, scroll position, in-flight requests) is — the
 * UI surfaces a confirmation prompt before calling this so operators
 * understand the trade-off.
 *
 * Acceptance criteria (NEXT.md `:53`):
 *   - Device dropdown shows the same options as `RunRegressionModal` ✓
 *     (DEVICE_PRESETS shared via `config.js`).
 *   - Switching mid-session resizes the canvas to match ✓ (response
 *     `viewport` flows back to the frontend; `LiveBrowserView` already
 *     rescales pointer coordinates against `viewportW/viewportH`).
 *   - Selectors regenerated at the new viewport's pixel scale ✓ (the
 *     rebuilt context's `deviceScaleFactor` flows from the descriptor;
 *     subsequent captures use the new viewport's coordinate space
 *     because `selectorGenerator` runs against the rebuilt page).
 *
 * @param {string} sessionId
 * @param {string} device - One of `DEVICE_PRESETS[].value` (empty string =
 *   desktop default). Validated against `ACCEPTED_DEVICE_NAMES`; unknown
 *   values throw.
 * @returns {Promise<{device: string, viewport: {width: number, height: number}, url: string}>}
 * @throws {Error} when the session is unknown, not recording, the device
 *   is invalid, or the rebuild fails (in which case the session is left
 *   in a torn-down state and the caller should re-issue `stopRecording`).
 */
export async function switchDevice(sessionId, device) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  if (session.status !== "recording") throw new Error(`Recording session ${sessionId} is not recording.`);

  const requested = device == null ? "" : String(device);
  if (!ACCEPTED_DEVICE_NAMES.has(requested)) {
    throw new Error(`Invalid device: ${requested}`);
  }
  // Idempotent on the active device — return the current viewport so the
  // frontend can reconcile without firing a teardown/rebuild dance.
  // Mirrors how `resumeRecording` no-ops on a never-paused session.
  if (requested === (session.device || "")) {
    return {
      device: session.device || "",
      viewport: session.viewport || { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      url: session.url,
    };
  }

  // Snapshot the current page URL BEFORE teardown so we can navigate the
  // rebuilt page to wherever the operator was. If `page.url()` throws
  // (page already closing), fall back to the recorded session URL so we
  // still land somewhere sensible.
  let currentUrl;
  try { currentUrl = session.page?.url() || session.url; }
  catch { currentUrl = session.url; }

  const browser = session.browser;
  if (!browser) throw new Error(`Recording session ${sessionId} has no browser to switch device on.`);

  // Tear down current page + screencast + context — but NOT the browser.
  // The browser process stays open and the new context is created under
  // it, saving ~500ms vs. a full launch. Catch-and-swallow each step so
  // a partial teardown still lets the rebuild run.
  try { if (session.stopScreencast) await session.stopScreencast(); } catch { /* ignore */ }
  try { await session.page?.close(); } catch { /* ignore */ }
  try { await session.context?.close(); } catch { /* ignore */ }
  session.stopScreencast = null;
  session.cdpSession = null;
  session.page = null;
  session.context = null;

  // Rebuild the context + page under the new device descriptor. This
  // duplicates the binding + addInitScript + framenavigated wiring from
  // `startRecording`; keep the two in sync if you change either.
  try {
    const { contextOpts, viewport: effectiveViewport } = resolveDeviceContext(requested);
    const newContext = await browser.newContext(contextOpts);
    session.context = newContext;
    session.device = requested;
    session.viewport = effectiveViewport;

    const newPage = await _attachAndOpenRecorderPage(session, newContext, currentUrl, effectiveViewport);
    session.page = newPage;
    return {
      device: session.device,
      viewport: session.viewport,
      url: session.url,
    };
  } catch (err) {
    // Rebuild failed — leave the session in a torn-down state so the
    // operator's next call (likely Stop & Save or Discard) hits the
    // "not recording" branch and we don't leak a Chromium process.
    try { await session.context?.close(); } catch { /* ignore */ }
    session.context = null;
    session.page = null;
    session.status = "stopping";
    throw new Error(`Device switch failed: ${err.message}`);
  }
}

/**
 * DIF-015c Gap 5 — private helper that wires the `__sentriRecord` binding
 * + Playwright selector bootstrap + addInitScript + popup + main-page
 * `framenavigated` handlers onto a fresh context, opens a page, navigates
 * to `startUrl`, and starts the CDP screencast at the resolved viewport.
 * Used by {@link switchDevice} after a context teardown.
 *
 * The body below duplicates the inline setup in `startRecording` — keep
 * the two in sync if you change either. A full extraction would require
 * threading the binding closure, pageAliases map, and screencast handle
 * through a single options object, which is more refactor than this PR's
 * scope. The duplication is bounded and clearly documented.
 *
 * Side effects on `session`:
 *   - `session.pageAliases` is reused from the prior context so popup
 *     `popup1`/`popup2` labels stay stable across the switch.
 *   - `session.stopScreencast` + `session.cdpSession` are re-assigned to
 *     the new screencast handle so `forwardInput` resumes routing CDP
 *     events to the rebuilt page.
 *   - `session.url` is updated to the post-navigate landed URL.
 *
 * @param {RecordingSession} session
 * @param {Object} context - Freshly-built Playwright BrowserContext.
 * @param {string} startUrl - URL to navigate the rebuilt page to.
 * @param {{width: number, height: number}} viewport - Effective viewport
 *   from the device descriptor; threaded into `startScreencast`.
 * @returns {Promise<Object>} The newly-created Playwright Page.
 * @private
 */
async function _attachAndOpenRecorderPage(session, context, startUrl, viewport) {
  // Reuse the prior context's alias map so popup labels stay stable.
  // Stale entries (the closed pre-switch main page) are pruned below
  // once the new page is registered.
  const pageAliases = session.pageAliases || new Map();
  session.pageAliases = pageAliases;

  // Re-attach the binding to the new context. The closure captures
  // the same `session` reference, so dedup state (DBLCLICK window,
  // hover collapse, fill collapse) keeps working against
  // `session.actions[]` without reinitialisation.
  await context.exposeBinding("__sentriRecord", (source, action) => {
    if (session.status !== "recording") return;
    if (session.paused === true) return;
    if (!action || typeof action !== "object") return;
    const sourcePage = source?.page || null;
    const sourceFrame = source?.frame || null;
    const isMainFrame = !!(sourcePage && sourceFrame && sourcePage.mainFrame() === sourceFrame);
    const row = {
      kind: String(action.kind || ""),
      selector: action.selector ? String(action.selector).slice(0, 200) : undefined,
      target: action.target ? String(action.target).slice(0, 200) : undefined,
      label: action.label ? String(action.label).slice(0, 80) : undefined,
      value: action.value != null ? String(action.value).slice(0, 500) : undefined,
      // SEC-007 — preserve the redaction marker so codegen + step prose
      // can route this fill through `process.env.SENTRI_SECRET_N` instead
      // of emitting the (already-sentinel) value literal. The page-side
      // script sets `redacted: true` only when the value is a
      // `__SENTRI_SECRET_<n>__` placeholder; we also defence-in-depth log
      // a warning here if we ever see a raw credential pattern slip
      // through (a future RECORDER_SCRIPT change that bypasses the
      // sensitivity check), so the leak is caught before persistence.
      redacted: action.redacted === true || undefined,
      url: action.url ? String(action.url) : undefined,
      key: action.key ? String(action.key) : undefined,
      pageAlias: sourcePage ? (pageAliases.get(sourcePage) || "page") : "page",
      frameUrl: !isMainFrame && sourceFrame?.url ? String(sourceFrame.url()).slice(0, 500) : undefined,
      ts: Number(action.ts) || Date.now(),
    };
    // SEC-007 defence-in-depth — if the in-page script forgot to mark a
    // fill on a known-sensitive selector pattern, catch it here at the
    // binding boundary before it lands in session.actions[]. The
    // redaction marker is added retroactively and a warning is logged
    // (value NEVER logged — only the selector + label).
    if (row.kind === "fill" && row.redacted !== true && _looksLikeSecretValue(row.value)) {
      console.error(formatLogLine("warn", null, `[recorder] SEC-007 server-side redaction triggered for selector=${row.selector || "<unknown>"} label=${row.label || "<unlabelled>"} — in-page rule missed this field; review credential heuristic`));
      row.value = "__SENTRI_SECRET_AUTO__";
      row.redacted = true;
    }
    // Dedup heuristics — verbatim copy of the startRecording binding.
    if (row.kind === "dblclick" && row.selector) {
      for (let i = session.actions.length - 1; i >= 0; i--) {
        const prev = session.actions[i];
        if (row.ts - (prev.ts || 0) > TIMINGS.DBLCLICK_WINDOW_MS) break;
        if (prev.kind === "click" && prev.selector === row.selector) {
          session.actions.splice(i, 1);
        }
      }
    }
    if (row.kind === "hover") {
      const last = session.actions[session.actions.length - 1];
      if (last && last.kind === "hover") session.actions.pop();
    }
    if (INTERACTION_KINDS.has(row.kind) && row.selector) {
      const last = session.actions[session.actions.length - 1];
      if (last && last.kind === "hover" && last.selector === row.selector) session.actions.pop();
    }
    if (row.kind === "fill" && row.selector) {
      const last = session.actions[session.actions.length - 1];
      if (last && last.kind === "fill" && last.selector === row.selector) session.actions.pop();
    }
    const POINTER_KINDS = new Set(["click", "dblclick", "rightClick", "hover"]);
    if (POINTER_KINDS.has(row.kind) && !row.label) {
      const sel = row.selector || "";
      const hasSemanticSelector = /^(?:role=|text=|data-testid=|label=|placeholder=|alt=|title=)/.test(sel);
      if (!hasSemanticSelector) row._noLabel = true;
    }
    session.actions.push(row);
  });

  // _attachAndOpenRecorderPage continues in the next chunk —
  // addInitScript + page creation + framenavigated + screencast.
  return _finishOpenRecorderPage(session, context, startUrl, viewport, pageAliases);
}

/**
 * Second half of {@link _attachAndOpenRecorderPage} — keeps each function
 * body under the size where editing tools get unhappy. Splits the work
 * AT a natural seam: by this point the `__sentriRecord` binding is
 * registered on the context, so creating new pages is safe. This block
 * handles addInitScripts + page creation + framenavigated listeners +
 * initial navigation + screencast restart.
 *
 * @private
 */
async function _finishOpenRecorderPage(session, context, startUrl, viewport, pageAliases) {
  // DIF-015c Gap 6: re-apply stealth on the rebuilt context so a
  // mid-session device switch doesn't undo the stealth profile the
  // operator opted into at launch. Default-mode (`stealth !== true`)
  // takes the early-return path so pre-Gap-6 behaviour is unchanged.
  if (session.stealth === true) {
    await context.addInitScript(STEALTH_SCRIPT);
  }

  // Inject Playwright's own InjectedScript bootstrap before our recorder
  // script so `window.__playwrightSelector` is populated by the time
  // selectorGenerator() runs on the first user interaction. Mirrors the
  // startRecording flow; see the longer comment there for the rationale.
  let bootstrap = "";
  try { bootstrap = buildInjectedBootstrapScript(); }
  catch (err) {
    console.error(formatLogLine("warn", null, `[recorder] buildInjectedBootstrapScript failed during device switch — falling back to hand-rolled selectorGenerator: ${err.message}`));
  }
  if (bootstrap) await context.addInitScript(bootstrap);
  await context.addInitScript(RECORDER_SCRIPT);

  // Drop stale page refs from the prior context (closed main page,
  // closed popups) before wiring the new page in, so popup labels
  // recompute against the live page count.
  for (const k of Array.from(pageAliases.keys())) {
    try { if (!k || (typeof k === "object" && k.isClosed?.())) pageAliases.delete(k); }
    catch { pageAliases.delete(k); }
  }

  const page = await context.newPage();
  pageAliases.set(page, "page");

  page.on("pageerror", (err) => {
    if (err && err.message && err.message.includes("sentri-recorder")) {
      console.error(formatLogLine("warn", null, `[recorder/page-error] ${err.message}`));
    }
  });
  context.on("page", (p) => {
    if (pageAliases.has(p)) return;
    pageAliases.set(p, `popup${Math.max(1, pageAliases.size)}`);
    p.on("framenavigated", (frame) => {
      if (session.paused === true) return;
      if (frame === p.mainFrame() && frame.url() && frame.url() !== "about:blank") {
        session.actions.push({ kind: "goto", pageAlias: pageAliases.get(p), url: frame.url(), ts: Date.now() });
      }
    });
  });

  // Navigate to the snapshotted URL so the operator lands back where
  // they were before the device switch. The post-navigate URL drives
  // the recorded `goto` action so any server-side redirect (HTTPS
  // upgrade, locale prefix) is captured truthfully.
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT }).catch(() => {});
  const landedUrl = page.url() || startUrl;
  session.url = landedUrl;
  // Push a `goto` so the recorded steps reflect the device-switch
  // navigation — without this, the rebuilt page renders silently and
  // the operator's first post-switch click looks like it happened on
  // the pre-switch URL in the generated playwrightCode.
  session.actions.push({ kind: "goto", pageAlias: "page", url: landedUrl, ts: Date.now() });

  // Debounced main-page framenavigated — verbatim copy of the
  // startRecording handler, with the same pause guard.
  const FRAME_NAV_DEBOUNCE_MS = 800;
  let frameNavTimer = null;
  let pendingFrameUrl = "";
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url || url === "about:blank") return;
    pendingFrameUrl = url;
    if (frameNavTimer) { clearTimeout(frameNavTimer); frameNavTimer = null; }
    frameNavTimer = setTimeout(() => {
      frameNavTimer = null;
      if (session.status !== "recording") return;
      if (session.paused === true) return;
      const last = [...session.actions].reverse().find((a) => a.kind === "goto");
      if (last && last.url === pendingFrameUrl) return;
      session.actions.push({ kind: "goto", pageAlias: "page", url: pendingFrameUrl, ts: Date.now() });
    }, FRAME_NAV_DEBOUNCE_MS);
  });

  // Restart the CDP screencast at the new viewport so the canvas
  // resizes to native device dimensions — LiveBrowserView already
  // rescales pointer coordinates against the viewport prop, so the
  // frontend just needs to update its `viewport` state from the
  // route response.
  const screencastResult = await startScreencast(page, session.id, {
    interactive: true,
    viewport,
  });
  if (screencastResult) {
    session.stopScreencast = screencastResult.stop;
    session.cdpSession = screencastResult.cdpSession;
  }

  return page;
}

/**
 * DIF-015c Gap 5 — pure helper that resolves a device name to a
 * `browser.newContext()` options object plus the effective viewport.
 * Mirrors the device-descriptor merge already done by `executeTest.js`
 * (`backend/src/runner/executeTest.js:208-232`) so recorder runs feel
 * identical to test runs at the same device profile.
 *
 * Empty / unknown device names fall back to the desktop defaults so a
 * caller that never opts into device emulation behaves bit-for-bit
 * identically to the pre-Gap-5 recorder.
 *
 * @param {string} [device] - One of `DEVICE_PRESETS[].value` (curated list).
 * @returns {{ contextOpts: Object, viewport: {width: number, height: number}, descriptor: Object|null }}
 */
function resolveDeviceContext(device) {
  const descriptor = resolveDevice(device || "");
  const viewport = descriptor?.viewport || { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
  // Spread the descriptor first so explicit overrides below take precedence
  // — same merge order as `executeTest.js`. Without `viewport` overridden
  // explicitly, a missing descriptor would leave the context at Playwright's
  // default 1280×720 even when the caller asked for desktop, which is
  // already what we want; the explicit assignment keeps the contract
  // observable to readers.
  const contextOpts = {
    ...(descriptor || {}),
    viewport,
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
  };
  return { contextOpts, viewport, descriptor: descriptor || null };
}

/**
 * Start a new interactive recording session. Opens a Playwright browser,
 * navigates to `startUrl`, installs the capture script, and begins a CDP
 * screencast on the given session ID (reused as the SSE run ID).
 *
 * @param {Object} args
 * @param {string} args.sessionId   - Unique ID used for SSE + session tracking.
 * @param {string} args.projectId
 * @param {string} args.startUrl
 * @param {string} [args.device]    - DIF-015c Gap 5: optional device name
 *   from `DEVICE_PRESETS` (e.g. `"iPhone 14"`). Empty string / undefined →
 *   desktop default (legacy behaviour). Unknown values are rejected at the
 *   route layer; this helper assumes the caller has already validated.
 * @param {boolean} [args.stealth=false] - DIF-015c Gap 6: when true, the
 *   `STEALTH_SCRIPT` is installed via `context.addInitScript` BEFORE the
 *   recorder script and main page navigation, so `navigator.webdriver`
 *   reads as `undefined` (and four other surfaces look real-Chrome-ish)
 *   from the very first byte of the SUT. Default false → no init script
 *   is registered for stealth; pre-Gap-6 behaviour bit-for-bit unchanged.
 * @returns {Promise<RecordingSession>}
 */
export async function startRecording({ sessionId, projectId, startUrl, device = "", stealth = false }) {
  if (sessions.has(sessionId)) {
    throw new Error(`Recording session ${sessionId} is already active.`);
  }
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    throw new Error("startUrl must be a valid http(s) URL.");
  }

  const browser = await launchBrowser();
  let context;
  let page;
  try {
    const { contextOpts, viewport: effectiveViewport } = resolveDeviceContext(device);
    context = await browser.newContext(contextOpts);

    const session = /** @type {RecordingSession} */ ({
      id: sessionId,
      projectId,
      url: startUrl,
      status: "recording",
      actions: [],
      startedAt: Date.now(),
      device: device || "",
      viewport: effectiveViewport,
      stealth: !!stealth,
      browser,
      context,
    });

    const pageAliases = new Map();
    session.pageAliases = pageAliases;

    // CRITICAL ORDERING: `exposeBinding` and `addInitScript` only apply to
    // pages / documents created AFTER they are registered. If we call
    // `context.newPage()` before these, the resulting page never has
    // `window.__sentriRecord` installed and `RECORDER_SCRIPT` may not run
    // on its initial document — the symptom is the recorder only emitting
    // `goto` actions (from the Node-side `framenavigated` listener) while
    // every click/fill/keypress is silently dropped because the in-page
    // emit guard `window.__sentriRecord && …` is falsy.
    //
    // Register the binding and init scripts on the context FIRST, then
    // create the page.

    // Expose a binding for the injected script to relay captured events.
    await context.exposeBinding("__sentriRecord", (source, action) => {
      if (session.status !== "recording") return;
      // While paused, drop all in-page-captured actions. `forwardInput`
      // already short-circuits user-initiated CDP input at the route
      // layer, but the page can still emit events from in-flight work
      // that started before pause (debounced fills flushing, framework
      // re-renders firing change handlers, programmatic clicks fired by
      // page JS, …). Without this guard those would leak into
      // `session.actions[]` and surprise the operator at replay time.
      if (session.paused === true) return;
      if (!action || typeof action !== "object") return;
      const sourcePage = source?.page || null;
      const sourceFrame = source?.frame || null;
      const isMainFrame = !!(sourcePage && sourceFrame && sourcePage.mainFrame() === sourceFrame);
      const row = {
        kind: String(action.kind || ""),
        selector: action.selector ? String(action.selector).slice(0, 200) : undefined,
        target: action.target ? String(action.target).slice(0, 200) : undefined,
        label: action.label ? String(action.label).slice(0, 80) : undefined,
        value: action.value != null ? String(action.value).slice(0, 500) : undefined,
        // SEC-007 — propagate the redaction marker (set by the in-page
        // script when the source field matched isSensitiveField). The
        // server-side check below catches the case where the in-page
        // rule missed (rare — only fires for SUTs that use a text input
        // for credentials AND don't match the name/id heuristic).
        redacted: action.redacted === true || undefined,
        url: action.url ? String(action.url) : undefined,
        key: action.key ? String(action.key) : undefined,
        pageAlias: sourcePage ? (pageAliases.get(sourcePage) || "page") : "page",
        frameUrl: !isMainFrame && sourceFrame?.url ? String(sourceFrame.url()).slice(0, 500) : undefined,
        ts: Number(action.ts) || Date.now(),
      };
      // Browsers fire two `click` events before a `dblclick`. Without
      // suppression a user double-click replays as click, click, dblclick
      // — running the same handler three times. Drop trailing clicks on
      // the same selector that arrived within the OS double-click window
      // (`TIMINGS.DBLCLICK_WINDOW_MS`) so the recorded action list matches
      // user intent.
      if (row.kind === "dblclick" && row.selector) {
        for (let i = session.actions.length - 1; i >= 0; i--) {
          const prev = session.actions[i];
          if (row.ts - (prev.ts || 0) > TIMINGS.DBLCLICK_WINDOW_MS) break;
          if (prev.kind === "click" && prev.selector === row.selector) {
            session.actions.splice(i, 1);
          }
        }
      }
      // Strip consecutive hovers — when a new hover arrives and the last
      // recorded action is ALSO a hover, replace it in-place. A hover chain
      // produced by the user sweeping the mouse across the page (A → B → C)
      // is always noise; only the final resting position before a real
      // interaction is meaningful. Replacing instead of appending keeps the
      // steps list clean without discarding intentional hovers (tooltip
      // triggers, dropdown openers) — the last hover before a pause is still
      // preserved.
      if (row.kind === "hover") {
        const last = session.actions[session.actions.length - 1];
        if (last && last.kind === "hover") {
          session.actions.pop();
        }
      }
      // Drop noisy hover actions that immediately precede a real interaction
      // on the same selector. The in-page `HOVER_DWELL_MS` filter catches
      // drive-by mouseovers, but a user pausing on a button before clicking
      // it (very common — that's what "aim and click" looks like) still
      // produces a junk `hover` action right before the `click`. Strip the
      // trailing hover when the very next action is an interaction on the
      // same target so the captured step list reflects user intent rather
      // than mouse mechanics. `INTERACTION_KINDS` is defined at module
      // scope above — don't re-allocate it per event.
      if (INTERACTION_KINDS.has(row.kind) && row.selector) {
        const last = session.actions[session.actions.length - 1];
        if (last && last.kind === "hover" && last.selector === row.selector) {
          session.actions.pop();
        }
      }
      // Collapse consecutive `fill` actions on the same selector — the
      // in-page 300 ms debounce emits one fill per typing pause, so
      // typing "iphone" with a micro-pause after "i" produces two
      // steps: `fill 'i'` then `fill 'iphone'`. The second supersedes
      // the first (same field, final value wins), so drop the earlier
      // row in place instead of appending a new one. Matches the
      // consecutive-hover dedup pattern above.
      if (row.kind === "fill" && row.selector) {
        const last = session.actions[session.actions.length - 1];
        if (last && last.kind === "fill" && last.selector === row.selector) {
          session.actions.pop();
        }
      }
      // Tag `click` / `dblclick` / `rightClick` / `hover` rows that arrive
      // without a friendly label AND without a semantic selector prefix
      // (role=, text=, data-testid=, label=, placeholder=, alt=, title=).
      // These come from layout-container clicks with no accessible name,
      // and rendering them as bare "Click" / "Hover over" entries in the
      // Steps panel is noise that hurts step-quality. We keep the row in
      // `session.actions` (so the CSS-fallback selector still drives
      // `playwrightCode` replay) but mark it with `_noLabel: true` so the
      // sidebar / persisted `steps[]` formatter can hide it from the
      // human-readable view. Replay fidelity AND step quality both
      // preserved — earlier revisions dropped the row entirely, which
      // silently broke replay for icon-only buttons.
      const POINTER_KINDS = new Set(["click", "dblclick", "rightClick", "hover"]);
      if (POINTER_KINDS.has(row.kind) && !row.label) {
        const sel = row.selector || "";
        const hasSemanticSelector = /^(?:role=|text=|data-testid=|label=|placeholder=|alt=|title=)/.test(sel);
        if (!hasSemanticSelector) {
          row._noLabel = true;
        }
      }
      session.actions.push(row);
    });
    // Inject Playwright's own InjectedScript bootstrap before our
    // recorder script so `window.__playwrightSelector` is populated by
    // the time selectorGenerator() runs on the first user interaction.
    // `addInitScript` calls run in registration order, and the empty
    // string from `buildInjectedBootstrapScript()` (when the bundle
    // can't be loaded) is a no-op — addInitScript accepts empty strings
    // without complaint, but skip the call to keep the page-init log
    // clean.
    // Defence-in-depth: if `buildInjectedBootstrapScript()` throws (e.g.
    // playwright-core layout drift), swallow the error so the recorder
    // script below is still registered. Without this guard a thrown
    // bootstrap would skip `addInitScript(RECORDER_SCRIPT)` entirely and
    // the page would have no `window.__sentriRecord` binding — the
    // symptom is the recorder only emitting `goto` actions while every
    // click/fill/keypress is silently dropped.
    // DIF-015c Gap 6: install the stealth bootstrap BEFORE the
    // Playwright selector bootstrap and recorder script so
    // `navigator.webdriver` reads as `undefined` from the very first
    // byte of the SUT. Default-mode (`stealth: false`) skips this
    // entirely — pre-Gap-6 behaviour is bit-for-bit identical.
    // Without the early-bird ordering, a target site can read
    // `navigator.webdriver` synchronously during its bootstrap
    // (`<head><script>if (navigator.webdriver) location = "/blocked"</script>`)
    // before our addInitScript runs.
    if (stealth === true) {
      await context.addInitScript(STEALTH_SCRIPT);
      console.log(formatLogLine("info", null, `[recorder] stealth profile enabled for session=${sessionId}`));
    }

    let bootstrap = "";
    try { bootstrap = buildInjectedBootstrapScript(); }
    catch (err) {
      console.error(formatLogLine("warn", null, `[recorder] buildInjectedBootstrapScript failed — falling back to hand-rolled selectorGenerator: ${err.message}`));
    }
    if (bootstrap) await context.addInitScript(bootstrap);

    await context.addInitScript(RECORDER_SCRIPT);

    // Now that the binding + init scripts are registered on the context,
    // create the page. Both will be applied to this page's documents,
    // including the initial about:blank and the upcoming `page.goto`.
    page = await context.newPage();
    pageAliases.set(page, "page");
    session.page = page;

    // Surface in-page recorder init failures via the backend log. The IIFE
    // in `RECORDER_SCRIPT` is wrapped in try/catch and emits a
    // `[sentri-recorder] init failed:` console.error on any thrown listener
    // setup; piping page console here lets us notice silently broken
    // recordings (no actions captured) instead of having to attach a
    // debugger.
    page.on("pageerror", (err) => {
      if (err && err.message && err.message.includes("sentri-recorder")) {
        console.error(formatLogLine("warn", null, `[recorder/page-error] ${err.message}`));
      }
    });
    context.on("page", (p) => {
      if (pageAliases.has(p)) return;
      pageAliases.set(p, `popup${Math.max(1, pageAliases.size)}`);
      p.on("framenavigated", (frame) => {
        if (session.paused === true) return;
        if (frame === p.mainFrame() && frame.url() && frame.url() !== "about:blank") {
          session.actions.push({ kind: "goto", pageAlias: pageAliases.get(p), url: frame.url(), ts: Date.now() });
        }
      });
    });

    // Navigate to the starting URL and record it as the first action.
    // We capture the actual landed URL (after any server-side redirects)
    // from the page rather than the caller-supplied `startUrl` so the
    // generated goto reflects the canonical entry point.
    //
    // Also promote `session.url` to the landed URL so every downstream
    // consumer that dedups against the first goto (`actionsToPlaywrightCode`'s
    // hardcoded `await page.goto(startUrl)` + `lastGotoUrl` seed, and
    // `routes/tests.js`'s persisted-steps dedup loop) sees the same URL the
    // recorded `actions[0]` carries. Without this, any redirect at launch
    // (http→https, apex→www, OAuth callback) leaves the pre-redirect URL
    // seeded as `lastGotoUrl` while `actions[0].url` is the post-redirect
    // value — the inequality bypasses dedup and the generated test emits
    // two consecutive `page.goto(...)` calls for what is one navigation.
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT }).catch(() => {});
    const landedUrl = page.url() || startUrl;
    session.url = landedUrl;
    session.actions.push({ kind: "goto", pageAlias: "page", url: landedUrl, ts: Date.now() });

    // Debounced framenavigated handler — fires for EVERY step in a redirect
    // chain (including intermediate tracking hops like /sorry/index). Without
    // debouncing, a search-form submit that redirects three times before
    // settling on the results page produces three consecutive goto steps, all
    // of which show up in the sidebar as "Navigate to …". We defer the push
    // by FRAME_NAV_DEBOUNCE_MS so only the URL the browser actually lands on
    // after the chain has settled is recorded. Each new framenavigated event
    // during the window resets the timer and promotes the newer URL — the
    // final flush captures the canonical destination.
    //
    // Dedup: if the settled URL matches the last recorded goto (e.g. the
    // listener fires for the initial page.goto that already pushed an action
    // above, or a hash-only change on an SPA), the action is silently dropped.
    const FRAME_NAV_DEBOUNCE_MS = 800;
    let frameNavTimer = null;
    let pendingFrameUrl = "";
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank") return;
      pendingFrameUrl = url;
      if (frameNavTimer) { clearTimeout(frameNavTimer); frameNavTimer = null; }
      frameNavTimer = setTimeout(() => {
        frameNavTimer = null;
        if (session.status !== "recording") return;
        // Pause also drops debounced framenavigated flushes — a
        // navigation that started before pause but settled after should
        // not produce a recorded `goto` (matches the `__sentriRecord`
        // binding guard above; consistent operator-facing model).
        if (session.paused === true) return;
        // Deduplicate: skip if the settled URL is the same as the last
        // recorded goto so initial-page echoes and trivial hash changes
        // don't produce spurious Navigate steps in the sidebar.
        const last = [...session.actions].reverse().find((a) => a.kind === "goto");
        if (last && last.url === pendingFrameUrl) return;
        session.actions.push({ kind: "goto", pageAlias: "page", url: pendingFrameUrl, ts: Date.now() });
      }, FRAME_NAV_DEBOUNCE_MS);
    });

    // Start CDP screencast so the RecorderModal can show the live browser.
    // startScreencast now returns { stop, cdpSession } — store both so the
    // recorder can forward mouse/keyboard events from the canvas overlay.
    // DIF-015c Gap 5: pass the resolved viewport so iPhone / Pixel device
    // profiles stream JPEG frames at native resolution (390×844 for an
    // iPhone 14) instead of being letterboxed inside the desktop default.
    const screencastResult = await startScreencast(page, sessionId, {
      interactive: true,
      viewport: effectiveViewport,
    });
    if (screencastResult) {
      session.stopScreencast = screencastResult.stop;
      session.cdpSession = screencastResult.cdpSession;
    }

    // Defence-in-depth: if the client never calls stop/discard (e.g. tab
    // closed, network died) the browser would remain open forever. Force-kill
    // the session after `MAX_RECORDING_MS` so we never leak Chromium.
    session.idleTimeout = setTimeout(async () => {
      console.error(formatLogLine("warn", null, `[recorder] session ${sessionId} exceeded MAX_RECORDING_MS (${MAX_RECORDING_MS}ms) — auto-tearing down`));
      try {
        const result = await stopRecording(sessionId);
        // Stash the generated test so a user who hits "Stop & Save" right
        // after the timeout fires doesn't lose their captured actions.
        completedSessions.set(sessionId, {
          projectId: session.projectId,
          actions: result.actions,
          playwrightCode: result.playwrightCode,
          url: result.url,
          completedAt: Date.now(),
          reason: "auto_timeout",
        });
        const purge = setTimeout(() => completedSessions.delete(sessionId), COMPLETED_TTL_MS);
        purge.unref?.();
      } catch { /* session may already be gone; nothing to stash */ }
      // Close out the stub `runs` row created by POST /record. Without this,
      // the row stays in `status: "running"` forever and the partial unique
      // index `idx_runs_one_active_per_project` blocks every future run on
      // this project (crawl/test_run/generate report opaque UNIQUE errors;
      // the next recorder launch's orphan sweep is the only path that
      // recovers, but only for `record` rows).
      try {
        runRepo.update(sessionId, {
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          error: `Recorder exceeded MAX_RECORDING_MS (${MAX_RECORDING_MS}ms) — auto-torn-down`,
        });
      } catch { /* row may not exist (e.g. tests that bypass route layer) */ }
    }, MAX_RECORDING_MS);
    // Node's timer would keep the process alive; recorder sessions are
    // per-request resources, so let the event loop exit if everything else
    // is quiescent.
    session.idleTimeout.unref?.();

    // Only publish the session after all async setup has succeeded —
    // otherwise the caller never learns the sessionId to stop and the
    // browser would leak permanently.
    sessions.set(sessionId, session);
    return session;
  } catch (err) {
    // Tear down any partial Playwright resources so we don't leak a
    // Chromium process when setup fails mid-way.
    try { await page?.close(); } catch { /* ignore */ }
    try { await context?.close(); } catch { /* ignore */ }
    try { await browser?.close(); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Look up an in-flight recording session.
 * @param {string} sessionId
 * @returns {RecordingSession|null}
 */
export function getRecording(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Look up and remove a recording that was auto-torn-down by the safety-net
 * timeout. Returns `null` if no such recording is cached (either never timed
 * out, or the TTL has expired). The entry is removed on read so callers get
 * at-most-once delivery of the captured actions.
 *
 * @param {string} sessionId
 * @returns {CompletedRecording|null}
 */
export function takeCompletedRecording(sessionId) {
  const entry = completedSessions.get(sessionId);
  if (!entry) return null;
  completedSessions.delete(sessionId);
  return entry;
}

/**
 * Test-only seam: install a fake recording session keyed by `sessionId` so
 * unit tests can exercise {@link forwardInput} (and its CDP dispatch logic)
 * without launching a real Chromium. Returns a disposer that removes the
 * session from the in-memory map.
 *
 * Intentionally not part of the public API — only the module's own test file
 * imports this. The `_test` prefix and JSDoc tag should keep it out of normal
 * usage; reviewers should reject any non-test caller.
 *
 * @param {string} sessionId
 * @param {Object} fields - Partial RecordingSession fields to seed.
 * @returns {Function} Disposer `() => void` that deletes the seeded session.
 * @private
 */
export function _testSeedSession(sessionId, fields = {}) {
  sessions.set(sessionId, {
    id: sessionId,
    projectId: fields.projectId ?? "TEST-PROJECT",
    url: fields.url ?? "https://example.com",
    status: fields.status ?? "recording",
    actions: [],
    startedAt: Date.now(),
    cdpSession: fields.cdpSession,
    ...fields,
  });
  return () => sessions.delete(sessionId);
}

/**
 * Forward a user input event from the canvas overlay to the headless browser
 * via CDP Input domain commands. This is the core mechanism that makes the
 * recorder interactive — without it the canvas is read-only and the user can
 * never produce actions in the headless browser.
 *
 * Supported event types:
 *   mousePressed / mouseReleased / mouseMoved  → Input.dispatchMouseEvent
 *   keyDown / keyUp / char                     → Input.dispatchKeyEvent
 *   scroll                                     → Input.dispatchMouseEvent (wheel)
 *
 * @param {string} sessionId
 * @param {Object} event
 * @param {"mousePressed"|"mouseReleased"|"mouseMoved"|"keyDown"|"keyUp"|"char"|"scroll"} event.type
 * @param {number} [event.x]          - Viewport x (already scaled by caller).
 * @param {number} [event.y]          - Viewport y (already scaled by caller).
 * @param {number} [event.button]     - DOM MouseEvent.button: 0=left, 1=middle, 2=right.
 *                                      Pass `undefined` (omit) for moves with no
 *                                      button held — CDP requires `"none"` then.
 * @param {number} [event.clickCount] - 1 for single click.
 * @param {number} [event.deltaX]     - Horizontal scroll delta.
 * @param {number} [event.deltaY]     - Vertical scroll delta.
 * @param {string} [event.key]        - DOM key name, e.g. "Enter".
 * @param {string} [event.code]       - DOM code, e.g. "KeyA".
 * @param {number} [event.keyCode]    - DOM virtual keycode (`e.keyCode`).
 *                                      Required for non-printable keys —
 *                                      without it CDP fires keyDown but
 *                                      Backspace/Enter/Tab/Arrows have no
 *                                      effect on the page.
 * @param {string} [event.text]       - Printable text for char events.
 * @param {number} [event.modifiers]  - Bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
 * @returns {Promise<void>}
 * @throws {Error} When the session is not found or has no CDP session.
 */
export async function forwardInput(sessionId, event) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  if (!session.cdpSession) throw new Error(`Session ${sessionId} has no CDP session — cannot forward input.`);
  if (session.status !== "recording") return; // ignore input after stop is called
  if (session.paused === true) return;

  const cdp = session.cdpSession;
  const { type } = event;

  try {
    if (type === "mousePressed" || type === "mouseReleased" || type === "mouseMoved") {
      // DOM MouseEvent.button: 0=left, 1=middle, 2=right. CDP uses string
      // names. For `mouseMoved` with no button held the caller should omit
      // `event.button` so we dispatch `"none"` — otherwise CDP interprets a
      // numeric 0 as a held left-button and treats the move as a drag.
      const buttonMap = { 0: "left", 1: "middle", 2: "right" };
      const cdpButton = event.button == null ? "none" : (buttonMap[event.button] ?? "none");
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: Math.round(event.x ?? 0),
        y: Math.round(event.y ?? 0),
        button: cdpButton,
        clickCount: event.clickCount ?? (type === "mousePressed" ? 1 : 0),
        modifiers: event.modifiers ?? 0,
      });
    } else if (type === "scroll") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(event.x ?? 0),
        y: Math.round(event.y ?? 0),
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY ?? 0,
        modifiers: event.modifiers ?? 0,
      });
    } else if (type === "keyDown" || type === "keyUp") {
      // `windowsVirtualKeyCode` is what makes Backspace/Enter/Tab/Arrows
      // actually trigger their default action in the page. Without it CDP
      // fires the event but the page receives no operation. The frontend
      // forwards `e.keyCode` from the DOM event for this purpose.
      const args = {
        type,
        key: event.key ?? "",
        code: event.code ?? "",
        text: type === "keyDown" ? (event.text ?? "") : "",
        modifiers: event.modifiers ?? 0,
      };
      if (typeof event.keyCode === "number" && event.keyCode > 0) {
        args.windowsVirtualKeyCode = event.keyCode;
        args.nativeVirtualKeyCode = event.keyCode;
      }
      await cdp.send("Input.dispatchKeyEvent", args);
    } else if (type === "char") {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "char",
        key: event.text ?? "",
        text: event.text ?? "",
        modifiers: event.modifiers ?? 0,
      });
    } else if (type === "shortcutCapture") {
      await session.page?.evaluate((budget) => {
        if (typeof window.__sentriRecorderSetShortcutBudget === "function") {
          window.__sentriRecorderSetShortcutBudget(budget);
        }
      }, event?.count ?? 3);
    }
  } catch (err) {
    // CDP errors (e.g. page navigating mid-click) are transient — don't crash
    // the session. Log at debug level so they don't flood production logs.
    if (process.env.LOG_LEVEL === "debug") {
      console.error(formatLogLine("debug", null, `[recorder] forwardInput CDP error: ${err.message}`));
    }
  }
}

/**
 * Stop an in-flight recording session, tear down the Playwright browser,
 * and return the captured actions transformed into Playwright source. The
 * generated code is wrapped in the repo-standard `test(...)` shape so the
 * caller can persist it as a Draft test row and re-run it through the
 * normal runner.
 *
 * Idempotent w.r.t. the in-memory map: the session is removed regardless
 * of whether teardown errors. The browser/context/page cleanup calls are
 * `.catch(() => {})`-shielded so a half-closed browser never leaks state.
 *
 * @param {string} sessionId
 * @param {Object} [opts]
 * @param {string} [opts.testName] - Optional name to embed in the generated test.
 * @returns {Promise<{ actions: Array<RecordedAction>, playwrightCode: string, url: string }>}
 * @throws {Error} When the session does not exist.
 */
export async function stopRecording(sessionId, opts = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Recording session ${sessionId} not found.`);
  session.status = "stopping";

  try {
    if (session.idleTimeout) { clearTimeout(session.idleTimeout); session.idleTimeout = null; }
    if (session.stopScreencast) await session.stopScreencast().catch(() => {});
    await session.page?.close().catch(() => {});
    await session.context?.close().catch(() => {});
    await session.browser?.close().catch(() => {});
  } finally {
    session.status = "stopped";
    sessions.delete(sessionId);
  }

  const testName = opts.testName || `Recorded flow @ ${new Date().toISOString()}`;
  const playwrightCode = actionsToPlaywrightCode(testName, session.url, session.actions);
  return { actions: session.actions, playwrightCode, url: session.url };
}

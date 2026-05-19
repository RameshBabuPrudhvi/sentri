/**
 * executeTest.js — Single-test execution against a live browser
 *
 * Orchestrates a single test case: opens a browser context, attaches
 * network/console listeners, runs the AI-generated code (or a fallback
 * smoke test), captures artifacts, persists healing events, and cleans up.
 *
 * Heavy sub-tasks are delegated to focused modules:
 *   - codeParsing.js / codeExecutor.js  — parse & run generated code
 *   - screencast.js                     — CDP live-stream lifecycle
 *   - pageCapture.js                    — DOM snapshot, screenshots, boxes
 *   - healingPersistence.js             — write healing events to DB
 *
 * Exports:
 *   executeTest(test, browser, runId, stepIndex, runStart)
 */

import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { getHealingHistoryForTest, tryVisionHeal } from "../selfHealing.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as elementBaselineRepo from "../database/repositories/elementBaselineRepo.js";
import * as visionBudgetRepo from "../database/repositories/visionBudgetRepo.js";
import { pixelmatchHeal, llmVisionHeal } from "./visionHealAdapters.js";
import { visionHealBudgetExhaustedTotal } from "../utils/metrics.js";
import { logActivity } from "../utils/activityLogger.js";
import { extractTestBody, isApiTest } from "./codeParsing.js";
import { runGeneratedCode, runApiTestCode, getExpect } from "./codeExecutor.js";
import { startScreencast } from "./screencast.js";
import { waitForStable, captureDomSnapshot, captureScreenshot, captureBoundingBoxes, captureWebVitals, registerWebVitalsInitScript, captureElementCrop } from "./pageCapture.js";
import { PNG } from "pngjs";
import { persistHealingEvents } from "./healingPersistence.js";
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT, NAVIGATION_TIMEOUT, API_TEST_TIMEOUT, BROWSER_TEST_TIMEOUT, VIDEOS_DIR, SHOTS_DIR, resolveDevice } from "./config.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { injectCursorOverlay } from "./cursorOverlay.js";
import { diffScreenshot } from "./visualDiff.js";
import { applyNetworkCondition } from "./networkConditions.js";
import { writeArtifactBuffer } from "../utils/objectStorage.js";


// ─── Non-visual action detection (S3-06) ──────────────────────────────────────
// When a test's last meaningful action is non-visual (assertion, wait, evaluate),
// we skip the post-test screenshot / DOM snapshot / bounding-box capture. These
// artifacts are redundant for non-visual endings and each capture adds 50-200ms
// of overhead per test.

/**
 * Patterns that match non-visual Playwright actions at the end of a test body.
 * If the last non-blank, non-comment line matches any of these, we skip
 * screenshot capture on success since the page hasn't visually changed.
 */
const NON_VISUAL_PATTERNS = [
  /\bexpect\s*\(/,                        // any assertion: expect(...)
  /\bsafeExpect\s*\(/,                    // self-healing assertion
  /\.toBeVisible\s*\(/,                   // visibility assertion
  /\.toHaveURL\s*\(/,                     // URL assertion
  /\.toHaveTitle\s*\(/,                   // title assertion
  /\.toContainText\s*\(/,                 // text assertion
  /\.toHaveText\s*\(/,                    // exact text assertion
  /\.toHaveValue\s*\(/,                   // input value assertion
  /\.toBeEnabled\s*\(/,                   // enabled state assertion
  /\.toBeDisabled\s*\(/,                  // disabled state assertion
  /\.toBeChecked\s*\(/,                   // checkbox assertion
  /\.toHaveCount\s*\(/,                   // element count assertion
  /\bpage\.waitForTimeout\s*\(/,          // explicit wait
  /\bpage\.waitForSelector\s*\(/,         // selector wait
  /\bpage\.waitForLoadState\s*\(/,        // load state wait
  /\bpage\.waitForURL\s*\(/,              // URL wait
  /\bawait\s+sleep\s*\(/,                // custom sleep helper
  /\bconsole\.\w+\s*\(/,                 // console logging
];

/**
 * Returns true when the test body's last meaningful line is a non-visual action
 * (assertion, wait, evaluate) — meaning the page hasn't visually changed since
 * the last interaction and a screenshot would be redundant.
 *
 * @param {string|null} playwrightCode - The raw AI-generated code.
 * @returns {boolean}
 */
function endsWithNonVisualAction(playwrightCode) {
  if (!playwrightCode) return false;
  const body = extractTestBody(playwrightCode);
  if (!body) return false;

  // Walk backwards to find the last non-blank, non-comment line
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed === "}" || trimmed === "});") continue;
    return NON_VISUAL_PATTERNS.some(re => re.test(trimmed));
  }
  return false;
}

/**
 * MNT-001b — best-effort locator reconstruction for green-run baseline
 * captures. The runtime helper's full waterfall lives inside the vm
 * sandbox; here we only need to find ONE working locator to crop, so we
 * try the most common label-based forms in priority order. Returns the
 * first locator that resolves to a visible element, or null.
 *
 * We deliberately do NOT use the full healing waterfall — a baseline
 * capture failure is fine (next green run will retry); the risk of a
 * locator factory hanging the post-test cleanup path is not.
 *
 * @param {Object} page    Playwright Page.
 * @param {string} action  "click" | "fill" | "check" | "expect" | …
 * @param {string} label   Human-readable target text / label.
 * @returns {Promise<Object|null>}
 */
async function resolveLocatorForBaseline(page, action, label) {
  if (!page || !label) return null;
  // Per-action shortlist. Mirrors the top-of-waterfall strategies the
  // runtime helper tries first (selfHealing.js:500+). Each candidate is a
  // factory; we resolve to the first match that's actually visible.
  const candidates = (() => {
    switch (action) {
      case "click":
      case "dblclick":
      case "tap":
      case "hover":
      case "rightclick":
      case "press":
        return [
          () => page.getByRole("button", { name: label }),
          () => page.getByRole("link",   { name: label }),
          () => page.getByText(label, { exact: true }),
          () => page.getByText(label),
        ];
      case "fill":
      case "focus":
        return [
          () => page.getByLabel(label),
          () => page.getByPlaceholder(label),
          () => page.getByRole("textbox",   { name: label }),
          () => page.getByRole("searchbox", { name: label }),
        ];
      case "check":
      case "uncheck":
        return [
          () => page.getByRole("checkbox", { name: label }),
          () => page.getByLabel(label),
        ];
      case "select":
        return [
          () => page.getByLabel(label),
          () => page.getByRole("combobox", { name: label }),
        ];
      case "expect":
        return [
          () => page.getByRole("heading", { name: label }),
          () => page.getByText(label, { exact: true }),
          () => page.getByText(label),
        ];
      default:
        return [
          () => page.getByText(label, { exact: true }),
          () => page.getByText(label),
        ];
    }
  })();
  for (const factory of candidates) {
    try {
      const locator = factory();
      // `isVisible()` returns false (no throw) for missing / hidden
      // elements; either way we move on without raising.
      const visible = await locator.first().isVisible().catch(() => false);
      if (visible) return locator.first();
    } catch { /* selector engine threw — try next */ }
  }
  return null;
}

/**
 * MNT-001 — perform the originally-failed verb at the coordinates returned
 * by a successful vision heal. Exported for unit testing; callers in
 * `executeTest` invoke this only after confirming the heal returned a
 * finite bbox.
 *
 * ### IMPORTANT: this is record-keeping, not rescue
 *
 * The test body has already thrown and the vm sandbox has unwound by the
 * time we reach this helper — re-actioning won't resurrect downstream
 * steps in the SAME run. The real win is the NEXT run:
 *
 *   - `recordHealing()` inside `tryVisionHeal` already promoted index 7/8
 *     into the adaptive hint map, so the next run starts there.
 *   - The persisted baseline crop lets stage 7 fire faster + cheaper than
 *     stage 8 on subsequent failures.
 *
 * We perform the re-action anyway so the audit log captures a "we did try
 * to recover" entry, which matters for compliance and for operators
 * investigating why a vision heal "succeeded" but the run still failed.
 *
 * ### Verb coverage
 *
 * Implemented:
 * - `click` / `press` / `tap` → `page.mouse.click(x, y)`
 * - `dblclick`                → `page.mouse.dblclick(x, y)`
 * - `hover`                   → `page.mouse.move(x, y)`
 * - `rightclick`              → `page.mouse.click(x, y, { button: "right" })`
 * - `fill`                    → focus via `mouse.click`, select existing
 *                                text via `keyboard.press("Control+a")`,
 *                                then `keyboard.type(value)`. Requires the
 *                                caller to pass `intent.value` — sourced
 *                                from the sandbox's `__valueIntents` map
 *                                via `err.__valueIntents` in the catch arm.
 *
 * Documented limitations (NOT implemented — concrete justification):
 *
 * - `select` — Playwright's `selectOption()` distinguishes between native
 *   `<select>` (where Playwright sets `.value` programmatically and fires
 *   the `change` event) and ARIA-role custom comboboxes (which need a
 *   click-to-open + click-option-by-text sequence). Telling the two apart
 *   from a bbox alone requires an `elementFromPoint()` round-trip back
 *   into the DOM — which re-introduces exactly the brittleness vision
 *   healing exists to bypass.
 *
 * - `check` / `uncheck` — A coordinate click TOGGLES current state rather
 *   than setting it. An already-checked checkbox getting a `safeCheck`
 *   re-action would UNCHECK it (and vice versa), corrupting every
 *   downstream assertion. Verifying the resulting `.checked` state needs
 *   an `elementFromPoint()` round-trip — same DOM brittleness problem as
 *   `select`. Leaving the test marked failed is the honest outcome until
 *   we have state-aware re-action.
 *
 * - `focus` — Pure coordinate `mouse.click` already lands focus on most
 *   focusable elements; if the test specifically needed `.focus()` for an
 *   element the mouse can't reach (e.g. inside a custom widget with a
 *   `tabindex`), the heal can't help anyway.
 *
 * Coordinate clicks are safer than re-resolving the locator: the pixelmatch
 * / LLM result IS the locator. Going through `elementFromPoint` would
 * re-introduce the DOM brittleness vision healing is meant to bypass.
 *
 * Best-effort: any error is swallowed so a re-action failure can't make
 * an already-failing run any worse.
 *
 * @param {Object} page  Playwright Page (or any object with the same `mouse` / `keyboard` shape — for tests).
 * @param {string} action  Original verb from the healing event key.
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {string} label  Human-readable label (logged for traceability).
 * @param {string} key    Composite healing key (`action::label`) — logged on error.
 * @param {Object} [intent]  Value-intent for value-bearing verbs.
 *   `{ value: string }` for `fill`. When `fill` is dispatched without a
 *   `value` field, the branch is skipped (audit row still records `verb`
 *   + center coords, `dispatched: false`) so a missing intent never lands
 *   an empty string in the field.
 * @returns {Promise<{verb: string, x: number, y: number, dispatched: boolean}>}
 *   Resolves with the dispatched verb + center coords + whether a method
 *   was actually invoked (false for unsupported verbs / non-finite box /
 *   missing value intent). Never throws.
 */
export async function performVisionHealReaction(page, action, box, label, key, intent = {}) {
  const verbLower = String(action || "").toLowerCase();
  const result = { verb: verbLower, x: 0, y: 0, dispatched: false };

  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) ||
      !Number.isFinite(box.width) || !Number.isFinite(box.height)) {
    return result;
  }
  const centerX = Math.round(box.x + box.width / 2);
  const centerY = Math.round(box.y + box.height / 2);
  result.x = centerX;
  result.y = centerY;

  if (!page?.mouse) return result;

  try {
    if (verbLower === "click" || verbLower === "press" || verbLower === "tap") {
      await page.mouse.click(centerX, centerY).catch(() => {});
      result.dispatched = true;
    } else if (verbLower === "dblclick") {
      await page.mouse.dblclick(centerX, centerY).catch(() => {});
      result.dispatched = true;
    } else if (verbLower === "hover") {
      await page.mouse.move(centerX, centerY).catch(() => {});
      result.dispatched = true;
    } else if (verbLower === "rightclick") {
      await page.mouse.click(centerX, centerY, { button: "right" }).catch(() => {});
      result.dispatched = true;
    } else if (verbLower === "fill" && intent && typeof intent.value === "string" && page.keyboard) {
      // MNT-001 — value-aware fill re-action. Three-step sequence:
      //   1. mouse.click(x, y) lands focus on the input that vision matched.
      //   2. keyboard.press("Control+a") selects existing text so the
      //      subsequent type() replaces rather than appends. Playwright maps
      //      Control+a to Cmd+a on macOS automatically.
      //   3. keyboard.type(value) writes the original intended value (sourced
      //      from the sandbox's __valueIntents map at the catch arm).
      // This pattern works for native <input>/<textarea> + most ARIA textbox
      // widgets without re-introducing DOM-locator brittleness. Custom
      // contenteditable rich-text editors may not honour select-all but the
      // worst case is "test stays broken" — same as the no-heal path.
      await page.mouse.click(centerX, centerY).catch(() => {});
      await page.keyboard.press("Control+a").catch(() => {});
      await page.keyboard.type(intent.value).catch(() => {});
      result.dispatched = true;
    }
    // select / check / uncheck / focus intentionally fall through — see
    // "Documented limitations" in the JSDoc above for the concrete
    // reasons each verb is not implemented (NOT because it's deferred to
    // a follow-up ticket — because state-aware re-action requires an
    // elementFromPoint() round-trip that defeats vision healing's purpose).
    if (result.dispatched) {
      console.log(formatLogLine("info", null,
        `[executeTest] Vision heal re-action completed: ${verbLower} at (${centerX},${centerY}) for "${label}"`));
    }
  } catch (reactionErr) {
    // Belt-and-braces — the `.catch(() => {})` inside the if-branches
    // absorbs the typical case. This handles weirdness like the page
    // being closed mid-call (cleanup race).
    console.warn(formatLogLine("warn", null,
      `[executeTest] Vision heal re-action failed for ${key}: ${reactionErr.message}`));
  }
  return result;
}

/**
 * Attach network & console listeners to a page.
 * Returns { networkLogs, consoleLogs, dispose } — the arrays are mutated
 * in-place as events arrive. Call `dispose()` before closing the page to
 * prevent async response handlers from accessing a closed page (which
 * throws unhandled rejections that crash Node.js).
 */
function attachPageListeners(page) {
  const networkLogs = [];
  const consoleLogs = [];
  let closed = false;

  page.on("request", (req) => {
    if (closed) return;
    try {
      networkLogs.push({
        id: uuidv4(),
        method: req.method(),
        url: req.url(),
        startTime: Date.now(),
        status: null,
        size: null,
        duration: null,
      });
    } catch { /* page may be closing */ }
  });

  page.on("response", async (res) => {
    if (closed) return;
    try {
      const entry = networkLogs.find((n) => n.url === res.url() && n.status === null);
      if (entry) {
        entry.status = res.status();
        entry.duration = Date.now() - entry.startTime;
        try {
          const body = await res.body().catch(() => Buffer.alloc(0));
          entry.size = body.length;
        } catch { entry.size = 0; }
      }
    } catch { /* page closed mid-handler — safe to ignore */ }
  });

  page.on("console", (msg) => {
    if (closed) return;
    try {
      consoleLogs.push({ time: new Date().toISOString(), level: msg.type(), text: msg.text() });
    } catch { /* page may be closing */ }
  });

  page.on("pageerror", (err) => {
    if (closed) return;
    try {
      consoleLogs.push({ time: new Date().toISOString(), level: "error", text: err.message });
    } catch { /* page may be closing */ }
  });

  return {
    networkLogs,
    consoleLogs,
    /** Call before page.close() to stop handlers from accessing the closed page. */
    dispose() { closed = true; },
  };
}

/**
 * Extract a clean, UI-safe error message from an Error (or AggregateError).
 */
function formatTestError(err) {
  let rawMsg = err.message || "";
  if ((!rawMsg || rawMsg === "AggregateError") && err.errors?.length) {
    rawMsg = err.errors.map(e => e?.message || String(e)).join("; ");
  }
  // Strip ANSI escape codes so the UI shows clean text
  return rawMsg
    .replace(/\x1B\[[0-9;]*[mGKHF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
}

/**
 * executeTest(test, browser, runId, stepIndex, runStart, opts) → result object
 *
 * Runs a single test case inside a fresh browser context and returns a
 * result object suitable for pushing into run.results.
 *
 * @param {Object}  test
 * @param {Object}  browser      - Playwright Browser instance.
 * @param {string}  runId
 * @param {number}  stepIndex
 * @param {number}  runStart     - `Date.now()` when the run started.
 * @param {Object}  [opts]
 * @param {string}  [opts.browser]    - DIF-002: `"chromium" | "firefox" | "webkit"` (used only to stamp `result.browser`; the Playwright Browser is already launched by the caller).
 * @param {string}  [opts.device]     - DIF-003: Playwright device name (e.g. `"iPhone 14"`).
 * @param {string}  [opts.locale]     - AUTO-007: BCP 47 locale (e.g. `"fr-FR"`).
 * @param {string}  [opts.timezoneId] - AUTO-007: IANA timezone (e.g. `"Europe/Paris"`).
 * @param {Object}  [opts.geolocation] - AUTO-007: `{ latitude, longitude }`.
 * @param {string}  [opts.networkCondition] - AUTO-006: `fast|slow3g|offline`.
 */
export async function executeTest(test, browser, runId, stepIndex, runStart, opts = {}) {
  // ── API-only test path: no browser context needed ──────────────────────
  // Use the cached _isApi flag set by testRunner.js (avoids re-parsing).
  // Fall back to isApiTest() for callers that bypass the runner (e.g. tests).
  const isApi = test._isApi ?? (test.playwrightCode && isApiTest(test.playwrightCode));
  if (isApi) {
    return executeApiTest(test, runId, stepIndex, runStart);
  }

  // ── Browser-based test path — browser must be available ────────────────
  if (!browser) {
    throw new Error(
      `Browser test "${test.name}" requires a browser instance but none was launched. ` +
      `This can happen if the test was misclassified as API-only during batch setup.`
    );
  }

  const testVideoDir = path.join(VIDEOS_DIR, runId, `step${stepIndex}`);
  if (!fs.existsSync(testVideoDir)) fs.mkdirSync(testVideoDir, { recursive: true });

  // DIF-003: Resolve device emulation descriptor (viewport, userAgent, touch, etc.)
  const deviceDescriptor = resolveDevice(opts.device);
  const effectiveViewport = deviceDescriptor?.viewport || { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };

  // AUTO-007: Resolve locale, timezone, and geolocation from run config
  const contextLocale = opts.locale || deviceDescriptor?.locale || undefined;
  const contextTimezone = opts.timezoneId || undefined;
  const contextGeolocation = opts.geolocation || undefined;

  // Build shared context options (everything except recordVideo)
  const contextOpts = {
    // Spread device descriptor first so explicit overrides below take precedence
    ...(deviceDescriptor || {}),
    // Always override these regardless of device profile
    userAgent: deviceDescriptor?.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: effectiveViewport,
    permissions: ["geolocation", "notifications"],
    ignoreHTTPSErrors: true,
    // Enable downloads so page.waitForEvent('download') works (#42)
    acceptDownloads: true,
    // AUTO-007: Locale, timezone, and geolocation context options
    ...(contextLocale ? { locale: contextLocale } : {}),
    ...(contextTimezone ? { timezoneId: contextTimezone } : {}),
    ...(contextGeolocation ? { geolocation: contextGeolocation } : {}),
  };

  // Try creating context with video recording first. If ffmpeg is missing,
  // Playwright throws "Executable doesn't exist at …/ffmpeg-linux" on
  // newContext(). Fall back to no video so the test can still run — a missing
  // ffmpeg should degrade gracefully, not crash the entire test.
  let context;
  let videoEnabled = true;
  try {
    context = await browser.newContext({
      ...contextOpts,
      recordVideo: { dir: testVideoDir, size: { width: effectiveViewport.width, height: effectiveViewport.height } },
    });
  } catch (ctxErr) {
    if (ctxErr.message && ctxErr.message.includes("ffmpeg")) {
      console.warn(formatLogLine("warn", null,
        `[executeTest] ffmpeg not found — video recording disabled. Run "npx playwright install ffmpeg" to enable.`));
      videoEnabled = false;
      context = await browser.newContext(contextOpts);
    } else {
      throw ctxErr;
    }
  }

  // AUTO-017.1: Install web-vitals observers via addInitScript *before* the
  // first page is created, so the observers fire from the first byte of the
  // navigation rather than being injected post-test (which leaves LCP/CLS
  // unreliable or null). Safe no-op when the web-vitals package isn't
  // installed — `captureWebVitals` still returns the empty-metrics shape.
  await registerWebVitalsInitScript(context);

  const page = await context.newPage();

  // AUTO-006: Apply per-run network condition (offline / slow3g / fast).
  // Returns a teardown handle that must run before page.close() so the
  // slow3g route handler is unrouted and doesn't fire on teardown traffic.
  const networkConditionHandle = await applyNetworkCondition({
    networkCondition: opts.networkCondition,
    context,
    page,
  });

  // Auto-accept dialogs (window.alert, confirm, prompt) so they don't hang
  // the test until timeout. Tests that need to dismiss can override with
  // page.on('dialog', d => d.dismiss()) before the triggering action. (#40)
  page.on("dialog", (dialog) => {
    dialog.accept().catch(() => {});
  });

  // DIF-014: Inject animated cursor overlay so the live CDP screencast shows
  // what the test is doing (click ripple, keystroke toast, hover dot).
  // Re-injected after each navigation via the page "load" event.
  await injectCursorOverlay(page);
  page.on("load", () => { injectCursorOverlay(page).catch(() => {}); });

  // Start CDP screencast (returns cleanup fn or null)
  const screencastResult = await startScreencast(page, runId);
  const stopScreencast = screencastResult?.stop ?? null;

  // Attach network / console listeners — dispose() must be called before
  // page.close() to prevent async response handlers from crashing Node.
  const { networkLogs, consoleLogs, dispose: disposeListeners } = attachPageListeners(page);

  const result = {
    testId: test.id,
    testName: test.name,
    steps: test.steps || [],
    status: "passed",
    durationMs: 0,
    error: null,
    screenshot: null,
    screenshotPath: null,
    videoPath: null,
    runTimestamp: 0,
    network: [],
    consoleLogs: [],
    domSnapshot: null,
    boundingBoxes: [],
    stepCaptures: [],   // DIF-016: per-step screenshots
    stepTimings: [],    // DIF-016: per-step timing data
    stepStatuses: [],   // INF-007/UX: authoritative per-step status (passed/failed/running) emitted by the sandbox via __beginStep/__captureStep — replaces the frontend's brittle keyword-matching heuristic.
    visualDiff: null,   // DIF-001: final-screenshot visual-regression result
    browser: opts.browser || "chromium", // DIF-002: browser engine this test ran under
    webVitals: null,
  };

  const start = Date.now();
  result.startedAt = start;

  // Per-test timeout guard — prevents a single hanging test from blocking
  // the worker slot indefinitely during parallel execution.
  // When the timeout fires, we proactively close the page to interrupt any
  // hung Playwright operations (navigation, waitFor, click, etc.). Without
  // this, the Promise.race only detects the timeout but the in-flight
  // Playwright call continues running until the finally block — which may
  // itself hang if Chromium is unresponsive.
  let testTimeoutHandle;
  const testTimeoutPromise = new Promise((_, reject) => {
    testTimeoutHandle = setTimeout(() => {
      // Force-close the page to unblock any hung Playwright operation.
      // This triggers errors inside the testExecution IIFE which are
      // swallowed by the .catch(() => {}) on line below.
      page.close().catch(() => {});
      reject(new Error(`Browser test timed out after ${BROWSER_TEST_TIMEOUT}ms`));
    }, BROWSER_TEST_TIMEOUT);
  });

  try {
    const expect = await getExpect();
    const browserName = opts.browser || "chromium";

    const testExecution = (async () => {
      if (test.playwrightCode && extractTestBody(test.playwrightCode)) {
        // ── PRIMARY PATH: Execute the actual AI-generated Playwright code ──
        const body = extractTestBody(test.playwrightCode);
        const codeAlreadyNavigates = body.includes("page.goto(");

        if (!codeAlreadyNavigates) {
          await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
          await page.waitForTimeout(800);
        }

        const healingScopeId = `${test.id}@v${test.codeVersion || 0}`;
        const healingHints = getHealingHistoryForTest(healingScopeId);
        const codeResult = await runGeneratedCode(page, context, test.playwrightCode, expect, healingHints, {
          onStepCapture: async (stepNumber, _page) => {
            try {
              const shot = await captureScreenshot(_page, runId, stepIndex, { stepNumber });
              // DIF-001: per-step visual regression check against the stored baseline.
              // Best-effort — any failure (missing baseline dir, decode error) is swallowed
              // because a step capture must never break test execution.
              let visualDiff = null;
              try {
                visualDiff = await diffScreenshot({
                  runId,
                  testId: test.id,
                  browser: browserName,
                  stepNumber,
                  pngBuffer: Buffer.from(shot.base64, "base64"),
                });
              } catch { /* ignore */ }
              return { screenshot: shot.base64, screenshotPath: shot.artifactPath, visualDiff };
            } catch { return null; }
          },
        });
        persistHealingEvents(healingScopeId, codeResult.healingEvents);

        // ── MNT-001b: capture per-element baseline crops on green runs ────
        // For every healing event with a healingKey, re-resolve the element
        // via a best-effort locator factory and persist a tight PNG crop.
        // Stage 7 (pixelmatch) reads these on the next failure.
        //
        // Strictly best-effort: any error is swallowed so a baseline-capture
        // failure can never flip an otherwise-passing test. De-duped by key
        // so a multi-action loop touching the same element doesn't trigger
        // N upserts per run.
        if (test.projectId && Array.isArray(codeResult.healingEvents) && codeResult.healingEvents.length > 0) {
          const seenKeys = new Set();
          for (const evt of codeResult.healingEvents) {
            if (!evt || evt.failed || typeof evt.key !== "string") continue;
            if (seenKeys.has(evt.key)) continue;
            seenKeys.add(evt.key);
            const [action, ...rest] = evt.key.split("::");
            const label = rest.join("::");
            try {
              const locator = await resolveLocatorForBaseline(page, action, label);
              if (!locator) continue;
              const cropPng = await captureElementCrop(page, locator);
              if (!cropPng) continue;
              // Parse dimensions from the PNG header so the DB row has
              // dimensions ready for stage-7 fit checks without re-decoding.
              let cropWidth = 0;
              let cropHeight = 0;
              try {
                const meta = PNG.sync.read(cropPng);
                cropWidth = meta.width;
                cropHeight = meta.height;
              } catch { /* malformed → skip persistence */ continue; }
              elementBaselineRepo.upsert({
                projectId: test.projectId,
                healingKey: `${healingScopeId}::${evt.key}`,
                cropPng,
                cropWidth,
                cropHeight,
                capturedAt: new Date().toISOString(),
              });
            } catch (baselineErr) {
              // Single-event failure must never propagate. Log at debug
              // level (warn) so operators can investigate hot keys without
              // it dominating run logs.
              console.warn(formatLogLine("warn", null,
                `[executeTest] Baseline capture failed for ${evt.key}: ${baselineErr.message}`));
            }
          }
        }

        // Collect per-step captures and timings from the instrumented run
        result.stepCaptures = codeResult.stepCaptures || [];
        result.stepTimings = codeResult.stepTimings || [];
        result.stepStatuses = codeResult.stepStatuses || [];

      } else {
        // ── FALLBACK: No parseable code — run a basic smoke test ───────────
        await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
        await page.waitForTimeout(500);

        const title = await page.title();
        if (!title) throw new Error("Page has no title — possible load failure");

        const url = page.url();
        if (!url.startsWith("http")) throw new Error("Invalid URL after navigation");
      }

      // S3-02: Wait for DOM to settle before capturing artifacts or asserting.
      // SPAs, streaming responses, and skeleton screens mutate the DOM
      // unpredictably after the last interaction. waitForStable() uses a
      // MutationObserver to detect when the page has gone quiet for 2 s,
      // preventing screenshots and assertions from running on half-rendered UIs.
      // On timeout (30 s) it returns gracefully — the test can still pass.
      await waitForStable(page);

      // Capture artifacts on success.
      // Skip screenshot / DOM snapshot / bounding boxes when the test ends
      // with a non-visual action (assertion, wait, evaluate) — the page
      // hasn't visually changed so these artifacts are redundant. This saves
      // ~50-200ms per test. Failure screenshots are always captured regardless.
      const skipVisualArtifacts = endsWithNonVisualAction(test.playwrightCode);

      // AUTO-017: Web Vitals capture is independent of visual-artifact gating.
      // Performance metrics (LCP / CLS / INP / TTFB) must be collected for every
      // successful test regardless of whether the test ends on an assertion,
      // otherwise budget evaluation silently skips slow tests that happen to end
      // on `expect(...)`. Best-effort — failures never flip a passing test.
      try {
        result.webVitals = await captureWebVitals(page);
      } catch { /* best-effort */ }

      if (!skipVisualArtifacts) {
        result.domSnapshot = await captureDomSnapshot(page);

        // Success-path artifact capture is best-effort: a transient S3
        // upload failure inside captureScreenshot (or any other artifact
        // helper) must not flip an otherwise-passing test to "failed".
        // Each block is guarded independently so one failure doesn't
        // cascade into the next.
        let shot = null;
        try {
          shot = await captureScreenshot(page, runId, stepIndex);
          result.screenshot = shot.base64;
          result.screenshotPath = shot.artifactPath;
        } catch (shotErr) {
          console.warn(formatLogLine("warn", null,
            `[executeTest] Success-path screenshot capture failed for step ${stepIndex}: ${shotErr.message}`));
        }

        // DIF-001: Diff the final screenshot against the test's baseline
        // (stepNumber 0 is reserved for the end-of-test capture).
        if (shot) {
          try {
            result.visualDiff = await diffScreenshot({
              runId,
              testId: test.id,
              browser: browserName,
              stepNumber: 0,
              pngBuffer: Buffer.from(shot.base64, "base64"),
            });
          } catch { /* visual diff is best-effort */ }
        }

        try {
          result.boundingBoxes = await captureBoundingBoxes(page);
        } catch { /* bounding-box capture is best-effort */ }
      }
    })();

    // Swallow the losing promise to prevent unhandled rejection
    testExecution.catch(() => {});
    await Promise.race([testExecution, testTimeoutPromise]);

  } catch (err) {
    result.status = "failed";
    result.error = formatTestError(err);

    // Persist healing events from the failed run
    const healingScopeId = `${test.id}@v${test.codeVersion || 0}`;

    // Collect any per-step captures/timings gathered before the failure
    result.stepCaptures = err.__stepCaptures || [];
    result.stepTimings = err.__stepTimings || [];
    result.stepStatuses = err.__stepStatuses || [];

    // Screenshot the failure state — also feeds the vision-healing waterfall below.
    let failureShot = null;
    try {
      const shot = await captureScreenshot(page, runId, stepIndex, { failed: true });
      result.screenshot = shot.base64;
      result.screenshotPath = shot.artifactPath;
      failureShot = Buffer.from(shot.base64, "base64");
    } catch { /* page may be closed */ }

    // ── MNT-001: host-side vision-healing waterfall (stages 7-8) ───────────
    // Invoked AFTER the runtime helper waterfall (stages 0-6) failed.
    // Best-effort: any internal error is swallowed; a vision-heal never
    // *causes* a test failure that wouldn't already have happened.
    //
    // The failing locator is the last "failed" event in __healingEvents
    // (every run emits exactly one failed entry per broken element thanks
    // to the runtime helper). We attempt heal on each failed event so a
    // multi-step test that breaks on more than one selector gets a heal
    // attempt per breakage.
    const visionEvents = [];
    try {
      const failedEvents = (err.__healingEvents || []).filter((e) => e?.failed && typeof e.key === "string");
      if (failedEvents.length > 0 && failureShot) {
        // Load project's vision config once; null-safe so a misconfigured
        // run (project deleted mid-execution, db blip) skips stages 7-8.
        let project = null;
        try { project = test.projectId ? projectRepo.getById(test.projectId) : null; } catch { /* ignore */ }
        if (project && project.visionHealing && project.visionHealing !== "off") {
          for (const evt of failedEvents) {
            const [action, ...rest] = evt.key.split("::");
            const label = rest.join("::");
            // MNT-001b — load the last-known baseline crop for stage 7 by
            // the same composite key the green-run capture hook writes
            // (`${healingScopeId}::${evt.key}`). Missing rows are normal
            // (first-ever failure for this element) and degrade gracefully:
            // `tryVisionHeal` skips stage 7 when baselineCrop is null.
            let baselineCrop = null;
            try {
              const row = test.projectId
                ? elementBaselineRepo.get(test.projectId, `${healingScopeId}::${evt.key}`)
                : null;
              baselineCrop = row?.cropPng ?? null;
            } catch { /* repo blip — fall through to no baseline */ }

            const heal = await tryVisionHeal({
              testId: healingScopeId,
              action, label, project,
              failureScreenshot: failureShot,
              baselineCrop,
            }, {
              pixelmatchHeal,
              llmVisionHeal,
              isBudgetExhausted: visionBudgetRepo.isBudgetExhausted,
            });
            if (heal?.kind === "vision_budget_exhausted") {
              // MNT-001b — stage 8 soft-disable. Emit audit + Prometheus
              // BEFORE filtering out so operators can attribute the skip
              // (intentional cap hit? raise the cap? provider misconfig?).
              // NOT pushed onto visionEvents — persistHealingEvents would
              // either undercount the failed-event arm or, worse, ignore
              // it entirely; the dedicated audit row + counter ARE the
              // record for budget-exhausted events.
              try {
                visionHealBudgetExhaustedTotal.inc({
                  projectId: test.projectId || "unknown",
                  reason: heal.reason,
                });
              } catch (metricErr) {
                console.warn(formatLogLine("warn", null,
                  `[executeTest] Failed to bump vision budget metric: ${metricErr.message}`));
              }
              try {
                logActivity({
                  type: "healing.vision_budget_exhausted",
                  projectId: test.projectId,
                  projectName: project.name,
                  workspaceId: project.workspaceId,
                  testId: test.id,
                  testName: test.name,
                  detail: `Vision-heal stage 8 skipped — ${heal.reason} cap reached`,
                  meta: { reason: heal.reason, key: heal.key },
                });
              } catch (auditErr) {
                console.warn(formatLogLine("warn", null,
                  `[executeTest] Failed to log vision budget audit row: ${auditErr.message}`));
              }
              console.warn(formatLogLine("warn", null,
                `[executeTest] Vision heal budget exhausted for ${test.projectId} (${heal.reason}) — stage 8 skipped for "${label}"`));
            } else if (heal) {
              visionEvents.push(heal);
              // Record LLM-vision spend against the project's budget so
              // the next stage-8 attempt sees the increment. Pixelmatch
              // is free (cost = 0) and skipped automatically.
              if (heal.kind === "vision_llm" && test.projectId) {
                try {
                  visionBudgetRepo.record(test.projectId, heal.costUsd || 0);
                } catch (budgetErr) {
                  console.warn(formatLogLine("warn", null,
                    `[executeTest] Failed to record vision-heal budget for ${test.projectId}: ${budgetErr.message}`));
                }
              }
              console.log(formatLogLine("info", null,
                `[executeTest] Vision heal succeeded for ${test.id} (${heal.kind}, confidence=${heal.confidence?.toFixed?.(2) ?? heal.confidence})`));

              // MNT-001 — coordinate re-action. See `performVisionHealReaction`
              // jsdoc above for the design rationale (record-keeping vs.
              // rescue-the-run semantics).
              //
              // Value-bearing verbs (currently just `fill`) need the original
              // intended value, which the sandboxed safe* helpers recorded
              // into __valueIntents keyed by "<action>::<label>" — i.e. evt.key.
              // The map is surfaced onto the thrown error in codeExecutor.js.
              // Missing intent (e.g. click verb, or fill without a recorded
              // value) falls through harmlessly: the reaction skips the fill
              // branch and the audit row records `dispatched: false`.
              if (heal.box && Number.isFinite(heal.box.x) && Number.isFinite(heal.box.y)) {
                const valueIntent = (err.__valueIntents || {})[evt.key];
                await performVisionHealReaction(page, action, heal.box, label, evt.key, valueIntent);
              }
            }
          }
        }
      }
    } catch (visionErr) {
      console.warn(formatLogLine("warn", null,
        `[executeTest] Vision-healing waterfall failed for ${test.id}: ${visionErr.message}`));
    }

    // Combine runtime + vision events for persistence. Vision events are
    // distinguished by `kind: "vision_pixelmatch" | "vision_llm"` so
    // `persistHealingEvents` can route them to the vision counters.
    persistHealingEvents(healingScopeId, [
      ...(err.__healingEvents || []),
      ...visionEvents,
    ]);

  } finally {
    clearTimeout(testTimeoutHandle);

    // Capture the final page URL for the frontend BrowserChrome
    try { result.url = page.url(); } catch { /* page already closed */ }
    if (!result.url || result.url === "about:blank") result.url = test.sourceUrl || "";

    result.durationMs = Date.now() - start;
    result.runTimestamp = start - runStart;
    result.network = networkLogs;
    result.consoleLogs = consoleLogs;

    // Stop CDP screencast before closing the page
    if (stopScreencast) await stopScreencast();

    // Signal listeners to stop before closing — prevents async response
    // handlers from calling res.url()/res.status() on a closed page,
    // which would throw an unhandled rejection and crash Node.js.
    disposeListeners();

    // Close any popup / new-tab pages opened during the test so they don't
    // leak browser memory. context.pages() includes the main page — skip it
    // and close everything else. (#41)
    for (const p of context.pages()) {
      if (p !== page) await p.close().catch(() => {});
    }

    // AUTO-006: Tear down network-condition state (e.g. slow3g route handler)
    // before closing the page so it doesn't fire on in-flight teardown requests.
    await networkConditionHandle.teardown();

    // Close page first then context — this flushes video to disk
    await page.close().catch(() => {});
    await context.close().catch(() => {});

    // Move the video to a stable named path (skip when ffmpeg was missing)
    if (videoEnabled) {
      try {
        const files = fs.readdirSync(testVideoDir).filter(f => f.endsWith(".webm"));
        if (files.length > 0) {
          const src = path.join(testVideoDir, files[0]);
          const videoName = `${runId}-step${stepIndex}.webm`;
          const dst = path.join(VIDEOS_DIR, videoName);
          // writeArtifactBuffer always persists to local disk first
          // (objectStorage.js:62-63), so if the optional S3 upload fails
          // the artifact is still available via the local path. Mirror the
          // trace handling pattern in testRunner.js: swallow upload errors
          // here so cleanup and videoPath assignment still run.
          try {
            await writeArtifactBuffer({
              artifactPath: `/artifacts/videos/${videoName}`,
              absolutePath: dst,
              buffer: fs.readFileSync(src),
              contentType: "video/webm",
            });
          } catch (uploadErr) {
            // If writeArtifactBuffer threw before the local write completed,
            // dst won't exist — preserve src by renaming it as a last-resort
            // fallback so we don't lose the only copy of the video.
            if (!fs.existsSync(dst)) {
              try { fs.renameSync(src, dst); } catch { /* ignore */ }
            }
            console.warn(formatLogLine("warn", null,
              `[executeTest] S3 video upload failed for step ${stepIndex}, falling back to local path: ${uploadErr.message}`));
          }
          if (fs.existsSync(src)) fs.unlinkSync(src);
          if (fs.existsSync(dst)) result.videoPath = `/artifacts/videos/${videoName}`;
        }
        fs.rmSync(testVideoDir, { recursive: true, force: true });
      } catch (videoErr) {
        console.warn(formatLogLine("warn", null, `[executeTest] Video move failed for step ${stepIndex}: ${videoErr.message}`));
      }
    } else {
      // No video was recorded — clean up the empty directory
      try { fs.rmSync(testVideoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  return result;
}

/**
 * executeApiTest(test, runId, stepIndex, runStart) → result object
 *
 * Runs an API-only test (one that uses `request.newContext()`) without
 * spinning up a browser page. Skips screenshots, video, DOM snapshots,
 * and screencast — none of which apply to API tests.
 */
async function executeApiTest(test, runId, stepIndex, runStart) {
  const result = {
    testId: test.id,
    testName: test.name,
    steps: test.steps || [],
    status: "passed",
    durationMs: 0,
    error: null,
    screenshot: null,
    screenshotPath: null,
    videoPath: null,
    runTimestamp: 0,
    network: [],
    consoleLogs: [],
    domSnapshot: null,
    boundingBoxes: [],
    url: test.sourceUrl || "",
    isApiTest: true,
  };

  const start = Date.now();
  result.startedAt = start;

  // AbortController lets us forcibly dispose Playwright request contexts
  // inside runApiTestCode when the timeout fires, preventing lingering
  // HTTP connections from leaking in the background.
  const ac = new AbortController();
  let timeoutHandle;

  try {
    const expect = await getExpect();
    const apiPromise = runApiTestCode(test.playwrightCode, expect, { signal: ac.signal });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        ac.abort(new Error(`API test timed out after ${API_TEST_TIMEOUT}ms`));
        reject(new Error(`API test timed out after ${API_TEST_TIMEOUT}ms`));
      }, API_TEST_TIMEOUT);
    });
    // Swallow the losing promise's rejection to prevent unhandled rejection
    // crashes in Node.js v15+. When the timeout wins, apiPromise continues
    // running until the abort signal disposes its contexts — its eventual
    // rejection must be caught here so it doesn't crash the process.
    apiPromise.catch(() => {});
    const apiResult = await Promise.race([apiPromise, timeoutPromise]);
    // Populate network logs from the instrumented API request context
    result.network = apiResult.apiLogs || [];
  } catch (err) {
    result.status = "failed";
    result.error = formatTestError(err);
    // Capture any API logs collected before the failure
    result.network = err.__apiLogs || [];
  } finally {
    clearTimeout(timeoutHandle);
    result.durationMs = Date.now() - start;
    result.runTimestamp = start - runStart;
  }

  return result;
}


/**
 * CAP-001: run `runSingle(iterTest)` once per fixture row, substituting
 * `{{key}}` placeholders in `playwrightCode` from the row values. When
 * `fixtureRows` is empty/missing the test runs once unchanged (zero-
 * regression contract — fixture-less tests behave exactly as before).
 *
 * Every iteration runs to completion so failures are attributable to a
 * specific row (`NEXT.md` acceptance criterion: "5-row CSV → 5 iteration
 * results"). Each result carries `iterationIndex` + `fixtureRow` snapshot
 * so the run UI can surface per-row attribution; callers decide retry/abort
 * semantics based on the returned array.
 *
 * @param {Object} test
 * @param {Array<Object>|undefined} fixtureRows
 * @param {function(Object): Promise<Object>} runSingle
 * @returns {Promise<Array<Object>>}
 */
export async function executeTestIterations(test, fixtureRows, runSingle) {
  const rows = Array.isArray(fixtureRows) && fixtureRows.length ? fixtureRows : [null];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const iterTest = row
      ? {
          ...test,
          playwrightCode: Object.entries(row).reduce(
            (code, [k, v]) => String(code || "").replaceAll(`{{${k}}}`, String(v ?? "")),
            test.playwrightCode || "",
          ),
        }
      : test;
    const iterResult = await runSingle(iterTest);
    if (row) {
      iterResult.iterationIndex = i;
      iterResult.fixtureRow = row;
    }
    out.push(iterResult);
  }
  return out;
}

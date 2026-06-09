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
import fsp from "fs/promises";
import os from "os";
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
import { snapshotServerCoverage, diffServerCoverage } from "../pipeline/serverCoverageProxy.js"; // AUTO-009h — opt-in server-side coverage capture for API tests.
// B4 (AUDIT-ROADMAP) / RLY-004 — mid-run auth-session recovery. The check
// fires after every `page.goto()` AND when the test errors out so we can
// distinguish "the SUT logged the test out" from "the test code is broken"
// — see the call sites below for the gating logic. Both helpers are
// loaded lazily (top-level await is avoided so this file stays
// require-compatible) — they're pure functions of the page + project.
import { looksLikeAuthRedirect, restoreAuthSession } from "../pipeline/autoLogin.js";
// AUDIT-ROADMAP Bundle 6 — seeded faker substitution (QAL-010) +
// setup/teardown hooks (QAL-002). Loaded at import time because both are
// pure modules with no heavy side-effects; `createFaker` itself
// dynamically imports `@faker-js/faker` only when first called.
import { createFaker } from "../utils/fakeDataGenerator.js";


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
 * Bundle-B fix #4 — ring-buffer cap on accumulated network log entries.
 * Long-running tests on chatty SPAs were unbounded — a single test could
 * accumulate tens of thousands of entries and OOM the worker. With the
 * cap, the oldest entry is evicted on each push when the buffer is full.
 * 500 entries is enough to cover the most network-heavy real-world test
 * we've measured (a checkout flow with retries) and bounds memory at
 * ~250 KB per run.
 */
const MAX_NETWORK_LOG_ENTRIES = 500;

/**
 * Attach network & console listeners to a page.
 * Returns { networkLogs, consoleLogs, dispose } — the arrays are mutated
 * in-place as events arrive. Call `dispose()` before closing the page to
 * prevent async response handlers from accessing a closed page (which
 * throws unhandled rejections that crash Node.js).
 */
function attachPageListeners(page) {
  const networkLogs = [];
  // Bundle-B fix #1 — pair request/response by the Playwright Request object,
  // not by URL. Two concurrent same-URL requests with staggered responses
  // were corrupting each other's entries with the previous URL-string match.
  // The Request → entry map gives a stable identity even when the URL collides.
  const requestEntries = new WeakMap();
  const consoleLogs = [];
  let closed = false;

  page.on("request", (req) => {
    if (closed) return;
    try {
      const entry = {
        id: uuidv4(),
        method: req.method(),
        url: req.url(),
        startTime: Date.now(),
        status: null,
        size: null,
        duration: null,
      };
      // Bundle-B fix #4 — evict oldest entry when the ring buffer is full.
      if (networkLogs.length >= MAX_NETWORK_LOG_ENTRIES) {
        networkLogs.shift();
      }
      networkLogs.push(entry);
      requestEntries.set(req, entry);
    } catch { /* page may be closing */ }
  });

  page.on("response", async (res) => {
    if (closed) return;
    try {
      // Bundle-B fix #1 — look up the entry by Request identity. Falls back
      // to URL-match for response events whose request never fired (extremely
      // rare, e.g. cached service-worker responses); the prior URL-only path
      // is preserved as fallback so behaviour stays a strict superset.
      let entry = requestEntries.get(res.request());
      if (!entry) {
        entry = networkLogs.find((n) => n.url === res.url() && n.status === null);
      }
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
 * @param {boolean} [opts.coverageEnabled] - AUTO-009 / AUTO-009k: project's
 *   coverage capture toggle, forwarded from `testRunner.js` so the per-test
 *   path doesn't re-issue `projectRepo.getById()` once per test (N+1 SQLite
 *   read on parallel runs). When omitted, falls back to a per-test repo
 *   lookup for backward compatibility with callers that bypass the runner
 *   (legacy tests, future direct callsites). Treat `undefined` as "not
 *   supplied" so the fallback path engages; `false` means "explicitly off".
 * @param {string}  [opts.serverCoverageEndpoint] - AUTO-009h: per-project
 *   endpoint for server-side coverage capture, same forwarding pattern as
 *   `coverageEnabled`. Only consumed by `executeApiTest`.
 * @param {number}  [opts.adaptiveTimeout] - AUDIT-ROADMAP B2: adaptive element
 *   timeout (ms) computed once per run by `testRunner.js` from the crawl's
 *   p95 page-load time, clamped to `[HEALING_ELEMENT_TIMEOUT, MAX_ELEMENT_TIMEOUT]`.
 *   Forwarded into the vm sandbox via `runGeneratedCode` so every self-
 *   healing helper (`safeClick`, `safeFill`, etc.) uses this timeout
 *   instead of the env default. When omitted, the runtime helper falls
 *   back to the env default and pre-B2 behaviour is preserved.
 */
/**
 * AUDIT-ROADMAP Bundle 6 — pre-execution transforms.
 *
 * Three transforms applied in order:
 *
 *  1. **Faker token substitution (QAL-010)** — replace every `__FAKE_*__` /
 *     `__TIMESTAMP__` token in `playwrightCode` + `setupCode` +
 *     `teardownCode` with a deterministic seeded value via
 *     `utils/fakeDataGenerator.createFaker`. Same `(runId, testId)` seed
 *     produces the same values across retries within a run; different
 *     runs see different values so re-running on the same DB doesn't trip
 *     UNIQUE constraints from a prior pass.
 *
 *  2. **Setup-code injection (QAL-002)** — prepend `setupCode` inside
 *     the test body so it runs BEFORE the first assertion. The runtime
 *     helper wrapper that `runGeneratedCode` builds already wraps the
 *     code in an async IIFE, so a non-empty setup block becomes the
 *     first statement of the body. Errors in setup propagate normally —
 *     a failed precondition fails the test.
 *
 *  3. **Teardown-code injection (QAL-002)** — wrap the test body in a
 *     `try { … } finally { … }` so teardown ALWAYS runs (test passed,
 *     test failed, test threw). Errors in teardown are swallowed and
 *     logged — cleanup MUST NOT mask a real test failure (per the spec
 *     at `docs/roadmap/AUDIT-ROADMAP.md:854-855`).
 *
 * The returned test object is a shallow copy — never mutates the caller's
 * row. When all three transforms are no-ops (no tokens, no setup, no
 * teardown) the original test is returned unchanged.
 *
 * @param {Object} test
 * @param {string} runId
 * @param {Object} opts
 * @param {string} [opts.testDataLocale]
 * @returns {Promise<Object>}
 */
export async function applyB6PreExecutionTransforms(test, runId, opts = {}) {
  if (!test || typeof test.playwrightCode !== "string") return test;
  const hasSetup    = typeof test.setupCode === "string" && test.setupCode.trim().length > 0;
  const hasTeardown = typeof test.teardownCode === "string" && test.teardownCode.trim().length > 0;
  // Cheap early-out: avoid the dynamic faker import + clone for the
  // common case (no tokens, no setup, no teardown). The token check is a
  // bare substring scan — much cheaper than the full split/join loop
  // inside `createFaker#substitute`.
  const hasFakerToken = test.playwrightCode.indexOf("__FAKE_") !== -1
    || test.playwrightCode.indexOf("__TIMESTAMP__") !== -1
    || (hasSetup    && (test.setupCode.indexOf("__FAKE_") !== -1    || test.setupCode.indexOf("__TIMESTAMP__") !== -1))
    || (hasTeardown && (test.teardownCode.indexOf("__FAKE_") !== -1 || test.teardownCode.indexOf("__TIMESTAMP__") !== -1));
  if (!hasSetup && !hasTeardown && !hasFakerToken) return test;

  const next = { ...test };
  if (hasFakerToken) {
    try {
      const faker = await createFaker({
        runId,
        testId: opts.testId || test.id || "unknown",
        locale: opts.testDataLocale || "en",
      });
      // Substitute ALL three code blocks in a single `substitute()` call
      // by concatenating with a unique separator, then splitting back.
      // This ensures the SAME token (e.g. `__FAKE_EMAIL__`) resolves to
      // the SAME value across setupCode, playwrightCode, and teardownCode
      // — the faker PRNG advances once per token type per call, so
      // calling `substitute()` three times independently would produce
      // different values for the same token across blocks (the PRNG
      // state advances between calls). Industry expectation: "fill email
      // with __FAKE_EMAIL__" in setup and "expect text __FAKE_EMAIL__"
      // in the main body must resolve to the same address.
      const SEP = "\n/* __B6_CODE_BOUNDARY__ */\n";
      const combined = [
        next.playwrightCode,
        hasSetup ? next.setupCode : "",
        hasTeardown ? next.teardownCode : "",
      ].join(SEP);
      const substituted = faker.substitute(combined);
      const parts = substituted.split(SEP);
      next.playwrightCode = parts[0];
      if (hasSetup)    next.setupCode    = parts[1];
      if (hasTeardown) next.teardownCode = parts[2];
    } catch (err) {
      // Best-effort: a faker substitution failure must never block the
      // test. Operators get the warn line; the test runs with raw
      // tokens (which will fail the first assertion that compares
      // against literal placeholder text — a clear signal that
      // substitution didn't happen, easier to debug than silently
      // succeeding on a token-as-data run).
      console.warn(formatLogLine("warn", runId,
        `[executeTest] B6 faker substitution failed for ${test.id || "?"}: ${err?.message || err}`));
    }
  }

  // Setup / teardown injection — wrap the existing test body so:
  //   await page.goto(...)         <- original body line 1
  //   await safeClick(...)         <- original body line 2
  // becomes:
  //   await (async () => { <setupCode> })();
  //   try {
  //     await page.goto(...)
  //     await safeClick(...)
  //   } finally {
  //     try { await (async () => { <teardownCode> })(); }
  //     catch (e) { console.warn('⚠ Teardown error (swallowed): ' + e?.message); }
  //   }
  //
  // The injection happens INSIDE the test's async function body via a
  // string-level transform on `playwrightCode`. We locate the body via
  // `extractTestBody` (which already handles `test('name', async ({ page }) => { ... })`
  // and the bare-IIFE shapes); if extraction fails (unusual codegen
  // output, raw script), fall through and let the runner handle it
  // without injection — better to ship a test without B6 hooks than to
  // corrupt syntactically novel code.
  if (hasSetup || hasTeardown) {
    const originalBody = extractTestBody(next.playwrightCode);
    if (originalBody) {
      const setupPrefix = hasSetup
        ? `await (async () => {\n${next.setupCode}\n})();\n`
        : "";
      const teardownSuffix = hasTeardown
        ? `try { await (async () => {\n${next.teardownCode}\n})(); } catch (__teardownErr) { try { console.warn('⚠ Teardown error (swallowed): ' + (__teardownErr && __teardownErr.message || __teardownErr)); } catch {} }`
        : "";
      const newBody = hasTeardown
        ? `${setupPrefix}try {\n${originalBody}\n} finally {\n${teardownSuffix}\n}`
        : `${setupPrefix}${originalBody}`;
      // Splice via indexOf + slice (NOT String.prototype.replace) — the
      // replacement string `newBody` embeds `originalBody`, which is
      // LLM-generated Playwright code that can contain `$&` / `$'` /
      // `` $` `` sequences (common in `str.replace(/pat/, "$&-suffix")`
      // regex-replacement expressions). `replace()` would expand those
      // `$`-patterns in the replacement, silently producing broken test
      // code. Position-based slicing is literal — no `$` interpretation.
      const bodyIdx = next.playwrightCode.indexOf(originalBody);
      if (bodyIdx !== -1) {
        next.playwrightCode = next.playwrightCode.slice(0, bodyIdx)
          + newBody
          + next.playwrightCode.slice(bodyIdx + originalBody.length);
      }
    }
  }

  return next;
}

export async function executeTest(test, browser, runId, stepIndex, runStart, opts = {}) {
  // ── AUDIT-ROADMAP B6 — pre-execution test transforms ─────────────────────
  // QAL-010 faker substitution + QAL-002 setup/teardown injection happen
  // ONCE at the function entry so every downstream path (API tests, browser
  // tests, the fallback smoke path, `runApiTestCode`) sees the same
  // resolved code. The transforms are idempotent: tests with no faker
  // tokens and no setup/teardown carry through bit-for-bit, so legacy
  // (pre-B6) tests stay byte-identical (acceptance criterion at
  // `docs/roadmap/AUDIT-ROADMAP.md:858-859`).
  //
  // Locale: prefer `opts.testDataLocale` (forwarded once per run by
  // `testRunner.js`) over a per-test `projectRepo.getById()` round-trip;
  // matches the same pattern `coverageEnabled` / `serverCoverageEndpoint`
  // already use to avoid N+1 SQLite reads on parallel runs.
  test = await applyB6PreExecutionTransforms(test, runId, opts);

  // ── API-only test path: no browser context needed ──────────────────────
  // Use the cached _isApi flag set by testRunner.js (avoids re-parsing).
  // Fall back to isApiTest() for callers that bypass the runner (e.g. tests).
  const isApi = test._isApi ?? (test.playwrightCode && isApiTest(test.playwrightCode));
  if (isApi) {
    return executeApiTest(test, runId, stepIndex, runStart, opts);
  }

  // ── Browser-based test path — browser must be available ────────────────
  // Bundle-B fix #5 — health-probe the supplied browser before doing any
  // work. A disconnected browser (CDP socket dead, child process crashed,
  // OOM kill) used to surface as a cryptic "Target closed" deep inside
  // newContext. Surfacing a structured error here lets the parent runner
  // recognise it (`err.code === "ERR_BROWSER_DISCONNECTED"`), restart the
  // browser, and retry the test once instead of marking it failed.
  if (!browser) {
    const e = new Error(
      `Browser test "${test.name}" requires a browser instance but none was launched. ` +
      `This can happen if the test was misclassified as API-only during batch setup.`
    );
    e.code = "ERR_BROWSER_MISSING";
    throw e;
  }
  if (typeof browser.isConnected === "function" && !browser.isConnected()) {
    const e = new Error(
      `Browser is disconnected before test "${test.name}" could start — parent runner should restart browser and retry once.`
    );
    e.code = "ERR_BROWSER_DISCONNECTED";
    e.recoverable = true;
    throw e;
  }

  const testVideoDir = path.join(VIDEOS_DIR, runId, `step${stepIndex}`);
  if (!fs.existsSync(testVideoDir)) fs.mkdirSync(testVideoDir, { recursive: true });

  // Bundle-B fix #6 — per-run downloads directory. Without this, Playwright
  // writes downloaded files to the OS temp dir under a single Playwright-
  // owned path that bleeds across parallel runs and never gets cleaned. A
  // per-run dir scoped under os.tmpdir() lets us wipe it deterministically
  // in the cleanup hook below regardless of test outcome.
  const testDownloadsDir = path.join(os.tmpdir(), "sentri-downloads", runId, `step${stepIndex}`);
  if (!fs.existsSync(testDownloadsDir)) fs.mkdirSync(testDownloadsDir, { recursive: true });

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
    // Bundle-B fix #6 — scope downloads to the per-run dir created above so
    // the cleanup hook can wipe them without colliding with parallel runs.
    downloadsPath: testDownloadsDir,
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

  // Outer guard: if ANY setup between context creation (above) and the inner
  // try-block at line ~684 throws, the pool slot must be released. Without
  // this, a crash in registerWebVitalsInitScript / newPage /
  // applyNetworkCondition / injectCursorOverlay / startScreencast would
  // permanently leak a slot (`bucket.inUse` stays incremented, context stays
  // in `bucket.contexts`) until the pool drains at process shutdown.
  // The inner try-finally at ~684 handles the normal + test-failure paths;
  // this outer wrapper catches the setup-failure gap.
  try {

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

  // Start CDP screencast (returns cleanup fn or null).
  //
  // BUG-0001 / BUG-0004 — held by `let` (not `const`) so the timeout
  // handler below can null it out after firing the stop. That prevents
  // the `finally` block from calling `stopScreencast()` a second time
  // (which would send CDP commands on an already-detached session and
  // log a duplicate "[screencast] stopped" line).
  const screencastResult = await startScreencast(page, runId);
  let stopScreencast = screencastResult?.stop ?? null;

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
    jsCoverage: null,
  };

  // AUTO-009 — start V8 JS coverage BEFORE the test navigates so the first
  // byte of the SUT bundle is instrumented. Opt-in per project; failures
  // are best-effort and never flip a passing test.
  //
  // Prefer `opts.coverageEnabled` (forwarded from testRunner.js once per
  // run) to avoid a per-test `projectRepo.getById()` round-trip — on a
  // 200-test parallel run that's 200 SQLite reads saved. Falls back to
  // the repo lookup for callers that don't forward (backward compat).
  let coverageStarted = false;
  try {
    const covEnabled = opts.coverageEnabled !== undefined
      ? opts.coverageEnabled
      : (() => { try { return projectRepo.getById(test.projectId)?.coverageEnabled; } catch { return false; } })();
    if (covEnabled && page?.coverage?.startJSCoverage) {
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
      coverageStarted = true;
    }
  } catch { /* best-effort */ }

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
  // B4 / RLY-004 — proactive session keep-alive ticker handle, declared
  // at function scope so the `finally` block below can clear it. Stays
  // `null` for projects without `sessionRefreshIntervalMs` configured —
  // the existing per-test cleanup path is bit-for-bit identical to the
  // pre-B4 behaviour for those (the vast majority of) projects.
  let sessionRefreshTicker = null;
  let sessionRefreshInFlight = false;
  const testTimeoutPromise = new Promise((_, reject) => {
    testTimeoutHandle = setTimeout(() => {
      // BUG-0001 — Reject FIRST (synchronously) so `Promise.race` resolves
      // within BROWSER_TEST_TIMEOUT regardless of what the cleanup work
      // below does. The previous shape `async () => { await
      // stopScreencast(); ...; reject(); }` could hang forever when
      // Chromium itself was the hung party (the exact scenario this
      // timeout is meant to recover from), because `stopScreencast`
      // sends CDP commands and the CDP socket was dead.
      reject(new Error(`Browser test timed out after ${BROWSER_TEST_TIMEOUT}ms`));

      // Then trigger cleanup as best-effort fire-and-forget. Order
      // matters: stop the screencast BEFORE the page close because the
      // CDP session becomes invalid the moment the page is gone.
      //
      // BUG-0004 — Null the reference after firing so the `finally`
      // block's `if (stopScreencast)` check skips the second call.
      // Without this, the same CDP detach fires twice on every
      // timed-out test (harmless thanks to catch guards in
      // screencast.js, but produces duplicate "[screencast] stopped"
      // log lines that confuse on-call engineers).
      const _stop = stopScreencast;
      stopScreencast = null;
      Promise.resolve()
        .then(() => _stop ? _stop() : null)
        .catch(() => { /* CDP may be dead — best-effort */ })
        .finally(() => { page.close().catch(() => {}); });
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

        // B4 / RLY-004 — proactive session keep-alive ticker + auth-redirect
        // detection. Lifted OUTSIDE the `!codeAlreadyNavigates` block so they
        // activate for ALL tests (including those with explicit page.goto).
        // The ticker keeps the SUT's session cookie alive during long-running
        // tests regardless of navigation strategy; the auth-redirect check
        // fires after the framework goto (below) for non-navigating tests.
        let projectForAuth = null;
        try { projectForAuth = test.projectId ? projectRepo.getById(test.projectId) : null; }
        catch { /* repo blip — fall through with no recovery */ }

        // B4 / RLY-004 — proactive session keep-alive ticker. When the
        // project has `sessionRefreshIntervalMs` configured, register a
        // per-test setInterval that navigates back to `project.url`
        // every N ms. Industry-standard "session ping" pattern (Auth0
        // Universal Login, Okta sessionRefresh, Salesforce
        // session.refresh) — keeps the SUT's idle cookie alive on long
        // runs without waiting for a redirect-to-login.
        //
        // Best-effort: any goto error is swallowed (`.catch(() => {})`)
        // because (a) we own no recovery path here — the next user
        // action falls through to the reactive `restoreAuthSession`
        // check above, and (b) a ping that occasionally fails during a
        // navigation race must never fail the test. Bounded by the
        // route-layer [60_000, 86_400_000] gate so a typo can't flood
        // the SUT. Cleared in the `finally` block below alongside the
        // other per-test timers.
        if (Number.isInteger(projectForAuth?.sessionRefreshIntervalMs)
            && projectForAuth.sessionRefreshIntervalMs >= 60_000
            && projectForAuth.url) {
          const intervalMs = projectForAuth.sessionRefreshIntervalMs;
          // BUG-FIX (lifeguard): the previous design pinged the SAME
          // page the test was driving. Even with the `inFlight` latch,
          // the goto could race a mid-action wait — destroying the
          // DOM the test expected and surfacing as a confusing
          // `SELECTOR_ISSUE` / `NAVIGATION_FAIL`. Fix: open a SECOND
          // page in the SAME BrowserContext. The cookie jar is shared
          // (same context = same `Cookie` header on every request), so
          // a navigation on the refresh page keeps the test's session
          // alive WITHOUT touching the test page's DOM. Industry
          // pattern: this is what Auth0 / Okta SDKs do under the hood
          // for "session ping" (Playwright `BrowserContext` is
          // explicitly designed for multi-tab session sharing).
          sessionRefreshTicker = setInterval(() => {
            // Per-tick re-entrance guard. If the previous tick is
            // still navigating (slow target, 30s timeout), skip this
            // one rather than queueing — operators set this for
            // long-running runs, not tight polling.
            if (sessionRefreshInFlight) return;
            if (context.pages?.()?.length === 0) return; // context closing
            sessionRefreshInFlight = true;
            Promise.resolve()
              .then(async () => {
                // Open + close a fresh page per tick so we never hold
                // a long-lived background tab (which would show up as
                // a popup in `context.pages()` and confuse the
                // popup-cleanup loop in `finally` below). Cost: ~50ms
                // per ping for the page create/close round-trip;
                // negligible against the minimum 60s interval.
                const refreshPage = await context.newPage();
                try {
                  await refreshPage.goto(projectForAuth.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
                } finally {
                  await refreshPage.close().catch(() => {});
                }
              })
              .catch(() => { /* best-effort — never fails the test */ })
              .finally(() => { sessionRefreshInFlight = false; });
          }, intervalMs);
          // Stop the ticker from keeping the worker alive past the
          // test boundary if the cleanup `finally` somehow doesn't
          // fire (e.g. uncaught crash in the codeRunner host). The
          // `clearInterval` in `finally` is still the authoritative
          // teardown — this is defence-in-depth.
          sessionRefreshTicker.unref?.();
        }

        if (!codeAlreadyNavigates) {
          await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
          await page.waitForTimeout(800);
          // B4 / RLY-004 — auth-session-expiry detection after the
          // framework goto. Only fires for non-self-navigating tests
          // because self-navigating tests do their own page.goto() and
          // may legitimately land on /login as part of the test flow.
          //
          // Lifeguard bug-fix: skip recovery when the post-goto URL
          // matches the test's own `sourceUrl`. A test whose sourceUrl
          // IS a login page (e.g. testing the login form itself) would
          // otherwise trigger an unnecessary restoreAuthSession cycle
          // that logs in (navigating away from /login), then navigates
          // back — and on SUTs that redirect authenticated users away
          // from /login, the test body runs against the wrong page and
          // fails with a confusing SELECTOR_ISSUE / ASSERTION_FAIL.
          // QA.md §E documents this contract: "A test that lands on
          // /login from a deliberate non-auth-gated assertion → does
          // NOT trigger restoreAuthSession because the matching URL is
          // the project's intended sourceUrl."
          //
          // Follow-up hardening: compare URL **pathnames**, not the
          // full string. SUTs commonly append `?next=`/`?returnTo=`
          // query params on a session-expired bounce — strict equality
          // would miss that (sourceUrl=`/login` vs landed
          // `/login?next=/dashboard`) and incorrectly fire recovery on
          // a test that deliberately targets the login page. Pathname
          // comparison ignores query/hash while still distinguishing
          // `/login` from `/dashboard`. Fallback to the raw string
          // when URL parsing throws (relative sourceUrl, malformed) so
          // we never break the check on edge cases.
          const samePathAsSource = (() => {
            try {
              return new URL(page.url()).pathname === new URL(test.sourceUrl).pathname;
            } catch {
              return page.url() === test.sourceUrl;
            }
          })();
          if (projectForAuth?.credentials && looksLikeAuthRedirect(page.url()) && !samePathAsSource) {
            console.warn(formatLogLine("warn", runId,
              `[executeTest] Auth redirect detected after goto ${test.sourceUrl} → ${page.url()} — attempting session recovery`));
            const recovery = await restoreAuthSession(page, projectForAuth, { run: { id: runId } });
            if (!recovery.ok) {
              const authErr = new Error(
                `auth_session_expired_unrecoverable: ${recovery.reason || "unknown"}`
              );
              authErr.code = "AUTH_SESSION_EXPIRED";
              authErr.__authSessionExpired = true;
              throw authErr;
            }
            // Brief settle so the SUT's post-login redirect chain
            // finishes before the test body runs its first action.
            await page.waitForTimeout(500).catch(() => {});
          }
        }

        const healingScopeId = `${test.id}@v${test.codeVersion || 0}`;
        const healingHints = getHealingHistoryForTest(healingScopeId);
        const codeResult = await runGeneratedCode(page, context, test.playwrightCode, expect, healingHints, {
          // AUDIT-ROADMAP B2 — forward the adaptive element timeout into the
          // sandboxed helper string so safe* verbs respect the per-run value
          // instead of the env default.
          elementTimeout: opts.adaptiveTimeout,
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
    // B4 / RLY-004 — auth-session-expiry is an ENVIRONMENTAL failure,
    // not a test regression. Mark the result as `skipped` with reason
    // `auth_expired` so the gate evaluator excludes it from the pass-
    // rate denominator (mirrors `over_budget` / `skipped_no_impact`
    // semantics in `utils/skipReasons.js`). The feedback loop's
    // `AUTH_EXPIRED` classifier ALSO catches the error-string path
    // (legacy callers that don't carry the structured marker), but
    // setting `status: "skipped"` here is the authoritative signal —
    // it prevents `run.failed++` from incrementing and ensures the
    // RunDetail UI renders the test with the `auth_expired` chip.
    // We do NOT early-return — the outer `finally` MUST run for
    // resource cleanup (screencast, context, video, downloads dir);
    // we just skip the vision-healing waterfall + healing-events
    // persistence below since there's no real failed locator to heal.
    const isAuthExpiry = err.code === "AUTH_SESSION_EXPIRED" || err.__authSessionExpired === true;
    if (isAuthExpiry) {
      result.status = "skipped";
      result.skipReason = "auth_expired";
      result.error = formatTestError(err);
    } else {
      result.status = "failed";
      result.error = formatTestError(err);
    }

    // Persist healing events from the failed run
    const healingScopeId = `${test.id}@v${test.codeVersion || 0}`;

    // Collect any per-step captures/timings gathered before the failure
    result.stepCaptures = err.__stepCaptures || [];
    result.stepTimings = err.__stepTimings || [];
    result.stepStatuses = err.__stepStatuses || [];

    // Screenshot the failure state — also feeds the vision-healing waterfall below.
    // B4: skip artifact + vision-heal work entirely on auth-expiry. The
    // "failure" is environmental and there is no broken locator to heal;
    // a screenshot of the login page would burn S3 quota for zero value.
    let failureShot = null;
    if (!isAuthExpiry) {
      try {
        const shot = await captureScreenshot(page, runId, stepIndex, { failed: true });
        result.screenshot = shot.base64;
        result.screenshotPath = shot.artifactPath;
        failureShot = Buffer.from(shot.base64, "base64");
      } catch { /* page may be closed */ }
    }

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
              // AUTO-023 Bundle 2 — thread the originating `runId` so
              // `tryVisionHeal` can emit a healer-thread envelope keyed by
              // `healingThreadId(runId, testId)` on every heal outcome.
              // Missing runId falls through harmlessly (envelope no-ops).
              runId,
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
    // B4 / RLY-004 — stop the session-refresh ticker before any page /
    // context teardown so an in-flight `page.goto(project.url)` ping
    // can't race against `page.close()` and surface a spurious "Target
    // closed" error in the cleanup logs.
    if (sessionRefreshTicker) {
      clearInterval(sessionRefreshTicker);
      sessionRefreshTicker = null;
    }

    // AUTO-009 — stop V8 coverage before the page closes so the collector
    // returns the script range list intact. Best-effort: a stop failure
    // (page already closed, CDP detached) leaves `result.jsCoverage` at
    // its initial null and the run-level aggregator degrades to "no
    // coverage data for this test".
    if (coverageStarted && page?.coverage?.stopJSCoverage) {
      try { result.jsCoverage = await page.coverage.stopJSCoverage(); } catch { result.jsCoverage = null; }
    }

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
    if (context.__sentriPoolRelease) {
      await context.__sentriPoolRelease().catch(() => {});
    } else {
      await context.close().catch(() => {});
    }

    // Bundle-B fix #3 — Move the video to a stable named path using async
    // fs/promises. Sync FS calls in this hot cleanup path were blocking the
    // event loop on every test (8 calls × N parallel tests), starving the
    // BullMQ worker of progress events on large runs. Promise-based fs APIs
    // give the loop a chance to interleave other work and unblock SSE.
    if (videoEnabled) {
      try {
        const allFiles = await fsp.readdir(testVideoDir);
        const files = allFiles.filter(f => f.endsWith(".webm"));
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
              buffer: await fsp.readFile(src),
              contentType: "video/webm",
            });
          } catch (uploadErr) {
            // If writeArtifactBuffer threw before the local write completed,
            // dst won't exist — preserve src by renaming it as a last-resort
            // fallback so we don't lose the only copy of the video.
            const dstExists = await fsp.access(dst).then(() => true).catch(() => false);
            if (!dstExists) {
              try { await fsp.rename(src, dst); } catch { /* ignore */ }
            }
            console.warn(formatLogLine("warn", null,
              `[executeTest] S3 video upload failed for step ${stepIndex}, falling back to local path: ${uploadErr.message}`));
          }
          // Best-effort unlink — the rename fallback above may have moved
          // src already; in that case ENOENT is the expected outcome.
          await fsp.unlink(src).catch(() => {});
          const dstExists = await fsp.access(dst).then(() => true).catch(() => false);
          if (dstExists) result.videoPath = `/artifacts/videos/${videoName}`;
        }
        await fsp.rm(testVideoDir, { recursive: true, force: true });
      } catch (videoErr) {
        console.warn(formatLogLine("warn", null, `[executeTest] Video move failed for step ${stepIndex}: ${videoErr.message}`));
      }
    } else {
      // No video was recorded — clean up the empty directory
      await fsp.rm(testVideoDir, { recursive: true, force: true }).catch(() => {});
    }

    // Bundle-B fix #6 — wipe the per-run downloads dir regardless of test
    // outcome. Best-effort: a stale temp dir is cosmetically ugly but never
    // fatal, so swallow ENOENT etc.
    await fsp.rm(testDownloadsDir, { recursive: true, force: true }).catch(() => {});
  }

  return result;

  } catch (setupErr) {
    // Outer guard catch: release the pool slot if setup code between context
    // creation and the inner try-block threw. Re-throw so the caller sees
    // the original error.
    if (context?.__sentriPoolRelease) {
      await context.__sentriPoolRelease().catch(() => {});
    } else if (context) {
      await context.close().catch(() => {});
    }
    throw setupErr;
  }
}

/**
 * executeApiTest(test, runId, stepIndex, runStart) → result object
 *
 * Runs an API-only test (one that uses `request.newContext()`) without
 * spinning up a browser page. Skips screenshots, video, DOM snapshots,
 * and screencast — none of which apply to API tests.
 */
async function executeApiTest(test, runId, stepIndex, runStart, opts = {}) {
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
    // AUTO-009h — server-side coverage diff captured from the SUT's
    // Istanbul / NYC `__coverage__` endpoint. Null when the project hasn't
    // configured `serverCoverageEndpoint` or the snapshot failed.
    serverCoverage: null,
  };

  const start = Date.now();
  result.startedAt = start;

  // AUTO-009h — snapshot the SUT's coverage BEFORE the API test fires so
  // the post-test diff isolates exactly what this test exercised. Opt-in
  // per project; failures are best-effort and never flip a passing test
  // (the snapshot can timeout, the SUT can be down, the endpoint can
  // return non-JSON — all degrade silently to `serverCoverage: null`).
  //
  // Prefer `opts.serverCoverageEndpoint` (forwarded from testRunner.js
  // once per run) to avoid a per-test `projectRepo.getById()` round-trip.
  // Falls back to the repo lookup for callers that don't forward.
  let serverCoverageEndpoint = null;
  let serverCoverageBefore = null;
  try {
    serverCoverageEndpoint = opts.serverCoverageEndpoint !== undefined
      ? (opts.serverCoverageEndpoint || null)
      : (() => { try { return projectRepo.getById(test.projectId)?.serverCoverageEndpoint || null; } catch { return null; } })();
    if (serverCoverageEndpoint) {
      serverCoverageBefore = await snapshotServerCoverage(serverCoverageEndpoint);
    }
  } catch { /* best-effort */ }

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

    // AUTO-009h — capture `durationMs` BEFORE the post-test coverage
    // snapshot so the reported test duration reflects only the test
    // itself, not the snapshot round-trip. A 50-MB coverage JSON over a
    // staging-network HTTP GET can take 100-200ms; without this hoist
    // every API test would appear ~200ms slower than it actually was on
    // any project with `serverCoverageEndpoint` configured, and the
    // p95 / p99 latency dashboards would silently drift.
    result.durationMs = Date.now() - start;
    result.runTimestamp = start - runStart;

    // AUTO-009h — snapshot the SUT's coverage AFTER the API test and diff
    // against the pre-snapshot so `result.serverCoverage` carries exactly
    // the statements / branches / functions this test newly exercised.
    // Best-effort: any snapshot failure leaves `result.serverCoverage` as
    // whatever the pre-snapshot logic set it to (typically null), so a
    // SUT outage mid-test doesn't fail an otherwise-passing run.
    if (serverCoverageEndpoint) {
      try {
        const after = await snapshotServerCoverage(serverCoverageEndpoint);
        if (after) {
          const delta = diffServerCoverage(serverCoverageBefore, after);
          // Only attach when the diff has data — otherwise `null` keeps the
          // aggregator's "no server-side coverage for this test" branch
          // identical to the opt-out path.
          if (delta && Object.keys(delta).length > 0) {
            result.serverCoverage = delta;
          }
        }
      } catch { /* best-effort */ }
    }
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

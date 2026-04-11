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
import { getHealingHistoryForTest } from "../selfHealing.js";
import { extractTestBody, isApiTest } from "./codeParsing.js";
import { runGeneratedCode, runApiTestCode, getExpect } from "./codeExecutor.js";
import { startScreencast } from "./screencast.js";
import { captureDomSnapshot, captureScreenshot, captureBoundingBoxes } from "./pageCapture.js";
import { persistHealingEvents } from "./healingPersistence.js";
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT, NAVIGATION_TIMEOUT, API_TEST_TIMEOUT, BROWSER_TEST_TIMEOUT, VIDEOS_DIR } from "./config.js";
import { formatLogLine } from "../utils/logFormatter.js";

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
 * executeTest(test, browser, runId, stepIndex, runStart, db) → result object
 *
 * Runs a single test case inside a fresh browser context and returns a
 * result object suitable for pushing into run.results.
 */
export async function executeTest(test, browser, runId, stepIndex, runStart) {
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

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    recordVideo: { dir: testVideoDir, size: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } },
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    permissions: ["geolocation", "notifications"],
    ignoreHTTPSErrors: true,
    // Enable downloads so page.waitForEvent('download') works (#42)
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // Auto-accept dialogs (window.alert, confirm, prompt) so they don't hang
  // the test until timeout. Tests that need to dismiss can override with
  // page.on('dialog', d => d.dismiss()) before the triggering action. (#40)
  page.on("dialog", (dialog) => {
    dialog.accept().catch(() => {});
  });

  // Start CDP screencast (returns cleanup fn or null)
  const stopScreencast = await startScreencast(page, runId);

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
        const codeResult = await runGeneratedCode(page, context, test.playwrightCode, expect, healingHints);
        persistHealingEvents(healingScopeId, codeResult.healingEvents);

      } else {
        // ── FALLBACK: No parseable code — run a basic smoke test ───────────
        await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
        await page.waitForTimeout(500);

        const title = await page.title();
        if (!title) throw new Error("Page has no title — possible load failure");

        const url = page.url();
        if (!url.startsWith("http")) throw new Error("Invalid URL after navigation");
      }

      // Capture artifacts on success.
      // Skip screenshot / DOM snapshot / bounding boxes when the test ends
      // with a non-visual action (assertion, wait, evaluate) — the page
      // hasn't visually changed so these artifacts are redundant. This saves
      // ~50-200ms per test. Failure screenshots are always captured regardless.
      const skipVisualArtifacts = endsWithNonVisualAction(test.playwrightCode);

      if (!skipVisualArtifacts) {
        result.domSnapshot = await captureDomSnapshot(page);

        const shot = await captureScreenshot(page, runId, stepIndex);
        result.screenshot = shot.base64;
        result.screenshotPath = shot.artifactPath;

        result.boundingBoxes = await captureBoundingBoxes(page);
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
    persistHealingEvents(healingScopeId, err.__healingEvents);

    // Screenshot the failure state
    try {
      const shot = await captureScreenshot(page, runId, stepIndex, { failed: true });
      result.screenshot = shot.base64;
      result.screenshotPath = shot.artifactPath;
    } catch { /* page may be closed */ }

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

    // Close page first then context — this flushes video to disk
    await page.close().catch(() => {});
    await context.close().catch(() => {});

    // Move the video to a stable named path
    try {
      const files = fs.readdirSync(testVideoDir).filter(f => f.endsWith(".webm"));
      if (files.length > 0) {
        const src = path.join(testVideoDir, files[0]);
        const videoName = `${runId}-step${stepIndex}.webm`;
        const dst = path.join(VIDEOS_DIR, videoName);
        fs.renameSync(src, dst);
        result.videoPath = `/artifacts/videos/${videoName}`;
      }
      fs.rmSync(testVideoDir, { recursive: true, force: true });
    } catch (videoErr) {
      console.warn(formatLogLine("warn", null, `[executeTest] Video move failed for step ${stepIndex}: ${videoErr.message}`));
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

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
 *   executeTest(test, browser, runId, stepIndex, runStart, db)
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
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT, NAVIGATION_TIMEOUT, VIDEOS_DIR } from "./config.js";

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
export async function executeTest(test, browser, runId, stepIndex, runStart, db) {
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
  });

  const page = await context.newPage();

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

  try {
    const expect = await getExpect();

    if (test.playwrightCode && extractTestBody(test.playwrightCode)) {
      // ── PRIMARY PATH: Execute the actual AI-generated Playwright code ──
      const body = extractTestBody(test.playwrightCode);
      const codeAlreadyNavigates = body.includes("page.goto(");

      if (!codeAlreadyNavigates) {
        await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
        await page.waitForTimeout(800);
      }

      const healingHints = getHealingHistoryForTest(db, test.id);
      const codeResult = await runGeneratedCode(page, context, test.playwrightCode, expect, healingHints);
      persistHealingEvents(db, test.id, codeResult.healingEvents);

    } else {
      // ── FALLBACK: No parseable code — run a basic smoke test ───────────
      await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
      await page.waitForTimeout(500);

      const title = await page.title();
      if (!title) throw new Error("Page has no title — possible load failure");

      const url = page.url();
      if (!url.startsWith("http")) throw new Error("Invalid URL after navigation");
    }

    // Capture artifacts on success
    result.domSnapshot = await captureDomSnapshot(page);

    const shot = await captureScreenshot(page, runId, stepIndex);
    result.screenshot = shot.base64;
    result.screenshotPath = shot.artifactPath;

    result.boundingBoxes = await captureBoundingBoxes(page);

  } catch (err) {
    result.status = "failed";
    result.error = formatTestError(err);

    // Persist healing events from the failed run
    persistHealingEvents(db, test.id, err.__healingEvents);

    // Screenshot the failure state
    try {
      const shot = await captureScreenshot(page, runId, stepIndex, { failed: true });
      result.screenshot = shot.base64;
      result.screenshotPath = shot.artifactPath;
    } catch { /* page may be closed */ }

  } finally {
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
      console.warn(`[executeTest] Video move failed for step ${stepIndex}:`, videoErr.message);
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

  try {
    const expect = await getExpect();
    const apiResult = await runApiTestCode(test.playwrightCode, expect);
    // Populate network logs from the instrumented API request context
    result.network = apiResult.apiLogs || [];
  } catch (err) {
    result.status = "failed";
    result.error = formatTestError(err);
    // Capture any API logs collected before the failure
    result.network = err.__apiLogs || [];
  } finally {
    result.durationMs = Date.now() - start;
    result.runTimestamp = start - runStart;
  }

  return result;
}

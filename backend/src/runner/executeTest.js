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
import { extractTestBody } from "./codeParsing.js";
import { runGeneratedCode, getExpect } from "./codeExecutor.js";
import { startScreencast } from "./screencast.js";
import { captureDomSnapshot, captureScreenshot, captureBoundingBoxes } from "./pageCapture.js";
import { persistHealingEvents } from "./healingPersistence.js";
import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT, NAVIGATION_TIMEOUT, VIDEOS_DIR } from "./config.js";

/**
 * Attach network & console listeners to a page.
 * Returns { networkLogs, consoleLogs } arrays that are mutated in-place
 * as events arrive.
 */
function attachPageListeners(page) {
  const networkLogs = [];
  const consoleLogs = [];

  page.on("request", (req) => {
    networkLogs.push({
      id: uuidv4(),
      method: req.method(),
      url: req.url(),
      startTime: Date.now(),
      status: null,
      size: null,
      duration: null,
    });
  });

  page.on("response", async (res) => {
    const entry = networkLogs.find((n) => n.url === res.url() && n.status === null);
    if (entry) {
      entry.status = res.status();
      entry.duration = Date.now() - entry.startTime;
      try {
        const body = await res.body().catch(() => Buffer.alloc(0));
        entry.size = body.length;
      } catch { entry.size = 0; }
    }
  });

  page.on("console", (msg) => {
    consoleLogs.push({ time: new Date().toISOString(), level: msg.type(), text: msg.text() });
  });

  page.on("pageerror", (err) => {
    consoleLogs.push({ time: new Date().toISOString(), level: "error", text: err.message });
  });

  return { networkLogs, consoleLogs };
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

  // Attach network / console listeners
  const { networkLogs, consoleLogs } = attachPageListeners(page);

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

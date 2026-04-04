import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  getSelfHealingHelperCode,
  applyHealingTransforms,
  getHealingHistoryForTest,
  recordHealing,
  recordHealingFailure,
} from "./selfHealing.js";
import { applyFeedbackLoop, analyzeRunResults } from "./pipeline/feedbackLoop.js";
import { finalizeRunIfNotAborted, isRunAborted } from "./utils/abortHelper.js";
import { emitRunEvent, log } from "./utils/runLogger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Env-driven config (defaults match previous hardcoded values) ──────────────
const BROWSER_HEADLESS    = process.env.BROWSER_HEADLESS !== "false";
const VIEWPORT_WIDTH      = parseInt(process.env.VIEWPORT_WIDTH, 10) || 1280;
const VIEWPORT_HEIGHT     = parseInt(process.env.VIEWPORT_HEIGHT, 10) || 720;
const NAVIGATION_TIMEOUT  = parseInt(process.env.NAVIGATION_TIMEOUT, 10) || 60000;

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts");
const VIDEOS_DIR    = path.join(ARTIFACTS_DIR, "videos");
const TRACES_DIR    = path.join(ARTIFACTS_DIR, "traces");
const SHOTS_DIR     = path.join(ARTIFACTS_DIR, "screenshots");

[ARTIFACTS_DIR, VIDEOS_DIR, TRACES_DIR, SHOTS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/**
 * extractTestBody(playwrightCode)
 *
 * Pulls the async function body out of the generated Playwright test so we can
 * run it directly against an already-open page/context — without needing to
 * spawn a whole new Playwright test runner process.
 *
 * Handles both common shapes the AI produces:
 *   test('name', async ({ page }) => { ... })
 *   test('name', async ({ page, context }) => { ... })
 */
function extractTestBody(playwrightCode) {
  if (!playwrightCode) return null;

  // Match:  async ({ page ... }) => {  ...  }
  // We want everything inside the outermost braces of the arrow function body.
  const arrowMatch = playwrightCode.match(/async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{([\s\S]*)/);
  if (!arrowMatch) return null;

  // arrowMatch[1] starts just after the opening { of the test body.
  // We walk character-by-character to find the matching closing brace.
  const bodyAndRest = arrowMatch[1];
  let depth = 1;
  let i = 0;
  for (; i < bodyAndRest.length && depth > 0; i++) {
    if (bodyAndRest[i] === "{") depth++;
    else if (bodyAndRest[i] === "}") depth--;
  }
  // Everything up to (but not including) the final closing brace is the body.
  return bodyAndRest.slice(0, i - 1).trim();
}

/**
 * patchNetworkIdle(code)
 *
 * Rewrites any waitForLoadState('networkidle') or waitForLoadState("networkidle")
 * calls that the AI may have generated into the safe domcontentloaded equivalent.
 *
 * Many real-world sites (SPAs, e-commerce like Amazon) fire continuous background
 * XHR/fetch requests for ads, personalisation, and tracking — they never reach
 * networkidle, so Playwright always times out after 30 s.  domcontentloaded is
 * sufficient to guarantee the primary DOM content is ready for interaction.
 *
 * Also rewrites page.goto() calls that use waitUntil:'networkidle' to use
 * waitUntil:'domcontentloaded' for the same reason.
 *
 * Additionally, wraps bare element.click() calls that are immediately followed
 * by a waitForNavigation/waitForLoadState pattern into a safer Promise.all so
 * the navigation promise is registered before the click fires.
 */
function patchNetworkIdle(code) {
  return code
    // waitForLoadState('networkidle') / waitForLoadState("networkidle")
    .replace(/waitForLoadState\s*\(\s*['"]networkidle['"]\s*(,\s*\{[^}]*\})?\s*\)/g,
      "waitForLoadState('domcontentloaded', { timeout: 30000 })")
    // waitUntil: 'networkidle' / waitUntil: "networkidle" inside goto / waitForNavigation
    .replace(/waitUntil\s*:\s*['"]networkidle['"]/g,
      "waitUntil: 'domcontentloaded'");
}

/**
 * stripPlaywrightImports(code)
 *
 * Remove lines like:
 *   import { test, expect } from '@playwright/test';
 *   const { test, expect } = require('@playwright/test');
 * so they don't cause parse errors when we eval the body.
 */
function stripPlaywrightImports(code) {
  return code
    .split("\n")
    .filter(line => !line.match(/import\s*\{.*\}\s*from\s*['"]@playwright\/test['"]/))
    .filter(line => !line.match(/require\s*\(\s*['"]@playwright\/test['"]\s*\)/))
    .join("\n");
}

/**
 * runGeneratedCode(page, context, playwrightCode, expect, healingHints)
 *
 * Dynamically executes the AI-generated test body against the live page.
 * Returns { passed: true, healingEvents: [...] } or throws with the error.
 *
 * healingHints is an optional map of "action::label" → strategyIndex from
 * previous runs, injected into the runtime helpers so the winning strategy
 * is tried first (adaptive self-healing).
 */
async function runGeneratedCode(page, context, playwrightCode, expect, healingHints) {
  const body = extractTestBody(playwrightCode);
  if (!body) {
    throw new Error("Could not parse test body from generated code");
  }

  const cleaned = applyHealingTransforms(patchNetworkIdle(stripPlaywrightImports(body)));
  const helpers = getSelfHealingHelperCode(healingHints);

  // eslint-disable-next-line no-new-func
  const fn = new Function("page", "context", "expect", `
    return (async () => {
      ${helpers}
      // Stubs for Playwright fixtures that some LLMs hallucinate in the function
      // signature but are not valid in our eval context (e.g. 'run', 'browser',
      // 'request'). Defining them as undefined prevents ReferenceError crashes.
      const run = undefined;
      const browser = context?.browser?.() ?? undefined;
      const request = undefined;
      let __testError = null;
      try {
        ${cleaned}
      } catch (e) {
        __testError = e;
      }
      // Always return healing events, even on failure, so the runner can
      // persist what we learned from earlier steps.
      if (__testError) {
        __testError.__healingEvents = __healingEvents;
        throw __testError;
      }
      return { __healingEvents };
    })();
  `);

  try {
    const result = await fn(page, context, expect);
    return { passed: true, healingEvents: result?.__healingEvents || [] };
  } catch (err) {
    err.__healingEvents = err.__healingEvents || [];
    throw err;
  }
}

/**
 * buildExpect(page)
 *
 * Returns a minimal `expect` compatible with Playwright's assertion API
 * by delegating to the real Playwright expect imported dynamically.
 * We lazy-import it here because Playwright's `expect` lives in the test
 * runner module which we don't load at the top level.
 */
async function getExpect() {
  // Playwright exports expect from its test module — import it at runtime.
  const { expect } = await import("@playwright/test");
  return expect;
}

async function executeTest(test, browser, runId, stepIndex, runStart, db) {
  const testVideoDir = path.join(VIDEOS_DIR, runId, `step${stepIndex}`);
  if (!fs.existsSync(testVideoDir)) fs.mkdirSync(testVideoDir, { recursive: true });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    recordVideo: { dir: testVideoDir, size: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } },
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    // Accept all permissions so interactions aren't blocked
    permissions: ["geolocation", "notifications"],
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // ── CDP screencast — only stream if at least one SSE client is watching ──
  let cdpSession = null;
  let rafScheduled = false;
  let pendingFrame = null;

  // Only start if there are active SSE listeners (avoids encoding overhead
  // when nobody is watching the live stream)
  const { runListeners } = await import("./index.js").catch(() => ({}));
  if (runListeners?.get(runId)?.size > 0) {
    try {
      cdpSession = await page.context().newCDPSession(page);
      await cdpSession.send("Page.startScreencast", {
        format: "jpeg",
        quality: 50,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 2, // ~15 FPS source → ~7 FPS net
      });

      cdpSession.on("Page.screencastFrame", async ({ data, sessionId }) => {
        // Buffer the latest frame; requestAnimationFrame-style throttle via
        // a flag so bursting frames don't flood the SSE channel
        pendingFrame = data;
        if (!rafScheduled) {
          rafScheduled = true;
          setImmediate(() => {
            rafScheduled = false;
            if (pendingFrame) {
              emitRunEvent(runId, "frame", { data: pendingFrame });
              pendingFrame = null;
            }
          });
        }
        // Acknowledge every frame so the browser doesn't stall
        await cdpSession.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      });
    } catch (cdpErr) {
      console.warn("[testRunner] CDP screencast unavailable:", cdpErr.message);
      cdpSession = null;
    }
  }

  const networkLogs = [];
  const consoleLogs = [];

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
    boundingBoxes: [], // populated after test execution from last interacted element
  };

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

  const start = Date.now();
  result.startedAt = start; // absolute timestamp for ExecutionTimeline Gantt

  try {
    const expect = await getExpect();

    if (test.playwrightCode && extractTestBody(test.playwrightCode)) {
      // ── PRIMARY PATH: Execute the actual AI-generated Playwright code ──────
      const body = extractTestBody(test.playwrightCode);
      const codeAlreadyNavigates = body.includes("page.goto(");

      // Only pre-navigate if the generated code doesn't do it itself
      if (!codeAlreadyNavigates) {
        await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
        await page.waitForTimeout(800);
      }

      // Load healing hints from previous runs for this test
      const healingHints = getHealingHistoryForTest(db, test.id);

      // Run the full generated test body
      const codeResult = await runGeneratedCode(page, context, test.playwrightCode, expect, healingHints);

      // Persist healing events so future runs benefit from what we learned
      if (codeResult.healingEvents?.length && db) {
        for (const evt of codeResult.healingEvents) {
          // Use bounded split so labels containing '::' don't corrupt args
          const [action, ...rest] = evt.key.split("::");
          const label = rest.join("::");
          if (evt.failed) {
            recordHealingFailure(db, test.id, action, label);
          } else {
            recordHealing(db, test.id, action, label, evt.strategyIndex);
          }
        }
      }

    } else {
      // ── FALLBACK: No parseable code — run a basic smoke test ──────────────
      await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT });
      await page.waitForTimeout(500);

      const title = await page.title();
      if (!title) throw new Error("Page has no title — possible load failure");

      const url = page.url();
      if (!url.startsWith("http")) throw new Error("Invalid URL after navigation");
    }

    // DOM snapshot (always, after test runs)
    result.domSnapshot = await page.evaluate(() => {
      function serialize(node, depth = 0) {
        if (depth > 4 || !node) return null;
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent?.trim();
          return t ? { type: "text", text: t.slice(0, 80) } : null;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        const el = node;
        const tag = el.tagName.toLowerCase();
        if (["script","style","noscript","svg","path"].includes(tag)) return null;
        const attrs = {};
        for (const a of el.attributes) {
          if (["id","class","href","src","type","role","aria-label","name"].includes(a.name))
            attrs[a.name] = a.value.slice(0, 60);
        }
        const children = [];
        for (const child of el.childNodes) {
          const c = serialize(child, depth + 1);
          if (c) children.push(c);
          if (children.length >= 6) break;
        }
        return { type: "element", tag, attrs, children };
      }
      return serialize(document.body);
    }).catch(() => null);

    // Screenshot of final state
    const shotName = `${runId}-step${stepIndex}.png`;
    const shotPath = path.join(SHOTS_DIR, shotName);
    const buf = await page.screenshot({ type: "png", fullPage: false });
    fs.writeFileSync(shotPath, buf);
    result.screenshot = buf.toString("base64");
    result.screenshotPath = `/artifacts/screenshots/${shotName}`;

    // Capture bounding boxes of the last interacted / focused elements.
    // We collect up to 5 interactive elements that are currently visible and
    // in focus or recently clicked, so the OverlayCanvas can draw highlights.
    try {
      result.boundingBoxes = await page.evaluate(() => {
        const boxes = [];
        // Prefer the currently-focused element
        const focused = document.activeElement;
        if (focused && focused !== document.body && focused !== document.documentElement) {
          const r = focused.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          }
        }
        // Also collect any elements with aria-selected / data-testid that are visible
        if (boxes.length === 0) {
          const candidates = document.querySelectorAll(
            "button:focus, input:focus, [aria-selected='true'], [data-focused='true']"
          );
          for (const el of candidates) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height });
              if (boxes.length >= 3) break;
            }
          }
        }
        return boxes;
      }).catch(() => []);
    } catch { result.boundingBoxes = []; }

  } catch (err) {
    result.status = "failed";
    // Extract a readable message — handle AggregateError (thrown by Playwright
    // when multiple internal strategies fail) so the UI doesn't show a raw
    // "[object Object]" or bare "AggregateError".
    let rawMsg = err.message || "";
    if ((!rawMsg || rawMsg === "AggregateError") && err.errors?.length) {
      rawMsg = err.errors.map(e => e?.message || String(e)).join("; ");
    }
    // Strip ANSI escape codes so the UI shows clean text
    result.error = rawMsg.replace(/\x1B\[[0-9;]*[mGKHF]/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();

    // Persist healing events from the failed run — runGeneratedCode attaches
    // them to the error so earlier successful steps aren't lost.
    if (err.__healingEvents?.length && db) {
      for (const evt of err.__healingEvents) {
        const [action, ...rest] = evt.key.split("::");
        const label = rest.join("::");
        if (evt.failed) {
          recordHealingFailure(db, test.id, action, label);
        } else {
          recordHealing(db, test.id, action, label, evt.strategyIndex);
        }
      }
    }

    // Screenshot the failure state
    try {
      const buf = await page.screenshot({ type: "png", fullPage: false });
      result.screenshot = buf.toString("base64");
      const shotName = `${runId}-step${stepIndex}-fail.png`;
      const shotPath = path.join(SHOTS_DIR, shotName);
      fs.writeFileSync(shotPath, buf);
      result.screenshotPath = `/artifacts/screenshots/${shotName}`;
    } catch {}
  } finally {
    // Capture the final page URL so the frontend BrowserChrome shows it
    // instead of "about:blank". Falls back to test.sourceUrl if the page
    // was already closed or never navigated.
    try { result.url = page.url(); } catch { /* page already closed */ }
    if (!result.url || result.url === "about:blank") result.url = test.sourceUrl || "";

    result.durationMs = Date.now() - start;
    result.runTimestamp = start - runStart;
    result.network = networkLogs;
    result.consoleLogs = consoleLogs;

    // Stop CDP screencast before closing the page
    if (cdpSession) {
      await cdpSession.send("Page.stopScreencast").catch(() => {});
      await cdpSession.detach().catch(() => {});
      cdpSession = null;
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
      console.warn(`[testRunner] Video move failed for step ${stepIndex}:`, videoErr.message);
    }
  }

  return result;
}

export async function runTests(project, tests, run, db, { signal } = {}) {
  const runId = run.id;
  const tracePath = path.join(TRACES_DIR, `${runId}.zip`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: BROWSER_HEADLESS,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (launchErr) {
    run.status = "failed";
    run.error = `Browser launch failed: ${launchErr.message}`;
    run.finishedAt = new Date().toISOString();
    log(run, `❌ Browser launch failed: ${launchErr.message}`);
    throw launchErr;
  }

  // Shared tracing context (separate from per-test video contexts)
  let traceContext;
  try {
    traceContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (compatible; AutonomousQA/1.0)",
      viewport: { width: 1280, height: 720 },
    });
    await traceContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
  } catch (ctxErr) {
    await browser.close().catch(() => {});
    run.status = "failed";
    run.error = `Trace context setup failed: ${ctxErr.message}`;
    run.finishedAt = new Date().toISOString();
    log(run, `❌ Trace context setup failed: ${ctxErr.message}`);
    throw ctxErr;
  }

  log(run, `🚀 Starting test run: ${tests.length} tests`);

  const runStart = Date.now();
  const allVideoSegments = [];

  try {
    for (let i = 0; i < tests.length; i++) {
      // Check abort signal between tests so the run stops promptly
      if (signal?.aborted) {
        log(run, `  ⛔ Abort signal received — skipping remaining ${tests.length - i} test(s)`);
        break;
      }

      const test = tests[i];
      const hasCode = !!(test.playwrightCode && extractTestBody(test.playwrightCode));
      log(run, `  ▶ [${i + 1}/${tests.length}] ${test.name} ${hasCode ? "(executing generated code)" : "(fallback smoke test)"}`);

      try {
        const result = await executeTest(test, browser, runId, i, runStart, db);
        run.results.push(result);

        if (result.videoPath) allVideoSegments.push(result.videoPath);

        if (result.status === "passed") {
          run.passed++;
          log(run, `    ✅ PASSED (${result.durationMs}ms)`);
        } else if (result.status === "warning") {
          run.passed++;
          log(run, `    ⚠️  WARNING: ${result.error}`);
        } else {
          run.failed++;
          log(run, `    ❌ FAILED: ${result.error}`);
        }

        // Emit result event (without the heavy base64 screenshot)
        const { screenshot: _ss, ...resultLean } = result;
        emitRunEvent(run.id, "result", { result: resultLean });
        if (result.screenshotPath) {
          emitRunEvent(run.id, "screenshot", {
            testId: test.id,
            screenshotPath: result.screenshotPath,
          });
        }

        if (db.tests[test.id]) {
          db.tests[test.id].lastResult = result.status;
          db.tests[test.id].lastRunAt = new Date().toISOString();
        }
      } catch (err) {
        run.failed++;
        run.results.push({
          testId: test.id, testName: test.name,
          status: "failed", error: err.message,
          durationMs: 0, network: [], consoleLogs: [],
        });
        log(run, `    ❌ FAILED (exception): ${err.message}`);
      }
    }
  } finally {
    // Always clean up browser resources — even if the loop threw unexpectedly
    try {
      await traceContext.tracing.stop({ path: tracePath });
      run.tracePath = `/artifacts/traces/${runId}.zip`;
      log(run, `  📊 Trace saved`);
    } catch (e) {
      log(run, `  ⚠️  Trace save failed: ${e.message}`);
    }
    await traceContext.close().catch(() => {});
    await browser.close().catch((err) => {
      console.warn("[testRunner] browser.close() failed:", err.message);
    });
  }

  if (allVideoSegments.length > 0) {
    run.videoPath = allVideoSegments[0];
    run.videoSegments = allVideoSegments;
    log(run, `  🎬 ${allVideoSegments.length} video segment(s) saved`);
  }

  // NOTE: We intentionally keep run.status === "running" here so that:
  //   1. The abort endpoint (POST /api/runs/:id/abort) still works during the
  //      feedback loop — it checks run.status === "running".
  //   2. SSE reconnections don't prematurely close — the /events endpoint sends
  //      an immediate "done" + res.end() when run.status !== "running", which
  //      would cut off the client while the feedback loop is still active.
  // The status is set to "completed" only after the feedback loop finishes.
  log(run, `📋 Test execution done: ${run.passed} passed, ${run.failed} failed out of ${run.total} — starting post-run analysis…`);

  // Broadcast a snapshot so the frontend sees updated pass/fail counts while
  // the feedback loop performs long-running AI calls below.
  if (!isRunAborted(run, signal)) {
    emitRunEvent(run.id, "snapshot", { run });
  }

  // ── Feedback loop: auto-regenerate high-priority failing tests ──────────
  // Only runs when there are failures and an AI provider is available.
  // The loop classifies each failure (SELECTOR_ISSUE, NAVIGATION_FAIL, etc.),
  // regenerates high-priority failures via AI, and updates the DB so the next
  // run benefits from the improved test code.
  // Skip the feedback loop entirely if the run was aborted — no point in
  // regenerating tests when the user cancelled the operation.
  if (run.failed > 0 && !isRunAborted(run, signal)) {
    try {
      const { hasProvider } = await import("./aiProvider.js");
      if (hasProvider()) {
        log(run, `🔄 Feedback loop: analyzing ${run.failed} failure(s)...`);

        // Build testMap from the actual tests array (not run.tests which is
        // only populated during crawl runs). Test runs have testQueue/results
        // but not run.tests, so we build the map from the tests argument.
        const testMap = {};
        for (const t of tests) { if (db.tests[t.id]) testMap[t.id] = db.tests[t.id]; }

        // Populate run.tests so applyFeedbackLoop can find them
        if (!run.tests || run.tests.length === 0) {
          run.tests = tests.map(t => t.id);
        }

        const snapshotsByUrl = {};
        for (const snap of (run.snapshots || [])) { snapshotsByUrl[snap.url] = snap; }
        const { improvements } = analyzeRunResults(run.results, testMap, snapshotsByUrl);

        // Log failure categories so the user can see what went wrong
        const categories = {};
        for (const imp of improvements) {
          categories[imp.failureCategory] = (categories[imp.failureCategory] || 0) + 1;
        }
        if (Object.keys(categories).length > 0) {
          const breakdown = Object.entries(categories).map(([k, v]) => `${k}: ${v}`).join(", ");
          log(run, `    📊 Failure breakdown: ${breakdown}`);
        }

        const feedback = await applyFeedbackLoop(run, db, { signal });
        if (feedback.improved > 0) {
          log(run, `    ✅ Auto-regenerated ${feedback.improved} failing test(s) (${feedback.skipped} skipped)`);
          log(run, `    💡 Regenerated tests will use improved selectors on next run`);
          run.feedbackLoop = feedback;
        } else {
          log(run, `    ℹ️  No tests auto-regenerated (${feedback.skipped} low-priority failures skipped)`);
        }
      }
    } catch (err) {
      log(run, `    ⚠️  Feedback loop error: ${err.message}`);
    }
  }

  // Now that the feedback loop is done, finalize the run status.
  // This is the single place where status transitions to "completed".
  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    run.duration = Date.now() - runStart;
  });
  log(run, `🏁 Run ${run.status}: ${run.passed} passed, ${run.failed} failed out of ${run.total}`);

  // Emit "done" only now — after the feedback loop — so the frontend's
  // fetchRun() always sees the final, stable completed state.
  // Skip if already aborted — the abort endpoint already emitted the done event.
  if (!isRunAborted(run, signal)) {
    emitRunEvent(run.id, "done", { status: run.status, passed: run.passed, failed: run.failed, total: run.total });
  }
}
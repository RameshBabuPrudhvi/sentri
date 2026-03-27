import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts");

// Global event emitter for SSE log streaming
export const runEvents = new EventEmitter();
runEvents.setMaxListeners(50);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(run, msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  run.logs.push(entry);
  console.log(entry);
  // Emit event for SSE streaming
  runEvents.emit(`log:${run.id}`, entry);
}

async function executeTest(test, context, screenshotDir) {
  const page = await context.newPage();
  const result = {
    testId: test.id,
    testName: test.name,
    status: "passed",
    durationMs: 0,
    error: null,
    screenshot: null,
    screenshotPath: null,
    videoPath: null,
  };

  const start = Date.now();

  try {
    // Navigate to the page
    await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(500);

    // Execute basic validations based on test type
    if (test.type === "visibility") {
      // Check page loaded
      const title = await page.title();
      if (!title) throw new Error("Page has no title");

      // Check for error pages
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const errorPatterns = ["404", "not found", "500", "error", "forbidden"];
      const hasError = errorPatterns.some((p) => bodyText.toLowerCase().includes(p));
      if (hasError) {
        // Soft check - only fail if prominent
        const h1 = await page.locator("h1").first().innerText().catch(() => "");
        if (errorPatterns.some((p) => h1.toLowerCase().includes(p))) {
          throw new Error(`Error page detected: ${h1}`);
        }
      }
    }

    if (test.type === "navigation") {
      // Verify page loads and has expected content
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const url = page.url();
      if (!url.startsWith("http")) throw new Error("Invalid URL after navigation");
    }

    if (test.type === "form") {
      // Check forms exist
      const forms = await page.locator("form").count();
      const inputs = await page.locator("input:visible").count();
      if (forms === 0 && inputs === 0) {
        // Not a hard fail - page might have changed
        result.status = "warning";
        result.error = "No forms found on page (may have changed)";
      }
    }

    if (test.type === "interaction") {
      // Click primary CTA buttons if present
      const buttons = page.locator("button:visible, [role='button']:visible");
      const count = await buttons.count();
      if (count > 0) {
        // Just verify buttons are clickable, don't actually click to avoid side effects
        const firstBtn = buttons.first();
        const isEnabled = await firstBtn.isEnabled().catch(() => false);
        if (!isEnabled) {
          result.status = "warning";
          result.error = "Primary button appears disabled";
        }
      }
    }

    // Take screenshot on success and save to disk
    const screenshotFile = path.join(screenshotDir, `${test.id}.png`);
    await page.screenshot({ path: screenshotFile, type: "png" });
    result.screenshot = fs.readFileSync(screenshotFile).toString("base64");
    result.screenshotPath = screenshotFile;
  } catch (err) {
    result.status = "failed";
    result.error = err.message;
    try {
      const screenshotFile = path.join(screenshotDir, `${test.id}.png`);
      await page.screenshot({ path: screenshotFile, type: "png" });
      result.screenshot = fs.readFileSync(screenshotFile).toString("base64");
      result.screenshotPath = screenshotFile;
    } catch {
      // Screenshot capture failed
    }
  } finally {
    result.durationMs = Date.now() - start;

    // Capture video path before closing the page
    try {
      const video = page.video();
      if (video) {
        result.videoPath = await video.path();
      }
    } catch {
      // Video path retrieval failed
    }

    await page.close();
  }

  return result;
}

export async function runTests(project, tests, run, db) {
  // Create artifacts directories for this run
  const runDir = path.join(ARTIFACTS_DIR, run.id);
  const videoDir = path.join(runDir, "videos");
  const screenshotDir = path.join(runDir, "screenshots");
  const traceDir = path.join(runDir, "traces");
  ensureDir(videoDir);
  ensureDir(screenshotDir);
  ensureDir(traceDir);

  // Store artifact info in run for later reference
  run.artifactsDir = runDir;
  run.artifactsUrl = `/artifacts/${run.id}`;

  const headless = (process.env.HEADLESS || "true").toLowerCase() === "true";

  const browser = await chromium.launch({
    headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (compatible; AutonomousQA/1.0)",
    recordVideo: {
      dir: videoDir,
      size: { width: 1280, height: 720 },
    },
  });

  // Start tracing for this run
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: false,
  });

  log(run, `Starting test run: ${tests.length} tests`);
  log(run, `Headed mode: ${!headless} | Video recording: enabled | Tracing: enabled`);

  for (const test of tests) {
    log(run, `  Running: ${test.name}`);
    try {
      const result = await executeTest(test, context, screenshotDir);
      run.results.push(result);

      if (result.status === "passed") {
        run.passed++;
        log(run, `    PASSED (${result.durationMs}ms)`);
      } else if (result.status === "warning") {
        run.passed++; // Count warnings as passed
        log(run, `    WARNING: ${result.error}`);
      } else {
        run.failed++;
        log(run, `    FAILED: ${result.error}`);
      }

      // Update test's last result
      if (db.tests[test.id]) {
        db.tests[test.id].lastResult = result.status;
        db.tests[test.id].lastRunAt = new Date().toISOString();
      }
    } catch (err) {
      run.failed++;
      run.results.push({
        testId: test.id,
        testName: test.name,
        status: "failed",
        error: err.message,
        durationMs: 0,
      });
      log(run, `    FAILED (exception): ${err.message}`);
    }
  }

  // Stop tracing and save trace file
  const traceFile = path.join(traceDir, "trace.zip");
  try {
    await context.tracing.stop({ path: traceFile });
    run.tracePath = traceFile;
    run.traceUrl = `/artifacts/${run.id}/traces/trace.zip`;
    log(run, `Trace saved: ${run.traceUrl}`);
  } catch (err) {
    log(run, `Warning: Failed to save trace: ${err.message}`);
  }

  await context.close();

  // After context is closed, video files are finalized
  // Map video files to test results
  try {
    const videoFiles = fs.readdirSync(videoDir);
    log(run, `Videos generated: ${videoFiles.length} files`);
    run.videos = videoFiles.map((f) => `/artifacts/${run.id}/videos/${f}`);

    // Assign video URLs to results using the captured videoPath
    for (const result of run.results) {
      if (result.videoPath) {
        const filename = path.basename(result.videoPath);
        result.videoUrl = `/artifacts/${run.id}/videos/${filename}`;
      }
    }
  } catch (err) {
    log(run, `Warning: Could not read video directory: ${err.message}`);
  }

  await browser.close();

  run.status = "completed";
  run.finishedAt = new Date().toISOString();
  log(
    run,
    `Run complete: ${run.passed} passed, ${run.failed} failed out of ${run.total}`
  );

  // Emit run completed event for SSE
  runEvents.emit(`complete:${run.id}`, run);
}

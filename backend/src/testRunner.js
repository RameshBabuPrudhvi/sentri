import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts");
const VIDEOS_DIR    = path.join(ARTIFACTS_DIR, "videos");
const TRACES_DIR    = path.join(ARTIFACTS_DIR, "traces");
const SHOTS_DIR     = path.join(ARTIFACTS_DIR, "screenshots");

[ARTIFACTS_DIR, VIDEOS_DIR, TRACES_DIR, SHOTS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function log(run, msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  run.logs.push(entry);
  console.log(entry);
}

async function executeTest(test, context, runId, stepIndex, runStart) {
  const page = await context.newPage();
  const networkLogs = [];
  const consoleLogs = [];

  const result = {
    testId: test.id,
    testName: test.name,
    status: "passed",
    durationMs: 0,
    error: null,
    screenshot: null,
    screenshotPath: null,
    runTimestamp: 0,
    network: [],
    consoleLogs: [],
    domSnapshot: null,
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

  try {
    await page.goto(test.sourceUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(500);

    if (test.type === "visibility") {
      const title = await page.title();
      if (!title) throw new Error("Page has no title");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const errorPatterns = ["404", "not found", "500", "forbidden"];
      if (errorPatterns.some((p) => bodyText.toLowerCase().includes(p))) {
        const h1 = await page.locator("h1").first().innerText().catch(() => "");
        if (errorPatterns.some((p) => h1.toLowerCase().includes(p)))
          throw new Error(`Error page detected: ${h1}`);
      }
    }

    if (test.type === "navigation") {
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const url = page.url();
      if (!url.startsWith("http")) throw new Error("Invalid URL after navigation");
    }

    if (test.type === "form") {
      const forms = await page.locator("form").count();
      const inputs = await page.locator("input:visible").count();
      if (forms === 0 && inputs === 0) {
        result.status = "warning";
        result.error = "No forms found on page (may have changed)";
      }
    }

    if (test.type === "interaction") {
      const buttons = page.locator("button:visible, [role='button']:visible");
      const count = await buttons.count();
      if (count > 0) {
        const isEnabled = await buttons.first().isEnabled().catch(() => false);
        if (!isEnabled) {
          result.status = "warning";
          result.error = "Primary button appears disabled";
        }
      }
    }

    // DOM snapshot
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

    // Screenshot
    const shotName = `${runId}-step${stepIndex}.png`;
    const shotPath = path.join(SHOTS_DIR, shotName);
    const buf = await page.screenshot({ type: "png", fullPage: false });
    fs.writeFileSync(shotPath, buf);
    result.screenshot = buf.toString("base64");
    result.screenshotPath = `/artifacts/screenshots/${shotName}`;

  } catch (err) {
    result.status = "failed";
    result.error = err.message;
    try {
      const buf = await page.screenshot({ type: "png" });
      result.screenshot = buf.toString("base64");
    } catch {}
  } finally {
    result.durationMs = Date.now() - start;
    result.runTimestamp = start - runStart;
    result.network = networkLogs;
    result.consoleLogs = consoleLogs;
    await page.close();
  }

  return result;
}

export async function runTests(project, tests, run, db) {
  const runId = run.id;
  const tracePath = path.join(TRACES_DIR, `${runId}.zip`);
  const videoDir = path.join(VIDEOS_DIR, runId);
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (compatible; AutonomousQA/1.0)",
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  });

  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  log(run, `🚀 Starting test run: ${tests.length} tests`);

  const runStart = Date.now();

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    log(run, `  ▶ Running: ${test.name}`);
    try {
      const result = await executeTest(test, context, runId, i, runStart);
      run.results.push(result);

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

  try {
    await context.tracing.stop({ path: tracePath });
    run.tracePath = `/artifacts/traces/${runId}.zip`;
    log(run, `  📊 Trace saved`);
  } catch (e) {
    log(run, `  ⚠️  Trace save failed: ${e.message}`);
  }

  await context.close();
  await browser.close();

  try {
    const files = fs.readdirSync(videoDir);
    if (files.length > 0) {
      const src = path.join(videoDir, files[0]);
      const dst = path.join(VIDEOS_DIR, `${runId}.webm`);
      fs.renameSync(src, dst);
      fs.rmdirSync(videoDir, { recursive: true });
      run.videoPath = `/artifacts/videos/${runId}.webm`;
      log(run, `  🎬 Video saved: ${run.videoPath}`);
    }
  } catch (e) {
    log(run, `  ⚠️  Video move failed: ${e.message}`);
  }

  run.status = "completed";
  run.finishedAt = new Date().toISOString();
  run.duration = Date.now() - runStart;
  log(run, `🏁 Run complete: ${run.passed} passed, ${run.failed} failed out of ${run.total}`);
}

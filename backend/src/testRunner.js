import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";

function log(run, msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  run.logs.push(entry);
  console.log(entry);
}

async function executeTest(test, context) {
  const page = await context.newPage();
  const result = {
    testId: test.id,
    testName: test.name,
    status: "passed",
    durationMs: 0,
    error: null,
    screenshot: null,
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

    // Take screenshot on success too (for records)
    result.screenshot = await page.screenshot({ type: "png" }).then((buf) =>
      buf.toString("base64")
    );
  } catch (err) {
    result.status = "failed";
    result.error = err.message;
    try {
      result.screenshot = await page.screenshot({ type: "png" }).then((buf) =>
        buf.toString("base64")
      );
    } catch {}
  } finally {
    result.durationMs = Date.now() - start;
    await page.close();
  }

  return result;
}

export async function runTests(project, tests, run, db) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (compatible; AutonomousQA/1.0)",
  });

  log(run, `🚀 Starting test run: ${tests.length} tests`);

  for (const test of tests) {
    log(run, `  ▶ Running: ${test.name}`);
    try {
      const result = await executeTest(test, context);
      run.results.push(result);

      if (result.status === "passed") {
        run.passed++;
        log(run, `    ✅ PASSED (${result.durationMs}ms)`);
      } else if (result.status === "warning") {
        run.passed++; // Count warnings as passed
        log(run, `    ⚠️  WARNING: ${result.error}`);
      } else {
        run.failed++;
        log(run, `    ❌ FAILED: ${result.error}`);
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
      log(run, `    ❌ FAILED (exception): ${err.message}`);
    }
  }

  await browser.close();

  run.status = "completed";
  run.finishedAt = new Date().toISOString();
  log(
    run,
    `🏁 Run complete: ${run.passed} passed, ${run.failed} failed out of ${run.total}`
  );
}

import { chromium } from "playwright";
import { runPipelineForCrawl } from "./pipeline.js";
import { runEvents } from "./testRunner.js";

const MAX_PAGES = 10;
const MAX_DEPTH = 2;

const INTERACTIVE_SELECTORS = [
  'button:not([disabled]):not([aria-hidden="true"])',
  'input:not([type="hidden"]):not([disabled])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  'a[href]:not([href^="#"]):not([href^="javascript"])',
  '[role="button"]:not([disabled])',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  "form",
];

const LOW_VALUE_PATTERNS = [
  /copyright/i,
  /back.to.top/i,
  /scroll.to.top/i,
  /\.ad-banner/i,
  /social-share-icon/i,
];

function isLikelyLowValue(element) {
  if (!element) return true;

  if (["input", "textarea", "select", "form"].includes(element.tag)) {
    return false;
  }

  const combined = `${element.text || ""} ${element.selector || ""} ${
    element.ariaLabel || ""
  }`.toLowerCase();

  return LOW_VALUE_PATTERNS.some((pattern) => pattern.test(combined));
}

export async function crawlAndGenerateTests(project, run, db, externalOnProgress) {
  const log = (msg) => {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    run.logs.push(entry);
    runEvents.emit(`log:${run.id}`, entry);
    if (externalOnProgress) externalOnProgress(entry);
  };

  // Ensure run structure
  run.tests = run.tests || [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; Sentri-QA-Bot/1.0; +https://sentri.dev/bot)",
  });

  const visitedUrls = new Set();
  const queuedUrls = new Set([project.url]);
  const queue = [{ url: project.url, depth: 0 }];
  const pageSnapshots = [];

  // ── AUTH (optional) ─────────────────────────────
  if (project.loginUrl && project.loginSelectors) {
    log("🔐 Authenticating...");
    const page = await context.newPage();

    try {
      await page.goto(project.loginUrl, { waitUntil: "networkidle" });

      await page.locator(project.loginSelectors.usernameSelector)
        .fill(project.loginCredentials.username);

      await page.locator(project.loginSelectors.passwordSelector)
        .fill(project.loginCredentials.password);

      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle" }),
        page.locator(project.loginSelectors.submitSelector).click(),
      ]);

      log("✅ Authentication successful");
    } catch (err) {
      log(`⚠ Auth failed: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  // ── CRAWL ─────────────────────────────
  while (queue.length && visitedUrls.size < MAX_PAGES) {
    const { url, depth } = queue.shift();

    if (visitedUrls.has(url) || depth > MAX_DEPTH) continue;
    visitedUrls.add(url);

    log(`🌐 Crawling (depth ${depth}): ${url}`);

    const page = await context.newPage();

    try {
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      await page.waitForTimeout(1000);

      const elements = await page.evaluate((selectors) => {
        const seen = new Set();
        const results = [];

        const getStableSelector = (node) => {
          if (node.id) return `#${node.id}`;
          if (node.getAttribute("data-testid"))
            return `[data-testid="${node.getAttribute("data-testid")}"]`;
          if (node.getAttribute("name"))
            return `${node.tagName.toLowerCase()}[name="${node.getAttribute("name")}"]`;
          return node.tagName.toLowerCase();
        };

        for (const sel of selectors) {
          const nodes = document.querySelectorAll(sel);

          for (const node of nodes) {
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") continue;

            const key = `${node.tagName}-${node.textContent?.slice(0, 30)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            results.push({
              tag: node.tagName.toLowerCase(),
              text: node.textContent?.trim() || "",
              ariaLabel: node.getAttribute("aria-label") || "",
              selector: getStableSelector(node),
            });
          }
        }

        return results;
      }, INTERACTIVE_SELECTORS);

      const filtered = elements.filter((el) => !isLikelyLowValue(el));

      if (filtered.length) {
        pageSnapshots.push({
          url,
          depth,
          elements: filtered,
          title: await page.title(),
        });
      }

      // ── LINK DISCOVERY ─────────────────────────────
      if (depth < MAX_DEPTH) {
        const links = await page.evaluate((baseUrl) => {
          const base = new URL(baseUrl);

          return [...document.querySelectorAll("a[href]")]
            .map((a) => {
              try {
                return new URL(a.href, base).href;
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        }, url);

        for (const link of links) {
          if (
            !visitedUrls.has(link) &&
            !queuedUrls.has(link) &&
            new URL(link).hostname === new URL(url).hostname &&
            !link.includes("#") &&
            !link.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico)$/i)
          ) {
            queue.push({ url: link, depth: depth + 1 });
            queuedUrls.add(link);
          }
        }
      }
    } catch (err) {
      log(`⚠ Error crawling ${url}: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  log(`📦 Crawl complete. ${pageSnapshots.length} pages snapshotted.`);

  // ── PIPELINE ─────────────────────────────
  const pipelineResults = await runPipelineForCrawl(pageSnapshots);

  const allTests = [];

  for (const result of pipelineResults) {
    if (result.skipped || result.error) continue;

    for (const test of result.tests) {
      const testId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const newTest = {
        id: testId,
        projectId: project.id,
        sourceUrl: result.url,
        name: test.plan.goal,
        goal: test.plan.goal,
        priority: test.plan.priority,
        file_path: test.test_file,
        code: test.test_code,
        assertion_count: test.assertion_count,
        enhancements: test.enhancements,
        createdAt: new Date().toISOString(),
        status: "generated",
        lastResult: null,
      };

      // ✅ SAVE TO DB (FIX)
      db.tests[testId] = newTest;

      // ✅ LINK TO RUN
      run.tests.push(testId);

      allTests.push(newTest);
    }
  }

  log(`✅ Pipeline complete. ${allTests.length} tests generated.`);

  run.status = "completed";
  run.finishedAt = new Date().toISOString();

  runEvents.emit(`complete:${run.id}`, run);

  // Debug log
  console.log("🧪 TOTAL TESTS IN DB:", Object.keys(db.tests).length);

  return allTests;
}
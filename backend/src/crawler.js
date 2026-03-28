/**
 * Sentri — Updated Crawler
 *
 * Replaces the old approach of "send each page snapshot directly to Claude
 * and generate 2–4 tests" with the new 5-stage pipeline:
 *
 *   crawl → filter → planner → executor → assertion_enhancer
 *
 * The auditor is called separately after test execution.
 */

import { chromium } from "playwright";
import { runPipelineForCrawl } from "./pipeline.js";
import { runEvents } from "./testRunner.js";

const MAX_PAGES = 20;
const MAX_DEPTH = 3;

/**
 * ELEMENT CATEGORIZATION
 * Raw heuristics to pre-label elements before sending to Filter agent.
 * This reduces LLM token usage — the Filter agent makes final decisions.
 */
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

// Patterns that almost always indicate low-value elements
const LOW_VALUE_PATTERNS = [
  /copyright/i,
  /back.to.top/i,
  /scroll.to.top/i,
  /\.ad-banner/i,
  /social-share-icon/i,
];

function isLikelyLowValue(element) {
  // Never pre-filter inputs — let the LLM decide
  if (element.tag === "input" || element.tag === "textarea" || element.tag === "select" || element.tag === "form") {
    return false;
  }
  const combined = `${element.text} ${element.selector} ${element.ariaLabel}`.toLowerCase();
  return LOW_VALUE_PATTERNS.some((pattern) => pattern.test(combined));
}

/**
 * Crawl a web application and generate high-quality tests.
 *
 * @param {object} project - Project config from DB
 * @param {function} onProgress - Callback for streaming progress to frontend
 * @returns {Promise<Array>} Array of enhanced test objects ready for storage
 */
export async function crawlAndGenerateTests(project, run, db) {
  const onProgress = (msg) => {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    run.logs.push(entry);
    runEvents.emit(`log:${run.id}`, entry);
  };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; Sentri-QA-Bot/1.0; +https://sentri.dev/bot)",
  });

  const visitedUrls = new Set();
  const queue = [{ url: project.url, depth: 0 }];
  const pageSnapshots = [];

  // ── Optional: Authenticate before crawling ────────────────────────────────
  if (project.loginUrl && project.loginSelectors) {
    onProgress("Authenticating before crawl...");
    const authPage = await context.newPage();
    try {
      await authPage.goto(project.loginUrl, { waitUntil: "networkidle" });
      await authPage
        .locator(project.loginSelectors.usernameSelector)
        .fill(project.loginCredentials.username);
      await authPage
        .locator(project.loginSelectors.passwordSelector)
        .fill(project.loginCredentials.password);
      await authPage
        .locator(project.loginSelectors.submitSelector)
        .click();
      await authPage.waitForNavigation({ waitUntil: "networkidle" });
      onProgress("Authentication successful.");
    } catch (err) {
      onProgress(`⚠ Authentication failed: ${err.message}`);
    } finally {
      await authPage.close();
    }
  }

  // ── BFS Crawl ─────────────────────────────────────────────────────────────
  while (queue.length > 0 && visitedUrls.size < MAX_PAGES) {
    const { url, depth } = queue.shift();

    if (visitedUrls.has(url) || depth > MAX_DEPTH) continue;
    visitedUrls.add(url);

    onProgress(`Crawling (depth ${depth}): ${url}`);

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(1000); // Allow dynamic content to settle

      // ── Snapshot interactive elements ────────────────────────────────────
      const elements = await page.evaluate((selectors) => {
        const seen = new Set();
        const results = [];

        for (const sel of selectors) {
          const nodes = document.querySelectorAll(sel);
          for (const node of nodes) {
            // Skip invisible elements
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (
              getComputedStyle(node).display === "none" ||
              getComputedStyle(node).visibility === "hidden"
            )
              continue;

            // Unique key to avoid duplicates in snapshot
            const key = `${node.tagName}:${node.textContent?.trim().slice(0, 50)}:${node.getAttribute("aria-label")}`;
            if (seen.has(key)) continue;
            seen.add(key);

            results.push({
              tag: node.tagName.toLowerCase(),
              type: node.getAttribute("type") || null,
              text: node.textContent?.trim().slice(0, 100) || "",
              ariaLabel: node.getAttribute("aria-label") || "",
              ariaRole: node.getAttribute("role") || "",
              placeholder: node.getAttribute("placeholder") || "",
              href: node.getAttribute("href") || null,
              name: node.getAttribute("name") || "",
              id: node.id || "",
              classes: node.className || "",
              isInForm: !!node.closest("form"),
              // Derive a reasonable selector
              selector: node.id
                ? `#${node.id}`
                : node.getAttribute("data-testid")
                  ? `[data-testid="${node.getAttribute("data-testid")}"]`
                  : node.getAttribute("aria-label")
                    ? `[aria-label="${node.getAttribute("aria-label")}"]`
                    : `${node.tagName.toLowerCase()}${node.className ? "." + node.className.split(" ")[0] : ""}`,
            });
          }
        }
        return results;
      }, INTERACTIVE_SELECTORS);

      // Pre-filter obvious low-value elements (saves LLM tokens)
      const preFiltered = elements.filter((el) => !isLikelyLowValue(el));

      if (preFiltered.length > 0) {
        pageSnapshots.push({
          url,
          depth,
          elements: preFiltered,
          title: await page.title(),
        });
      }

      // ── Enqueue internal links ─────────────────────────────────────────
      if (depth < MAX_DEPTH) {
        const links = await page.evaluate((baseUrl) => {
          const base = new URL(baseUrl);
          return Array.from(document.querySelectorAll("a[href]"))
            .map((a) => {
              try {
                return new URL(a.href, base).href;
              } catch {
                return null;
              }
            })
            .filter(
              (href) =>
                href &&
                new URL(href).hostname === base.hostname &&
                !href.includes("#") &&
                !href.match(/\.(pdf|zip|png|jpg|jpeg|gif|svg|ico|xml|txt)$/i)
            );
        }, url);

        for (const link of links) {
          if (!visitedUrls.has(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    } catch (err) {
      onProgress(`⚠ Error crawling ${url}: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  onProgress(
    `Crawl complete. ${pageSnapshots.length} pages snapshotted. Running AI pipeline...`
  );

  // ── Run the 5-stage AI pipeline ───────────────────────────────────────────
  const pipelineResults = await runPipelineForCrawl(pageSnapshots);

  // Flatten tests and add metadata
  const allTests = [];
  for (const result of pipelineResults) {
    if (result.skipped || result.error) continue;
    for (const test of result.tests) {
      allTests.push({
        id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        project_id: project.id,
        page_url: result.url,
        goal: test.plan.goal,
        priority: test.plan.priority,
        file_path: test.test_file,
        code: test.test_code,
        assertion_count: test.assertion_count,
        enhancements: test.enhancements,
        created_at: new Date().toISOString(),
        status: "generated",
      });
    }
  }

  onProgress(
    `✅ Pipeline complete. ${allTests.length} high-quality tests generated.`
  );
  run.status = "completed";
  run.finishedAt = new Date().toISOString();
  runEvents.emit(`complete:${run.id}`, run);
  return allTests;
}

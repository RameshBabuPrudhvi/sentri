/**
 * crawlBrowser.js — Playwright browser crawl loop
 *
 * Launches a browser, optionally logs in, crawls same-origin pages using
 * SmartCrawlQueue, captures DOM snapshots, and returns the results.
 *
 * Exports:
 *   crawlPages(project, run, { signal }) → { snapshots, snapshotsByUrl }
 */

import { chromium } from "playwright";
import { throwIfAborted } from "../utils/abortHelper.js";
import { SmartCrawlQueue, fingerprintStructure, extractPathPattern } from "./smartCrawl.js";
import { takeSnapshot } from "./pageSnapshot.js";
import { log, logWarn, logSuccess } from "../utils/runLogger.js";

const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES, 10) || 30;
const MAX_DEPTH = parseInt(process.env.CRAWL_MAX_DEPTH, 10) || 3;

/**
 * Crawl same-origin pages starting from project.url.
 *
 * @param {object} project        — project record (url, credentials)
 * @param {object} run            — mutable run record (logs, pagesFound, pages)
 * @param {object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ snapshots: object[], snapshotsByUrl: Record<string, object> }>}
 */
export async function crawlPages(project, run, { signal } = {}) {
  const browser = await chromium.launch({
    headless: process.env.BROWSER_HEADLESS !== "false",
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 (compatible; Sentri/1.0)" });

  const crawlQueue = new SmartCrawlQueue(project.url);
  crawlQueue.enqueue(project.url, 0);

  const snapshots = [];
  const snapshotsByUrl = {};
  const pathPatternsSeen = new Set();

  // ── Optional login ──────────────────────────────────────────────────────
  if (project.credentials?.usernameSelector) {
    const loginPage = await context.newPage();
    try {
      await loginPage.goto(project.url, { timeout: 15000 });
      await loginPage.fill(project.credentials.usernameSelector, project.credentials.username);
      await loginPage.fill(project.credentials.passwordSelector, project.credentials.password);
      await loginPage.click(project.credentials.submitSelector);
      await loginPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      log(run, `🔑 Logged in as ${project.credentials.username}`);
    } catch (e) {
      logWarn(run, `Login failed: ${e.message}`);
    }
    await loginPage.close();
  }

  // ── Crawl loop ──────────────────────────────────────────────────────────
  while (crawlQueue.hasMore() && crawlQueue.visitedCount < MAX_PAGES) {
    if (signal?.aborted) { await browser.close(); throwIfAborted(signal); }
    const item = crawlQueue.dequeue();
    if (!item) break;
    const { url, depth } = item;

    crawlQueue.markVisited(url);

    const pathPattern = extractPathPattern(url);
    if (pathPatternsSeen.has(pathPattern) && depth > 0) {
      log(run, `⏭️  Skipping duplicate structure: ${url}`);
      continue;
    }
    pathPatternsSeen.add(pathPattern);

    const page = await context.newPage();
    try {
      log(run, `📄 Visiting (depth ${depth}): ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      // takeSnapshot() now calls waitForLoadState('networkidle') internally,
      // so we no longer need the arbitrary 800ms static wait here.

      const snapshot = await takeSnapshot(page);

      const structureFP = fingerprintStructure(snapshot);
      if (crawlQueue.isStructureDuplicate(structureFP) && depth > 1) {
        log(run, `⏭️  Skipping duplicate layout: ${url}`);
        await page.close();
        continue;
      }
      crawlQueue.markStructureSeen(structureFP);

      snapshots.push(snapshot);
      snapshotsByUrl[url] = snapshot;
      run.pagesFound = snapshots.length;
      // Keep run.pages in sync so the frontend site graph updates live
      run.pages = snapshots.map(s => ({ url: s.url, title: s.title || s.url, status: "crawled" }));

      if (depth < MAX_DEPTH) {
        const links = await page.$$eval("a[href]", els => els.map(e => e.href));
        for (const href of links) {
          try {
            const u = new URL(href, url);
            u.hash = "";
            u.search = "";
            const normalized = u.toString();
            if (new URL(normalized).origin === new URL(project.url).origin) {
              crawlQueue.enqueue(normalized, depth + 1);
            }
          } catch {}
        }
      }
    } catch (err) {
      logWarn(run, `Failed: ${url} — ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  logSuccess(run, `Smart crawl done. ${snapshots.length} unique pages found.`);

  return { snapshots, snapshotsByUrl };
}

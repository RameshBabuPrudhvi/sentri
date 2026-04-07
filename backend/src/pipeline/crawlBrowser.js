/**
 * @module pipeline/crawlBrowser
 * @description Playwright browser crawl loop. Launches Chromium, optionally
 * logs in, crawls same-origin pages via SmartCrawlQueue, and captures DOM snapshots.
 *
 * ### Exports
 * - {@link crawlPages} — `(project, run, { signal }) → { snapshots, snapshotsByUrl }`
 */

import { throwIfAborted } from "../utils/abortHelper.js";
import { SmartCrawlQueue, fingerprintStructure, extractPathPattern } from "./smartCrawl.js";
import { takeSnapshot } from "./pageSnapshot.js";
import { log, logWarn, logSuccess } from "../utils/runLogger.js";
import { decryptCredentials } from "../utils/credentialEncryption.js";
import { createHarCapture, summariseApiEndpoints } from "./harCapture.js";
import { launchBrowser } from "../runner/config.js";

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
  const browser = await launchBrowser();

  const snapshots = [];
  const snapshotsByUrl = {};
  let harCapture = null;

  try {
    const context = await browser.newContext({ userAgent: "Mozilla/5.0 (compatible; Sentri/1.0)" });

    const crawlQueue = new SmartCrawlQueue(project.url);
    crawlQueue.enqueue(project.url, 0);

    const pathPatternsSeen = new Set();

    // ── Optional login ──────────────────────────────────────────────────────
    const creds = decryptCredentials(project.credentials);
    if (creds?.usernameSelector) {
      const loginPage = await context.newPage();
      try {
        await loginPage.goto(project.url, { timeout: 15000 });
        await loginPage.fill(creds.usernameSelector, creds.username);
        await loginPage.fill(creds.passwordSelector, creds.password);
        await loginPage.click(creds.submitSelector);
        await loginPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        log(run, `🔑 Logged in as ${creds.username}`);
      } catch (e) {
        logWarn(run, `Login failed: ${e.message}`);
      } finally {
        await loginPage.close().catch(() => {});
      }
    }

    // ── Resolve actual origin after redirects ────────────────────────────────
    // Navigate once to discover the real origin (e.g. http → https, www →
    // non-www) BEFORE attaching HAR capture. Without this, createHarCapture
    // filters by the user-entered origin which may differ from the resolved
    // one, causing all API traffic to be silently dropped.
    const probePage = await context.newPage();
    let resolvedOrigin = project.url;
    try {
      await probePage.goto(project.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      resolvedOrigin = probePage.url();
      if (resolvedOrigin !== project.url) {
        log(run, `🔀 Redirected: ${project.url} → ${resolvedOrigin}`);
      }
    } catch { /* fall back to user-entered URL */ }
    finally { await probePage.close().catch(() => {}); }

    // ── HAR capture: attach AFTER redirect so it uses the resolved origin ──
    harCapture = createHarCapture(context, resolvedOrigin);

    // ── Crawl loop ──────────────────────────────────────────────────────────
    while (crawlQueue.hasMore() && crawlQueue.visitedCount < MAX_PAGES) {
      if (signal?.aborted) { throwIfAborted(signal); }
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

    // ── Summarise captured API traffic (before browser.close) ──────────────
    if (harCapture) {
      harCapture.detach();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  let apiEndpoints = [];
  if (harCapture) {
    apiEndpoints = summariseApiEndpoints(harCapture.getEntries());
    if (apiEndpoints.length > 0) {
      log(run, `🌐 Captured ${harCapture.getEntries().length} API calls → ${apiEndpoints.length} unique endpoint patterns`);
    }
  }

  logSuccess(run, `Smart crawl done. ${snapshots.length} unique pages found.`);

  return { snapshots, snapshotsByUrl, apiEndpoints };
}

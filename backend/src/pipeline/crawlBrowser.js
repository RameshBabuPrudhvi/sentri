/**
 * @module pipeline/crawlBrowser
 * @description Playwright browser crawl loop. Launches Chromium, optionally
 * logs in, crawls same-origin pages via SmartCrawlQueue, and captures DOM snapshots.
 *
 * ### Exports
 * - {@link crawlPages} — `(project, run, { signal }) → { snapshots, snapshotsByUrl }`
 */

import { throwIfAborted } from "../utils/abortHelper.js";
import { SmartCrawlQueue, fingerprintStructure, extractPathPattern, stripNoiseParams } from "./smartCrawl.js";
import { takeSnapshot } from "./pageSnapshot.js";
import { log, logWarn, logSuccess, emitRunEvent } from "../utils/runLogger.js";
import * as runRepo from "../database/repositories/runRepo.js";
import { signRunArtifacts } from "../middleware/appSetup.js";
import { decryptCredentials } from "../utils/credentialEncryption.js";
import { createHarCapture, summariseApiEndpoints } from "./harCapture.js";
import { launchBrowser } from "../runner/config.js";
import { loadRobotsRules, isAllowed, loadSitemapUrls } from "../utils/robotsSitemap.js";
import { getDatabase } from "../database/sqlite.js";
import { AxeBuilder } from "@axe-core/playwright";

const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES, 10) || 30;
const MAX_DEPTH = parseInt(process.env.CRAWL_MAX_DEPTH, 10) || 3;

/**
 * Normalize axe-core results into persistable records.
 *
 * @param {string} runId
 * @param {string} pageUrl
 * @param {object} results - Axe-core results object (`{ violations: [...] }`), or null/undefined.
 * @returns {object[]} Array of persistable violation records with shape
 *   `{ runId, pageUrl, ruleId, impact, wcagCriterion, help, description, nodesJson }`.
 */
export function mapA11yViolations(runId, pageUrl, results) {
  const violations = Array.isArray(results?.violations) ? results.violations : [];
  return violations.map((violation) => {
    const tags = Array.isArray(violation.tags) ? violation.tags : [];
    const wcagTag = tags.find((tag) => /^wcag\d{3,4}$/i.test(tag)) || null;
    return {
      runId,
      pageUrl,
      ruleId: violation.id || "unknown",
      impact: violation.impact || null,
      wcagCriterion: wcagTag,
      help: violation.help || "",
      description: violation.description || "",
      nodesJson: JSON.stringify(Array.isArray(violation.nodes) ? violation.nodes : []),
    };
  });
}

/**
 * Check if two URLs share the same effective origin (protocol + host + port).
 * Treats www.example.com and example.com as equivalent — matches stateExplorer.js.
 * @param {string} urlA
 * @param {string} urlB
 * @returns {boolean}
 */
function isSameEffectiveOrigin(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    const normHost = h => h.replace(/^www\./i, "").toLowerCase();
    return a.protocol === b.protocol && normHost(a.hostname) === normHost(b.hostname) && a.port === b.port;
  } catch { return false; }
}

/**
 * Crawl same-origin pages starting from project.url.
 *
 * @param {object} project        — project record (url, credentials)
 * @param {object} run            — mutable run record (logs, pagesFound, pages)
 * @param {object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ snapshots: object[], snapshotsByUrl: Record<string, object>, apiEndpoints: object[], navigationFailures: Array<{url:string, message:string, category:string}> }>}
 */
export async function crawlPages(project, run, { signal } = {}) {
  const browser = await launchBrowser();
  const db = getDatabase();

  const snapshots = [];
  const snapshotsByUrl = {};
  /** @type {Array<{url:string, message:string, category:string}>} */
  const navigationFailures = [];
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
    } catch (err) {
      // Surface probe-navigation failures so the caller can classify fully
      // unreachable targets (e.g. DNS failures) as failed runs instead of
      // "completed empty". The existing BFS loop still records per-URL
      // failures, but the probe failure matters when the target's root page
      // is the first thing that breaks.
      const failMsg = err?.message || String(err);
      navigationFailures.push({
        url: project.url,
        message: failMsg,
        category: categoriseNavigationError(failMsg),
      });
    }
    finally { await probePage.close().catch(() => {}); }

    // ── HAR capture: attach AFTER redirect so it uses the resolved origin ──
    harCapture = createHarCapture(context, resolvedOrigin);

    // ── robots.txt + sitemap.xml (#53) ──────────────────────────────────────
    const robotsRules = await loadRobotsRules(resolvedOrigin);
    if (robotsRules.rules.length > 0) {
      log(run, `🤖 robots.txt: ${robotsRules.rules.length} rule(s) loaded — restricted paths will be skipped`);
    }
    const sitemapUrls = await loadSitemapUrls(resolvedOrigin, robotsRules.sitemaps);
    if (sitemapUrls.length > 0) {
      log(run, `🗺️  sitemap.xml: ${sitemapUrls.length} URL(s) discovered — seeding crawl queue`);
      for (const sitemapUrl of sitemapUrls) {
        if (isSameEffectiveOrigin(sitemapUrl, resolvedOrigin) && isAllowed(sitemapUrl, robotsRules)) {
          crawlQueue.enqueue(sitemapUrl, 1);
        }
      }
    }

    // ── Crawl loop ──────────────────────────────────────────────────────────
    while (crawlQueue.hasMore() && crawlQueue.visitedCount < MAX_PAGES) {
      if (signal?.aborted) { throwIfAborted(signal); }
      const item = crawlQueue.dequeue();
      if (!item) break;
      const { url, depth } = item;

      // robots.txt compliance (#53) — skip disallowed paths
      // Check BEFORE markVisited so disallowed URLs don't consume crawl budget.
      if (!isAllowed(url, robotsRules)) {
        log(run, `🚫 Skipping (robots.txt): ${url}`);
        continue;
      }

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

        // ── Shadow DOM: inject queryShadowAll helper and collect elements ──
        // Modern enterprise apps (Angular, Lit, Stencil, Salesforce LWC) encapsulate
        // UI inside shadow roots that are invisible to standard page.$$() queries.
        // We inject a recursive helper once per page, call it with common interactive
        // selectors, and attach any found elements to the snapshot so elementFilter.js
        // can score and surface them alongside regular DOM elements.
        let shadowElements = [];
        try {
          shadowElements = await page.evaluate(() => {
            // Recursively traverse all shadow roots in the document.
            // Returns a flat array of plain objects (must be serialisable across
            // the evaluate boundary — no DOM node references).
            function queryShadowAll(selector, root = document, insideShadow = false) {
              const results = [];
              // Walk every element in this root
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              let node = walker.nextNode();
              while (node) {
                // Only collect matching elements when we are inside a shadow root —
                // light DOM elements are already captured by takeSnapshot().
                if (insideShadow && node.matches && node.matches(selector)) {
                  const rect = node.getBoundingClientRect();
                  results.push({
                    tag: node.tagName.toLowerCase(),
                    type: node.getAttribute("type") || "",
                    text: (node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || "").trim().slice(0, 200),
                    href: node.getAttribute("href") || "",
                    role: node.getAttribute("role") || "",
                    ariaLabel: node.getAttribute("aria-label") || "",
                    placeholder: node.getAttribute("placeholder") || "",
                    visible: rect.width > 0 && rect.height > 0,
                    _fromShadow: true,
                  });
                }
                // Recurse into this node's shadow root if it has one
                if (node.shadowRoot) {
                  const inner = queryShadowAll(selector, node.shadowRoot, true);
                  results.push(...inner);
                }
                node = walker.nextNode();
              }
              return results;
            }

            // Selectors covering the interactive elements most likely to be
            // test-worthy inside shadow DOM components
            const SHADOW_INTERACTIVE_SELECTORS = [
              "button",
              "a[href]",
              "input",
              "textarea",
              "select",
              "[role='button']",
              "[role='link']",
              "[role='menuitem']",
              "[role='tab']",
              "[role='checkbox']",
              "[role='radio']",
              "[role='switch']",
              "[role='textbox']",
              "[role='searchbox']",
              "[role='combobox']",
            ].join(", ");

            return queryShadowAll(SHADOW_INTERACTIVE_SELECTORS);
          });
        } catch (shadowErr) {
          // Shadow DOM traversal is best-effort — never break the crawl
          shadowElements = [];
        }

        const snapshot = await takeSnapshot(page);

        let a11yViolations = [];
        try {
          const axeResults = await new AxeBuilder({ page }).analyze();
          a11yViolations = mapA11yViolations(run.id, url, axeResults);
          if (a11yViolations.length > 0) {
            const insertViolation = db.prepare(
              `INSERT INTO accessibility_violations
                (runId, pageUrl, ruleId, impact, wcagCriterion, help, description, nodesJson, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const createdAt = new Date().toISOString();
            for (const violation of a11yViolations) {
              insertViolation.run(
                violation.runId,
                violation.pageUrl,
                violation.ruleId,
                violation.impact,
                violation.wcagCriterion,
                violation.help,
                violation.description,
                violation.nodesJson,
                createdAt
              );
            }
          }
        } catch (a11yErr) {
          logWarn(run, `Accessibility scan failed on ${url}: ${a11yErr.message}`);
        }

        // Merge shadow elements into the snapshot's element list so they flow
        // through elementFilter.js scoring alongside regular DOM elements.
        if (shadowElements.length > 0) {
          snapshot.elements = [...(snapshot.elements || []), ...shadowElements];
          log(run, `🕸️  Shadow DOM: ${shadowElements.length} element(s) found inside shadow roots on ${url}`);
        }

        const structureFP = fingerprintStructure(snapshot);
        if (crawlQueue.isStructureDuplicate(structureFP) && depth > 1) {
          log(run, `⏭️  Skipping duplicate layout: ${url}`);
          await page.close();
          continue;
        }
        crawlQueue.markStructureSeen(structureFP);

        snapshots.push(snapshot);
        snapshot.accessibilityViolations = a11yViolations.map(v => ({
          ruleId: v.ruleId,
          impact: v.impact,
          wcagCriterion: v.wcagCriterion,
          help: v.help,
          description: v.description,
        }));
        snapshotsByUrl[url] = snapshot;
        run.pagesFound = snapshots.length;
        // Keep run.pages in sync so the frontend site graph updates live
        run.pages = snapshots.map(s => ({
          url: s.url,
          title: s.title || s.url,
          status: "crawled",
          accessibilityViolations: s.accessibilityViolations || [],
        }));
        // Persist to DB so the site map renders after page reload
        runRepo.update(run.id, { pages: run.pages, pagesFound: run.pagesFound });
        // Sign artifact URLs before emitting SSE snapshot (matches testRunner.js pattern)
        emitRunEvent(run.id, "snapshot", { run: signRunArtifacts(run) });

        if (depth < MAX_DEPTH) {
          const links = await page.$$eval("a[href]", els => els.map(e => e.href));
          for (const href of links) {
            try {
              const u = new URL(href, url);
              u.hash = "";
              // Strip only noise query params; preserve significant ones (#52)
              stripNoiseParams(u);
              const normalized = u.toString();
              if (!isSameEffectiveOrigin(normalized, resolvedOrigin)) continue;
              // robots.txt compliance (#53) — skip disallowed before enqueuing
              if (!isAllowed(normalized, robotsRules)) continue;
              crawlQueue.enqueue(normalized, depth + 1);
            } catch {}
          }
        }
      } catch (err) {
        const failMsg = err?.message || String(err);
        logWarn(run, `Failed: ${url} — ${failMsg}`);
        navigationFailures.push({
          url,
          message: failMsg,
          category: categoriseNavigationError(failMsg),
        });
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

  return { snapshots, snapshotsByUrl, apiEndpoints, navigationFailures };
}

/**
 * Classify a navigation failure message into a coarse category so the caller
 * can decide whether a totally-unreachable target warrants a `failed` run.
 *
 * Exported for regression tests — see `tests/dns-classification.test.js`.
 *
 * @param {string} message - Error message from `page.goto` (Playwright).
 * @returns {string} One of `"dns"`, `"network"`, `"timeout"`, or `"other"`.
 */
export function categoriseNavigationError(message) {
  const m = (message || "").toLowerCase();
  if (m.includes("err_name_not_resolved")
    || m.includes("enotfound")
    || m.includes("dns")) {
    return "dns";
  }
  if (m.includes("err_connection_refused")
    || m.includes("err_connection_reset")
    || m.includes("err_connection_closed")
    || m.includes("err_connection_timed_out")
    || m.includes("err_network")
    || m.includes("err_address_unreachable")
    || m.includes("err_internet_disconnected")
    || m.includes("err_ssl_")
    || m.includes("err_cert_")
    || m.includes("econnrefused")
    || m.includes("econnreset")
    || m.includes("enetunreach")) {
    return "network";
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return "timeout";
  }
  return "other";
}

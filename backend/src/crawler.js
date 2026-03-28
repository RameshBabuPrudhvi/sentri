/**
 * crawler.js — Sentri autonomous QA pipeline
 *
 * 7-layer pipeline:
 *   1. Smart crawl           (pipeline/smartCrawl.js)
 *   2. Element filtering     (pipeline/elementFilter.js)
 *   3. Intent classification (pipeline/intentClassifier.js)
 *   4. Journey generation    (pipeline/journeyGenerator.js)
 *   5. Deduplication         (pipeline/deduplicator.js)
 *   6. Assertion enhancement (pipeline/assertionEnhancer.js)
 *   7. Feedback loop         (pipeline/feedbackLoop.js — runs post-execution)
 */

import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { getProviderName } from "./aiProvider.js";
import { SmartCrawlQueue, fingerprintStructure, extractPathPattern } from "./pipeline/smartCrawl.js";
import { filterElements, hasHighValueElements, filterStats } from "./pipeline/elementFilter.js";
import { classifyPage, buildUserJourneys } from "./pipeline/intentClassifier.js";
import { generateAllTests } from "./pipeline/journeyGenerator.js";
import { deduplicateTests, deduplicateAcrossRuns } from "./pipeline/deduplicator.js";
import { enhanceTests } from "./pipeline/assertionEnhancer.js";

const MAX_PAGES = 20;
const MAX_DEPTH = 3;

function log(run, msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  run.logs.push(entry);
  console.log(entry);
}

async function takeSnapshot(page) {
  return page.evaluate(() => {
    const elements = [];
    document.querySelectorAll(
      "a, button, input, select, textarea, [role='button'], [role='link'], form"
    ).forEach((el) => {
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").trim().slice(0, 80);
      elements.push({
        tag: el.tagName.toLowerCase(),
        text,
        type: el.getAttribute("type") || "",
        href: el.getAttribute("href") || "",
        id: el.id || "",
        name: el.getAttribute("name") || "",
        role: el.getAttribute("role") || "",
        visible: el.offsetParent !== null,
      });
    });
    return {
      title: document.title,
      url: location.href,
      elements: elements.filter(e => e.visible).slice(0, 80),
      h1: Array.from(document.querySelectorAll("h1")).map(h => h.innerText).join(" | "),
      forms: document.querySelectorAll("form").length,
      hasLoginForm: !!document.querySelector("input[type='password']"),
    };
  });
}

export async function crawlAndGenerateTests(project, run, db) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 (compatible; Sentri/1.0)" });

  const crawlQueue = new SmartCrawlQueue(project.url);
  crawlQueue.enqueue(project.url, 0);

  const snapshots = [];
  const snapshotsByUrl = {};
  const pathPatternsSeen = new Set();

  log(run, `\u{1F577}\uFE0F  Starting smart crawl of ${project.url}`);
  log(run, `\u{1F916} AI provider: ${getProviderName()}`);

  if (project.credentials?.usernameSelector) {
    const loginPage = await context.newPage();
    try {
      await loginPage.goto(project.url, { timeout: 15000 });
      await loginPage.fill(project.credentials.usernameSelector, project.credentials.username);
      await loginPage.fill(project.credentials.passwordSelector, project.credentials.password);
      await loginPage.click(project.credentials.submitSelector);
      await loginPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      log(run, `\u{1F511} Logged in as ${project.credentials.username}`);
    } catch (e) {
      log(run, `\u26A0\uFE0F  Login failed: ${e.message}`);
    }
    await loginPage.close();
  }

  while (crawlQueue.hasMore() && crawlQueue.visitedCount < MAX_PAGES) {
    const item = crawlQueue.dequeue();
    if (!item) break;
    const { url, depth } = item;

    crawlQueue.markVisited(url);

    const pathPattern = extractPathPattern(url);
    if (pathPatternsSeen.has(pathPattern) && depth > 0) {
      log(run, `\u23ED\uFE0F  Skipping duplicate structure: ${url}`);
      continue;
    }
    pathPatternsSeen.add(pathPattern);

    const page = await context.newPage();
    try {
      log(run, `\u{1F4C4} Visiting (depth ${depth}): ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(800);

      const snapshot = await takeSnapshot(page);

      const structureFP = fingerprintStructure(snapshot);
      if (crawlQueue.isStructureDuplicate(structureFP) && depth > 1) {
        log(run, `\u23ED\uFE0F  Skipping duplicate layout: ${url}`);
        await page.close();
        continue;
      }

      crawlQueue.markStructureSeen(structureFP);

      snapshots.push(snapshot);
      snapshotsByUrl[url] = snapshot;
      run.pagesFound = snapshots.length;

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
      log(run, `\u26A0\uFE0F  Failed: ${url} \u2014 ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  log(run, `\u2705 Smart crawl done. ${snapshots.length} unique pages found.`);

  // Layer 1: Element filtering
  log(run, `\u{1F50D} Filtering elements (removing noise)...`);
  const filteredSnapshots = snapshots.map(snap => {
    const filtered = filterElements(snap.elements);
    log(run, `   ${snap.url.replace(project.url, "")}: ${filterStats(snap.elements, filtered)}`);
    return { ...snap, elements: filtered };
  });
  for (const snap of filteredSnapshots) snapshotsByUrl[snap.url] = snap;

  // Layer 2: Intent classification
  log(run, `\u{1F9E0} Classifying page intents...`);
  const classifiedPages = filteredSnapshots.map(snap => classifyPage(snap, snap.elements));
  const classifiedPagesByUrl = {};
  for (const cp of classifiedPages) {
    classifiedPagesByUrl[cp.url] = cp;
    log(run, `   ${cp.dominantIntent.padEnd(16)} ${cp.url.replace(project.url, "") || "/"}`);
  }

  // Journey detection
  const journeys = buildUserJourneys(classifiedPages);
  if (journeys.length > 0) {
    log(run, `\u{1F5FA}\uFE0F  Detected ${journeys.length} user journey(s): ${journeys.map(j => j.name).join(", ")}`);
  }

  // AI test generation
  log(run, `\u{1F916} Generating intent-driven tests...`);
  const rawTests = await generateAllTests(classifiedPages, journeys, snapshotsByUrl, (msg) => log(run, msg));
  log(run, `\u{1F4DD} Raw tests: ${rawTests.length}`);

  // Layer 3: Deduplication
  log(run, `\u{1F6AB} Deduplicating...`);
  const existingTests = Object.values(db.tests).filter(t => t.projectId === project.id);
  const { unique, removed, stats: dedupStats } = deduplicateTests(rawTests);
  const finalTests = deduplicateAcrossRuns(unique, existingTests);
  log(run, `   ${removed} duplicates removed | ${unique.length - finalTests.length} already exist | ${finalTests.length} new unique tests`);

  // Layer 4: Assertion enhancement
  log(run, `\u2728 Enhancing assertions...`);
  const { tests: enhancedTests, enhancedCount } = enhanceTests(finalTests, snapshotsByUrl, classifiedPagesByUrl);
  log(run, `   ${enhancedCount} tests had assertions strengthened`);

  // Store in db
  for (const t of enhancedTests) {
    const testId = uuidv4();
    db.tests[testId] = {
      ...t,
      id: testId,
      projectId: project.id,
      sourceUrl: t.sourceUrl,
      pageTitle: t.pageTitle,
      createdAt: new Date().toISOString(),
      lastResult: null,
      lastRunAt: null,
      qualityScore: t._quality || 0,
      isJourneyTest: t.isJourneyTest || false,
      journeyType: t.journeyType || null,
      assertionEnhanced: t._assertionEnhanced || false,
      // All crawl-generated tests start as draft — humans must approve before regression
      reviewStatus: "draft",
      reviewedAt: null,
    };
    run.tests.push(testId);
  }

  run.snapshots = filteredSnapshots;
  run.status = "completed";
  run.finishedAt = new Date().toISOString();
  run.testsGenerated = run.tests.length;
  run.pipelineStats = {
    pagesFound: snapshots.length,
    rawTestsGenerated: rawTests.length,
    duplicatesRemoved: removed,
    assertionsEnhanced: enhancedCount,
    journeysDetected: journeys.length,
    averageQuality: dedupStats.averageQuality,
  };

  log(run, `\n\u{1F4CA} Pipeline Summary:`);
  log(run, `   Pages: ${snapshots.length} | Raw tests: ${rawTests.length} | Final: ${enhancedTests.length}`);
  log(run, `   Journey tests: ${enhancedTests.filter(t => t.isJourneyTest).length} | Avg quality: ${dedupStats.averageQuality}/100`);
  log(run, `\u{1F389} Done! ${run.tests.length} high-quality tests generated.`);
}

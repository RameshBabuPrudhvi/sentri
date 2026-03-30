/**
 * crawler.js — Sentri autonomous QA pipeline
 *
 * 8-layer pipeline:
 *   1. Smart crawl           (pipeline/smartCrawl.js)
 *   2. Element filtering     (pipeline/elementFilter.js)
 *   3. Intent classification (pipeline/intentClassifier.js)
 *   4. Journey generation    (pipeline/journeyGenerator.js)
 *   5. Deduplication         (pipeline/deduplicator.js)
 *   6. Assertion enhancement (pipeline/assertionEnhancer.js)
 *   7. Validate generated tests (syntax + structure checks)
 *   8. Feedback loop         (pipeline/feedbackLoop.js — runs post-execution)
 */

import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { getProviderName } from "./aiProvider.js";
import { SmartCrawlQueue, fingerprintStructure, extractPathPattern } from "./pipeline/smartCrawl.js";
import { filterElements, hasHighValueElements, filterStats } from "./pipeline/elementFilter.js";
import { classifyPage, classifyPageWithAI, buildUserJourneys } from "./pipeline/intentClassifier.js";
import { generateAllTests, generateUserRequestedTest } from "./pipeline/journeyGenerator.js";
import { deduplicateTests, deduplicateAcrossRuns } from "./pipeline/deduplicator.js";
import { enhanceTests } from "./pipeline/assertionEnhancer.js";

const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES, 10) || 30;
const MAX_DEPTH = parseInt(process.env.CRAWL_MAX_DEPTH, 10) || 3;

function log(run, msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  run.logs.push(entry);
  console.log(entry);
}

function setStep(run, step) {
  run.currentStep = step;
}

// ── Test validation ───────────────────────────────────────────────────────────
// Rejects malformed or placeholder tests before they enter the DB.
// Returns an array of issue strings — empty means the test is valid.

function validateTest(test, projectUrl) {
  const issues = [];

  // Must have a meaningful name
  if (!test.name || test.name.trim().length < 5) {
    issues.push("name is missing or too short");
  }

  // Must have at least one step
  if (!Array.isArray(test.steps) || test.steps.length === 0) {
    issues.push("no test steps defined");
  }

  // Playwright code: if present, must be parseable (contain `async` and braces)
  if (test.playwrightCode) {
    if (!test.playwrightCode.includes("async")) {
      issues.push("playwrightCode missing async function");
    }
    if (!test.playwrightCode.includes("{")) {
      issues.push("playwrightCode missing function body");
    }
    // Reject placeholder URLs that the AI sometimes hallucinates
    if (test.playwrightCode.includes("https://example.com") ||
        test.playwrightCode.includes("http://example.com")) {
      issues.push("playwrightCode uses placeholder example.com URL");
    }
    // Must reference the actual project URL (or at least page.goto)
    if (!test.playwrightCode.includes("page.goto")) {
      issues.push("playwrightCode missing page.goto navigation");
    }
  }

  // Reject tests with duplicate/generic names the AI sometimes produces
  const genericNames = ["test 1", "test 2", "test 3", "untitled", "sample test", "example test"];
  if (test.name && genericNames.includes(test.name.toLowerCase().trim())) {
    issues.push("generic placeholder test name");
  }

  return issues;
}

const CRAWL_NETWORKIDLE_TIMEOUT = parseInt(process.env.CRAWL_NETWORKIDLE_TIMEOUT, 10) || 5000;

async function takeSnapshot(page) {
  // Wait for SPA content to settle — domcontentloaded fires too early for SPAs.
  // Try networkidle first (best for SPAs), fall back to a generous timeout.
  await page.waitForLoadState("networkidle", { timeout: CRAWL_NETWORKIDLE_TIMEOUT }).catch(() => {});

  return page.evaluate(() => {
    // Compute the effective ARIA role of an element (explicit or implicit)
    function getComputedRole(el) {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && el.getAttribute("href")) return "link";
      if (tag === "input") {
        if (type === "search") return "searchbox";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button") return "button";
        return "textbox";
      }
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      return "";
    }

    // ── Capture form structures with field relationships ──────────────────
    // This gives the AI context about which fields belong to which form,
    // enabling it to generate tests that fill forms correctly rather than
    // guessing field order from a flat element list.
    const formStructures = [];
    document.querySelectorAll("form").forEach((form, idx) => {
      const fields = [];
      form.querySelectorAll("input, select, textarea").forEach(field => {
        if (field.type === "hidden") return;
        const label = field.labels?.[0]?.innerText?.trim()
          || field.getAttribute("aria-label")
          || field.getAttribute("placeholder")
          || field.getAttribute("name")
          || "";
        fields.push({
          tag: field.tagName.toLowerCase(),
          type: field.getAttribute("type") || "",
          label: label.slice(0, 60),
          name: field.getAttribute("name") || "",
          required: field.required || field.getAttribute("aria-required") === "true",
          testId: field.getAttribute("data-testid") || field.getAttribute("data-cy") || "",
        });
      });
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      formStructures.push({
        id: form.id || `form-${idx}`,
        action: form.action || "",
        method: form.method || "get",
        fields,
        submitText: (submitBtn?.innerText || submitBtn?.value || "").trim().slice(0, 40),
      });
    });

    // ── Capture semantic page sections ────────────────────────────────────
    const sections = [];
    document.querySelectorAll("header, nav, main, aside, footer, [role='banner'], [role='navigation'], [role='main'], [role='complementary'], [role='contentinfo']").forEach(el => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || tag;
      const headings = Array.from(el.querySelectorAll("h1, h2, h3")).map(h => h.innerText.trim()).slice(0, 3);
      sections.push({ role, headings });
    });

    // ── Capture interactive elements with richer metadata ─────────────────
    const elements = [];
    document.querySelectorAll(
      "a, button, input, select, textarea, [role='button'], [role='link'], [role='combobox'], [role='searchbox'], [role='tab'], [role='menuitem'], form"
    ).forEach((el) => {
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").trim().slice(0, 80);
      const computedRole = getComputedRole(el);
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      // Find the closest label for inputs
      const labelText = el.labels?.[0]?.innerText?.trim() || "";
      elements.push({
        tag: el.tagName.toLowerCase(),
        text,
        type: el.getAttribute("type") || "",
        href: el.getAttribute("href") || "",
        id: el.id || "",
        name: el.getAttribute("name") || "",
        role: computedRole,
        ariaLabel,
        placeholder,
        label: labelText.slice(0, 60),
        testId: el.getAttribute("data-testid") || el.getAttribute("data-cy") || "",
        visible: el.offsetParent !== null,
        disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
        required: el.required || el.getAttribute("aria-required") === "true",
        // Which form does this element belong to? Helps AI group interactions.
        formId: el.closest("form")?.id || "",
      });
    });

    // ── Capture heading hierarchy for context ─────────────────────────────
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map(h => ({ level: parseInt(h.tagName[1]), text: h.innerText.trim().slice(0, 60) }))
      .slice(0, 10);

    return {
      title: document.title,
      url: location.href,
      elements: elements.filter(e => e.visible).slice(0, 100),
      h1: Array.from(document.querySelectorAll("h1")).map(h => h.innerText).join(" | "),
      headings,
      forms: document.querySelectorAll("form").length,
      formStructures,
      sections,
      hasLoginForm: !!document.querySelector("input[type='password']"),
      // Additional page signals for the AI
      hasModals: document.querySelectorAll("[role='dialog'], .modal, [aria-modal='true']").length > 0,
      hasTabs: document.querySelectorAll("[role='tablist'], [role='tab']").length > 0,
      hasTable: document.querySelectorAll("table, [role='grid']").length > 0,
      metaDescription: document.querySelector('meta[name="description"]')?.content?.slice(0, 120) || "",
    };
  });
}

/**
 * generateSingleTest — Generates ONE focused test from a user-provided
 * name + description (no crawl needed).
 *
 * Uses a dedicated AI prompt (generateUserRequestedTest) that produces
 * exactly 1 test matching the user's intent, instead of the crawl
 * pipeline's generic 5-8 tests per page.
 *
 * Pipeline:
 *   Step 1-3: SKIPPED (Crawl, Filter, Classify — user provides intent directly)
 *   Step 4: Generate     — AI generates 1 focused test from name + description
 *   Step 5: Deduplicate  — Check against existing project tests
 *   Step 6: Enhance      — Strengthen assertions
 *   Step 7: Validate     — Reject malformed / placeholder tests
 *   Step 8: Done
 */
export async function generateSingleTest(project, run, db, { name, description }) {
  log(run, `✦ Starting single-test generation pipeline for "${name}"`);
  log(run, `🤖 AI provider: ${getProviderName()}`);

  // Skip steps 1-3 — user provides the intent directly via name + description
  setStep(run, 1);
  log(run, `⏭️  Step 1 (Crawl) — skipped (user-provided title & description)`);
  setStep(run, 2);
  log(run, `⏭️  Step 2 (Filter) — skipped`);
  setStep(run, 3);
  log(run, `⏭️  Step 3 (Classify) — skipped (user already described the intent)`);

  // ── Step 4: Generate ONE focused test via AI ────────────────────────────
  // Use a dedicated prompt that generates exactly 1 test matching the user's
  // name + description, instead of the crawl pipeline's generic 5-8 tests.
  setStep(run, 4);
  log(run, `🤖 Generating test from user description...`);
  log(run, `   Name: "${name}"`);
  if (description) log(run, `   Description: "${description.slice(0, 100)}${description.length > 100 ? "…" : ""}"`);

  const rawTests = await generateUserRequestedTest(name, description, project.url);
  log(run, `📝 Raw tests generated: ${rawTests.length}`);

  // ── Step 5: Deduplicate ─────────────────────────────────────────────────
  setStep(run, 5);
  log(run, `🚫 Deduplicating...`);
  const existingTests = Object.values(db.tests).filter(t => t.projectId === project.id);
  const { unique, removed, stats: dedupStats } = deduplicateTests(rawTests);
  const finalTests = deduplicateAcrossRuns(unique, existingTests);
  log(run, `   ${removed} duplicates removed | ${unique.length - finalTests.length} already exist | ${finalTests.length} new unique tests`);

  // ── Step 6: Enhance assertions ──────────────────────────────────────────
  setStep(run, 6);
  log(run, `✨ Enhancing assertions...`);
  // No real snapshots or classified pages — enhanceTests falls back gracefully
  const snapshotsByUrl = {};
  const classifiedPagesByUrl = {};
  const { tests: enhancedTests, enhancedCount } = enhanceTests(finalTests, snapshotsByUrl, classifiedPagesByUrl);
  log(run, `   ${enhancedCount} tests had assertions strengthened`);

  // ── Step 7: Validate ────────────────────────────────────────────────────
  setStep(run, 7);
  log(run, `✅ Validating generated tests...`);
  const validatedTests = [];
  let rejected = 0;
  for (const t of enhancedTests) {
    const issues = validateTest(t, project.url);
    if (issues.length === 0) {
      validatedTests.push(t);
    } else {
      rejected++;
      log(run, `   ❌ Rejected "${t.name || "unnamed"}": ${issues.join("; ")}`);
    }
  }
  log(run, `   ${validatedTests.length} valid | ${rejected} rejected`);

  // ── Step 8: Store & Done ────────────────────────────────────────────────
  const createdTestIds = [];
  for (const t of validatedTests) {
    const testId = uuidv4();
    db.tests[testId] = {
      ...t,
      id: testId,
      projectId: project.id,
      name: t.name || name,
      description: t.description || description || "",
      sourceUrl: t.sourceUrl || project.url,
      pageTitle: t.pageTitle || project.name,
      createdAt: new Date().toISOString(),
      lastResult: null,
      lastRunAt: null,
      qualityScore: t._quality || 0,
      isJourneyTest: t.isJourneyTest || false,
      journeyType: t.journeyType || null,
      assertionEnhanced: t._assertionEnhanced || false,
      reviewStatus: "draft",
      reviewedAt: null,
    };
    run.tests.push(testId);
    createdTestIds.push(testId);
  }

  run.status = "completed";
  run.finishedAt = new Date().toISOString();
  run.testsGenerated = run.tests.length;
  setStep(run, 8);
  run.pipelineStats = {
    pagesFound: 0,
    rawTestsGenerated: rawTests.length,
    duplicatesRemoved: removed,
    assertionsEnhanced: enhancedCount,
    validationRejected: rejected,
    journeysDetected: 0,
    averageQuality: dedupStats.averageQuality,
  };

  log(run, `\n📊 Pipeline Summary:`);
  log(run, `   Raw: ${rawTests.length} | Enhanced: ${enhancedTests.length} | Validated: ${validatedTests.length} | Rejected: ${rejected}`);
  log(run, `🎉 Done! ${run.tests.length} test(s) generated for "${name}".`);

  return createdTestIds;
}

export async function crawlAndGenerateTests(project, run, db) {
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

  log(run, `\u{1F577}\uFE0F  Starting smart crawl of ${project.url}`);
  log(run, `\u{1F916} AI provider: ${getProviderName()}`);
  setStep(run, 1);

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
      // takeSnapshot() now calls waitForLoadState('networkidle') internally,
      // so we no longer need the arbitrary 800ms static wait here.

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
  setStep(run, 2);
  log(run, `\u{1F50D} Filtering elements (removing noise)...`);
  const filteredSnapshots = snapshots.map(snap => {
    const filtered = filterElements(snap.elements);
    log(run, `   ${snap.url.replace(project.url, "")}: ${filterStats(snap.elements, filtered)}`);
    return { ...snap, elements: filtered };
  });
  for (const snap of filteredSnapshots) snapshotsByUrl[snap.url] = snap;

  // Layer 2: Intent classification (AI-assisted when heuristic confidence is low)
  setStep(run, 3);
  log(run, `\u{1F9E0} Classifying page intents...`);
  const classifiedPages = [];
  for (const snap of filteredSnapshots) {
    const classified = await classifyPageWithAI(snap, snap.elements);
    if (classified._aiAssisted) {
      log(run, `   \u{1F916} AI classified ${snap.url.replace(project.url, "") || "/"} as ${classified.dominantIntent}`);
    }
    classifiedPages.push(classified);
  }
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
  setStep(run, 4);
  log(run, `\u{1F916} Generating intent-driven tests...`);
  const rawTests = await generateAllTests(classifiedPages, journeys, snapshotsByUrl, (msg) => log(run, msg));
  log(run, `\u{1F4DD} Raw tests: ${rawTests.length}`);

  // Layer 3: Deduplication
  setStep(run, 5);
  log(run, `\u{1F6AB} Deduplicating...`);
  const existingTests = Object.values(db.tests).filter(t => t.projectId === project.id);
  const { unique, removed, stats: dedupStats } = deduplicateTests(rawTests);
  const finalTests = deduplicateAcrossRuns(unique, existingTests);
  log(run, `   ${removed} duplicates removed | ${unique.length - finalTests.length} already exist | ${finalTests.length} new unique tests`);

  // Layer 4: Assertion enhancement
  setStep(run, 6);
  log(run, `\u2728 Enhancing assertions...`);
  const { tests: enhancedTests, enhancedCount } = enhanceTests(finalTests, snapshotsByUrl, classifiedPagesByUrl);
  log(run, `   ${enhancedCount} tests had assertions strengthened`);

  // Layer 5: Validate generated tests — reject malformed / placeholder tests
  setStep(run, 7);
  log(run, `\u2705 Validating generated tests...`);
  const validatedTests = [];
  let rejected = 0;
  for (const t of enhancedTests) {
    const issues = validateTest(t, project.url);
    if (issues.length === 0) {
      validatedTests.push(t);
    } else {
      rejected++;
      log(run, `   \u274C Rejected "${t.name || "unnamed"}": ${issues.join("; ")}`);
    }
  }
  log(run, `   ${validatedTests.length} valid | ${rejected} rejected`);

  // Store in db
  for (const t of validatedTests) {
    const testId = uuidv4();
    db.tests[testId] = {
      // Spread AI-generated fields first so our critical fields below always win.
      // This prevents the AI from accidentally overriding id, projectId, reviewStatus, etc.
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
  setStep(run, 8);
  run.pipelineStats = {
    pagesFound: snapshots.length,
    rawTestsGenerated: rawTests.length,
    duplicatesRemoved: removed,
    assertionsEnhanced: enhancedCount,
    validationRejected: rejected,
    journeysDetected: journeys.length,
    averageQuality: dedupStats.averageQuality,
  };

  log(run, `\n\u{1F4CA} Pipeline Summary:`);
  log(run, `   Pages: ${snapshots.length} | Raw tests: ${rawTests.length} | Enhanced: ${enhancedTests.length} | Validated: ${validatedTests.length}`);
  log(run, `   Journey tests: ${validatedTests.filter(t => t.isJourneyTest).length} | Rejected: ${rejected} | Avg quality: ${dedupStats.averageQuality}/100`);
  log(run, `\u{1F389} Done! ${run.tests.length} high-quality tests generated.`);
}
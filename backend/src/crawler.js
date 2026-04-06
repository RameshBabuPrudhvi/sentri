/**
 * @module crawler
 * @description Autonomous QA pipeline — thin orchestration layer for the 8-stage
 * test generation pipeline.
 *
 * ### Pipeline stages
 * | # | Stage                | Module                                              |
 * |---|----------------------|-----------------------------------------------------|
 * | 1 | Smart crawl / Explore| `pipeline/crawlBrowser.js` or `pipeline/stateExplorer.js` |
 * | 2 | Element filtering    | `pipeline/elementFilter.js`                         |
 * | 3 | Intent classification| `pipeline/intentClassifier.js`                      |
 * | 4 | Journey generation   | `pipeline/journeyGenerator.js`                      |
 * | 5 | Deduplication        | `pipeline/pipelineOrchestrator.js`                  |
 * | 6 | Assertion enhancement| `pipeline/pipelineOrchestrator.js`                  |
 * | 7 | Validate tests       | `pipeline/pipelineOrchestrator.js`                  |
 * | 8 | Feedback loop        | `pipeline/feedbackLoop.js`                          |
 *
 * ### Explorer modes (Test Dials `exploreMode`)
 * - `crawl` (default) — link-only BFS crawl via `crawlBrowser.js`
 * - `state` — state-based exploration via `stateExplorer.js` that executes
 *   real UI actions (click, fill, submit) and tracks state transitions to
 *   discover multi-step user flows
 *
 * ### Exports
 * - {@link generateSingleTest} — Generate ONE test from a user description (skips crawl).
 * - {@link crawlAndGenerateTests} — Full 8-stage pipeline from URL crawl or state exploration.
 */

import { getProviderName } from "./aiProvider.js";
import { throwIfAborted, finalizeRunIfNotAborted } from "./utils/abortHelper.js";
import { filterElements, filterStats } from "./pipeline/elementFilter.js";
import { classifyPageWithAI, buildUserJourneys } from "./pipeline/intentClassifier.js";
import { generateAllTests, generateUserRequestedTest } from "./pipeline/journeyGenerator.js";
import { crawlPages } from "./pipeline/crawlBrowser.js";
import { exploreStates } from "./pipeline/stateExplorer.js";
import { runPostGenerationPipeline } from "./pipeline/pipelineOrchestrator.js";
import { persistGeneratedTests, buildPipelineStats } from "./pipeline/testPersistence.js";
import { emitRunEvent, log, logWarn, logSuccess } from "./utils/runLogger.js";

function setStep(run, step) {
  run.currentStep = step;
  emitRunEvent(run.id, "snapshot", { run });
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
export async function generateSingleTest(project, run, db, { name, description, dialsPrompt = "", testCount = "ai_decides", signal }) {
  const runStart = Date.now();
  log(run, `✦ Starting single-test generation pipeline for "${name}"`);
  log(run, `🤖 AI provider: ${getProviderName()}`);

  // Skip steps 1-3 — user provides the intent directly via name + description
  setStep(run, 1);
  log(run, `⏭️  Step 1 (Crawl) — skipped (user-provided title & description)`);
  setStep(run, 2);
  log(run, `⏭️  Step 2 (Filter) — skipped`);
  setStep(run, 3);
  log(run, `⏭️  Step 3 (Classify) — skipped (user already described the intent)`);

  // ── Step 4: Generate focused test(s) via AI ─────────────────────────────
  throwIfAborted(signal);
  setStep(run, 4);
  log(run, `🤖 Generating test from user description...`);
  log(run, `   Name: "${name}"`);
  if (description) log(run, `   Description: "${description.slice(0, 100)}${description.length > 100 ? "…" : ""}"`);

  const rawTests = await generateUserRequestedTest(name, description, project.url, (token) => {
    emitRunEvent(run.id, "llm_token", { token });
  }, { dialsPrompt, testCount, signal });
  log(run, `📝 Raw tests generated: ${rawTests.length}`);

  // ── Steps 5-7: Dedup → Enhance → Validate (shared pipeline) ────────────
  const { validatedTests, enhancedTests, rejected, removed, enhancedCount, dedupStats } =
    await runPostGenerationPipeline(rawTests, project, db, run, { signal });

  // ── Step 8: Store & Done ────────────────────────────────────────────────
  const createdTestIds = persistGeneratedTests(validatedTests, project, db, run, {
    name, description, sourceUrl: project.url, pageTitle: project.name,
  });

  run.testsGenerated = run.tests.length;
  run.pipelineStats = buildPipelineStats({ rawTests, removed, enhancedCount, rejected, dedupStats });

  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    run.duration = Date.now() - runStart;
    setStep(run, 8);
    log(run, `\n📊 Pipeline Summary:`);
    log(run, `   Raw: ${rawTests.length} | Enhanced: ${enhancedTests.length} | Validated: ${validatedTests.length} | Rejected: ${rejected}`);
    logSuccess(run, `Done! ${run.tests.length} test(s) generated for "${name}".`);
    emitRunEvent(run.id, "done", { status: "completed" });
  });

  return createdTestIds;
}

/**
 * Full 8-stage pipeline: crawl a project URL, classify pages, generate tests,
 * deduplicate, enhance, validate, and persist.
 *
 * @param {Object} project                - The project `{ id, name, url, credentials? }`.
 * @param {Object} run                    - The run record (mutated in place with results).
 * @param {Object} db                     - The database object from {@link module:db.getDb}.
 * @param {Object} [options]
 * @param {string} [options.dialsPrompt]   - Pre-built prompt fragment from Test Dials config.
 * @param {string} [options.testCount]     - Test count hint (`"one"` | `"small"` | `"medium"` | `"large"` | `"ai_decides"`).
 * @param {string} [options.explorerMode]   - `"crawl"` (default) or `"state"` — from Test Dials.
 * @param {Object} [options.explorerTuning] - Numeric tuning for state explorer `{ maxStates, maxDepth, maxActions, actionTimeout }`.
 * @param {AbortSignal} [options.signal]   - Abort signal for cancellation.
 * @returns {Promise<void>}
 */
export async function crawlAndGenerateTests(project, run, db, { dialsPrompt = "", testCount = "ai_decides", explorerMode, explorerTuning, signal } = {}) {
  const runStart = Date.now();
  const mode = (explorerMode || "crawl").toLowerCase();

  // ── Step 1: Smart crawl or state exploration ─────────────────────────────
  log(run, `🕷️  Starting ${mode === "state" ? "state exploration" : "smart crawl"} of ${project.url}`);
  log(run, `🤖 AI provider: ${getProviderName()}`);
  setStep(run, 1);

  let snapshots, snapshotsByUrl, journeys, classifiedPages, classifiedPagesByUrl;

  if (mode === "state") {
    // ── State-based exploration (new engine) ─────────────────────────────
    const exploration = await exploreStates(project, run, { signal, tuning: explorerTuning });
    snapshots = exploration.snapshots;
    snapshotsByUrl = exploration.snapshotsByUrl;

    throwIfAborted(signal);

    // ── Step 2: Element filtering ─────────────────────────────────────────
    setStep(run, 2);
    log(run, `🔍 Filtering elements (removing noise)...`);
    const filteredSnapshots = snapshots.map(snap => {
      const filtered = filterElements(snap.elements);
      log(run, `   ${snap.url.replace(project.url, "")}: ${filterStats(snap.elements, filtered)}`);
      return { ...snap, elements: filtered };
    });
    for (const snap of filteredSnapshots) snapshotsByUrl[snap.url] = snap;

    throwIfAborted(signal);

    // ── Step 3: Intent classification ─────────────────────────────────────
    setStep(run, 3);
    log(run, `🧠 Classifying page intents...`);
    classifiedPages = [];
    for (const snap of filteredSnapshots) {
      throwIfAborted(signal);
      const classified = await classifyPageWithAI(snap, snap.elements, { signal });
      if (classified._aiAssisted) {
        log(run, `   🤖 AI classified ${snap.url.replace(project.url, "") || "/"} as ${classified.dominantIntent}`);
      }
      classifiedPages.push(classified);
    }
    classifiedPagesByUrl = {};
    for (const cp of classifiedPages) {
      classifiedPagesByUrl[cp.url] = cp;
      log(run, `   ${cp.dominantIntent.padEnd(16)} ${cp.url.replace(project.url, "") || "/"}`);
    }

    // Use observed flows from the state explorer as journeys
    journeys = exploration.journeys;
    if (journeys.length > 0) {
      log(run, `🗺️  Discovered ${journeys.length} observed flow(s):`);
      for (const j of journeys) {
        const via = j._discoveredBy ? ` [${j._discoveredBy}]` : "";
        log(run, `   • ${j.name} (${j.pages.length} pages)${via}`);
      }
    }

    // Also discover link-graph journeys from classified pages as a supplement
    const linkJourneys = buildUserJourneys(classifiedPages, snapshotsByUrl);
    const explorerUrls = new Set(journeys.flatMap(j => j.pages.map(p => p.url)));
    for (const lj of linkJourneys) {
      // Only add link-graph journeys that cover pages not already in observed flows
      if (!lj.pages.some(p => explorerUrls.has(p.url))) {
        journeys.push(lj);
      }
    }
  } else {
    // ── Legacy link-based crawl ──────────────────────────────────────────
    const crawlResult = await crawlPages(project, run, { signal });
    snapshots = crawlResult.snapshots;
    snapshotsByUrl = crawlResult.snapshotsByUrl;

    throwIfAborted(signal);

    // ── Step 2: Element filtering ─────────────────────────────────────────
    setStep(run, 2);
    log(run, `🔍 Filtering elements (removing noise)...`);
    const filteredSnapshots = snapshots.map(snap => {
      const filtered = filterElements(snap.elements);
      log(run, `   ${snap.url.replace(project.url, "")}: ${filterStats(snap.elements, filtered)}`);
      return { ...snap, elements: filtered };
    });
    for (const snap of filteredSnapshots) snapshotsByUrl[snap.url] = snap;

    throwIfAborted(signal);

    // ── Step 3: Intent classification ─────────────────────────────────────
    setStep(run, 3);
    log(run, `🧠 Classifying page intents...`);
    classifiedPages = [];
    for (const snap of filteredSnapshots) {
      throwIfAborted(signal);
      const classified = await classifyPageWithAI(snap, snap.elements, { signal });
      if (classified._aiAssisted) {
        log(run, `   🤖 AI classified ${snap.url.replace(project.url, "") || "/"} as ${classified.dominantIntent}`);
      }
      classifiedPages.push(classified);
    }
    classifiedPagesByUrl = {};
    for (const cp of classifiedPages) {
      classifiedPagesByUrl[cp.url] = cp;
      log(run, `   ${cp.dominantIntent.padEnd(16)} ${cp.url.replace(project.url, "") || "/"}`);
    }

    // Journey detection — pass snapshotsByUrl so link-graph analysis can discover
    // cross-intent journeys (e.g. pricing → signup → dashboard)
    journeys = buildUserJourneys(classifiedPages, snapshotsByUrl);
    if (journeys.length > 0) {
      log(run, `🗺️  Detected ${journeys.length} user journey(s):`);
      for (const j of journeys) {
        const via = j._discoveredBy ? ` [${j._discoveredBy}]` : "";
        log(run, `   • ${j.name} (${j.pages.length} pages)${via}`);
      }
    }
  }

  throwIfAborted(signal);

  // ── Step 4: AI test generation ──────────────────────────────────────────
  setStep(run, 4);
  log(run, `🤖 Generating intent-driven tests...`);
  const rawTests = await generateAllTests(classifiedPages, journeys, snapshotsByUrl, (msg) => log(run, msg), { dialsPrompt, testCount, signal });
  log(run, `📝 Raw tests: ${rawTests.length}`);

  throwIfAborted(signal);

  // ── Steps 5-7: Dedup → Enhance → Validate (shared pipeline) ────────────
  const { validatedTests, enhancedTests, rejected, removed, enhancedCount, dedupStats } =
    await runPostGenerationPipeline(rawTests, project, db, run, { snapshotsByUrl, classifiedPagesByUrl, signal });

  // ── Step 8: Store & Done ────────────────────────────────────────────────
  persistGeneratedTests(validatedTests, project, db, run);

  run.snapshots = snapshots;
  run.pages = snapshots.map(s => ({ url: s.url, title: s.title || s.url, status: "crawled" }));
  run.testsGenerated = run.tests.length;
  run.pipelineStats = buildPipelineStats({
    pagesFound: snapshots.length, rawTests, removed, enhancedCount, rejected, journeys, dedupStats,
  });

  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    run.duration = Date.now() - runStart;
    setStep(run, 8);
    log(run, `\n📊 Pipeline Summary:`);
    log(run, `   Pages: ${snapshots.length} | Raw tests: ${rawTests.length} | Enhanced: ${enhancedTests.length} | Validated: ${validatedTests.length}`);
    log(run, `   Journey tests: ${validatedTests.filter(t => t.isJourneyTest).length} | Rejected: ${rejected} | Avg quality: ${dedupStats.averageQuality}/100`);
    logSuccess(run, `Done! ${run.tests.length} high-quality tests generated.`);
    emitRunEvent(run.id, "done", { status: "completed" });
  });
}
/**
 * @module crawler
 * @description Autonomous QA pipeline — thin orchestration layer for the 8-stage
 * test generation pipeline.
 *
 * ### Pipeline stages
 * | #  | Stage                | Module                                              |
 * |----|----------------------|-----------------------------------------------------|
 * | 1  | Smart crawl / Explore| `pipeline/crawlBrowser.js` or `pipeline/stateExplorer.js` |
 * |    | ↳ HAR capture        | `pipeline/harCapture.js` (attached to BrowserContext)|
 * | 2  | Element filtering    | `pipeline/elementFilter.js`                         |
 * | 3  | Intent classification| `pipeline/intentClassifier.js`                      |
 * | 4  | Journey generation   | `pipeline/journeyGenerator.js`                      |
 * | 4b | API test generation  | `pipeline/journeyGenerator.js` + `prompts/apiTestPrompt.js` |
 * | 5  | Deduplication        | `pipeline/pipelineOrchestrator.js`                  |
 * | 6  | Assertion enhancement| `pipeline/pipelineOrchestrator.js`                  |
 * | 7  | Validate tests       | `pipeline/pipelineOrchestrator.js`                  |
 * | 8  | Feedback loop        | `pipeline/feedbackLoop.js`                          |
 *
 * ### Explorer modes (Test Dials `exploreMode`)
 * - `crawl` (default) — link-only BFS crawl via `crawlBrowser.js`
 * - `state` — state-based exploration via `stateExplorer.js` that executes
 *   real UI actions (click, fill, submit) and tracks state transitions to
 *   discover multi-step user flows
 *
 * ### Exports
 * - {@link generateFromUserDescription} — Generate test(s) from a user description (skips crawl).
 * - {@link crawlAndGenerateTests} — Full 8-stage pipeline from URL crawl or state exploration.
 */

import { getProviderName } from "./aiProvider.js";
import { throwIfAborted, finalizeRunIfNotAborted } from "./utils/abortHelper.js";
import { filterElements, filterStats } from "./pipeline/elementFilter.js";
import { classifyPageWithAI, buildUserJourneys } from "./pipeline/intentClassifier.js";
import { generateAllTests, generateFromDescription, generateApiTests } from "./pipeline/journeyGenerator.js";
import { crawlPages } from "./pipeline/crawlBrowser.js";
import { exploreStates } from "./pipeline/stateExplorer.js";
import { runPostGenerationPipeline } from "./pipeline/pipelineOrchestrator.js";
import { persistGeneratedTests, buildPipelineStats } from "./pipeline/testPersistence.js";
import { emitRunEvent, log, logWarn, logSuccess } from "./utils/runLogger.js";
import { classifyError } from "./utils/errorClassifier.js";
import { structuredLog } from "./utils/logFormatter.js";
import * as runRepo from "./database/repositories/runRepo.js";

function setStep(run, step) {
  run.currentStep = step;
  runRepo.update(run.id, { currentStep: step });
  emitRunEvent(run.id, "snapshot", { run });
}

/**
 * Shared Steps 2 & 3: Element filtering + intent classification.
 * Extracted to avoid duplication between the "state" and "crawl" branches.
 *
 * @param {object[]} snapshots       — raw page snapshots from crawl or explore
 * @param {Record<string,object>} snapshotsByUrl — URL → snapshot map (mutated in place)
 * @param {object}  project          — project record (url used for log trimming)
 * @param {object}  run              — mutable run record
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ filteredSnapshots: object[], classifiedPages: object[], classifiedPagesByUrl: Record<string,object> }>}
 */
async function filterAndClassify(snapshots, snapshotsByUrl, project, run, signal) {
  // ── Step 2: Element filtering ───────────────────────────────────────────
  setStep(run, 2);
  structuredLog("pipeline.filter", { runId: run.id, pages: snapshots.length });
  log(run, `🔍 Filtering elements (removing noise)...`);
  const filteredSnapshots = snapshots.map(snap => {
    const filtered = filterElements(snap.elements);
    log(run, `   ${snap.url.replace(project.url, "")}: ${filterStats(snap.elements, filtered)}`);
    return { ...snap, elements: filtered };
  });
  for (const snap of filteredSnapshots) snapshotsByUrl[snap.url] = snap;

  throwIfAborted(signal);

  // ── Step 3: Intent classification ───────────────────────────────────────
  setStep(run, 3);
  structuredLog("pipeline.classify", { runId: run.id, pages: filteredSnapshots.length });
  log(run, `🧠 Classifying page intents...`);
  const classifiedPages = [];
  for (const snap of filteredSnapshots) {
    throwIfAborted(signal);
    const classified = await classifyPageWithAI(snap, snap.elements, { signal });
    if (classified._aiAssisted) {
      log(run, `   🤖 AI classified ${snap.url.replace(project.url, "") || "/"} as ${classified.dominantIntent}`);
    }
    classifiedPages.push(classified);
  }
  const classifiedPagesByUrl = {};
  for (const cp of classifiedPages) {
    classifiedPagesByUrl[cp.url] = cp;
    log(run, `   ${cp.dominantIntent.padEnd(16)} ${cp.url.replace(project.url, "") || "/"}`);
  }

  return { filteredSnapshots, classifiedPages, classifiedPagesByUrl };
}

/**
 * generateFromUserDescription — Generates test(s) from a user-provided
 * name + description (no crawl needed).
 *
 * Uses a dedicated AI prompt that produces tests matching the user's
 * stated intent. The number of tests is controlled by the `testCount`
 * dial (1–20, default "one"). Unlike the crawl pipeline which discovers
 * pages automatically, this skips Steps 1-3 and goes straight to AI
 * generation.
 *
 * Pipeline:
 *   Step 1-3: SKIPPED (Crawl, Filter, Classify — user provides intent directly)
 *   Step 4: Generate     — AI generates test(s) from name + description
 *   Step 5: Deduplicate  — Check against existing project tests
 *   Step 6: Enhance      — Strengthen assertions
 *   Step 7: Validate     — Reject malformed / placeholder tests
 *   Step 8: Done
 */
export async function generateFromUserDescription(project, run, { name, description, dialsPrompt = "", testCount = "ai_decides", signal }) {
  const runStart = Date.now();
  structuredLog("generate.start", { runId: run.id, projectId: project.id, mode: "description", name });
  log(run, `✦ Starting test generation from description for "${name}"`);
  log(run, `🤖 AI provider: ${getProviderName()}`);
  log(run, `⚙️ Run config:`);
  log(run, `Generation mode: 📝 From description (no crawl)`);
  log(run, `Explorer mode: ⏭️ None (crawl skipped — generating from description)`);
  log(run, `Test count: ${testCount}`);
  log(run, `HAR capture: ❌ disabled (no crawl)`);
  log(run, `API tests: ✅ auto-detected from description (mention endpoints, HTTP methods, /api/ paths)`);
  log(run, `Target URL: ${project.url}`);

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
  // Detect API intent so the log reflects which prompt path will be used
  const apiKeywords = /\bAPI\b|\bREST\b|\bGraphQL\b|\bendpoint|\b(GET|POST|PUT|PATCH|DELETE)\s+\/|\bstatus\s*code|\brequest\s*body|\bresponse\s*(body|shape|schema)|\bjson\s*(response|payload|body)|\bcontract\s*test|\/api\//i;
  const detectedApiIntent = apiKeywords.test(`${name} ${description}`);
  log(run, `🤖 Generating test${detectedApiIntent ? "s (🌐 API intent detected → using API test prompt)" : " from user description"}...`);
  log(run, `Name: "${name}"`);
  if (description) log(run, `Description: "${description.slice(0, 100)}${description.length > 100 ? "…" : ""}"`);

  const rawTests = await generateFromDescription(name, description, project.url, (token) => {
    emitRunEvent(run.id, "llm_token", { token });
  }, { dialsPrompt, testCount, signal });
  log(run, `📝 Raw tests generated: ${rawTests.length}`);

  // ── Steps 5-7: Dedup → Enhance → Validate (shared pipeline) ────────────
  const { validatedTests, enhancedTests, rejected, removed, enhancedCount, dedupStats } =
    await runPostGenerationPipeline(rawTests, project, run, { signal });

  // ── Step 8: Store & Done ────────────────────────────────────────────────
  const createdTestIds = persistGeneratedTests(validatedTests, project, run, {
    name, description, sourceUrl: project.url, pageTitle: project.name,
  });

  run.testsGenerated = run.tests.length;
  run.pipelineStats = buildPipelineStats({ rawTests, removed, enhancedCount, rejected, dedupStats });

  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    run.duration = Date.now() - runStart;
    setStep(run, 8);
    log(run, `\n📊 Pipeline Summary:`);
    log(run, `Raw: ${rawTests.length} | Enhanced: ${enhancedTests.length} | Validated: ${validatedTests.length} | Rejected: ${rejected}`);
    logSuccess(run, `Done! ${run.tests.length} test(s) generated from description for "${name}".`);
    structuredLog("generate.complete", { runId: run.id, projectId: project.id, tests: run.tests.length, durationMs: run.duration });
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
  structuredLog("crawl.start", { runId: run.id, projectId: project.id, mode, url: project.url });
  log(run, `🕷️  Starting ${mode === "state" ? "state exploration" : "smart crawl"} of ${project.url}`);
  log(run, `🤖 AI provider: ${getProviderName()}`);
  log(run, `⚙️ Run config:`);
  log(run, `Explorer mode: ${mode === "state" ? "🔍 State exploration (click/fill/submit)" : "🔗 Link crawl (follow <a> tags)"}`);
  if (mode === "state" && explorerTuning) {
    log(run, `Max states: ${explorerTuning.maxStates ?? 30}`);
    log(run, `Max depth: ${explorerTuning.maxDepth ?? 3}`);
    log(run, `Max actions: ${explorerTuning.maxActions ?? 8}`);
    log(run, `Action timeout: ${explorerTuning.actionTimeout ?? 5000}ms`);
  }
  log(run, `Test count: ${testCount}`);
  log(run, `HAR capture: ✅ enabled (API traffic → API test generation)`);
  log(run, `Target URL: ${project.url}`);
  setStep(run, 1);

  let snapshots, snapshotsByUrl, journeys, classifiedPages, classifiedPagesByUrl, filteredSnapshots;
  let apiEndpoints = [];

  if (mode === "state") {
    // ── State-based exploration (new engine) ─────────────────────────────
    const exploration = await exploreStates(project, run, { signal, tuning: explorerTuning });
    snapshots = exploration.snapshots;
    snapshotsByUrl = exploration.snapshotsByUrl;
    apiEndpoints = exploration.apiEndpoints || [];

    throwIfAborted(signal);

    // ── Steps 2 & 3: shared filter + classify ─────────────────────────────
    ({ filteredSnapshots, classifiedPages, classifiedPagesByUrl } =
      await filterAndClassify(snapshots, snapshotsByUrl, project, run, signal));

    // Enrich snapshotsByUrl with fingerprint-keyed entries so that downstream
    // code (journeyPrompt.js) can look up per-state snapshots when a journey
    // page carries _stateFingerprint. Without this, multiple states at the
    // same URL (e.g. login form blank vs with errors) would all resolve to
    // the last-captured snapshot for that URL.
    const fpMap = exploration.stateGraph.snapshotsByFp;
    for (const [fp, snap] of fpMap) {
      snapshotsByUrl[fp] = snap;
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
    apiEndpoints = crawlResult.apiEndpoints || [];

    throwIfAborted(signal);

    // ── Steps 2 & 3: shared filter + classify ─────────────────────────────
    ({ filteredSnapshots, classifiedPages, classifiedPagesByUrl } =
      await filterAndClassify(snapshots, snapshotsByUrl, project, run, signal));

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
  structuredLog("pipeline.generate", { runId: run.id, pages: classifiedPages.length, journeys: journeys.length });
  log(run, `🤖 Generating intent-driven tests...`);
  const genResult = await generateAllTests(classifiedPages, journeys, snapshotsByUrl, (msg) => log(run, msg), { dialsPrompt, testCount, signal });
  const rawTests = genResult.tests;
  log(run, `📝 Raw UI tests: ${rawTests.length}`);

  // Surface rate limit errors so the frontend shows a clear warning
  if (genResult.rateLimitHit) {
    const errMsg = genResult.rateLimitError || "AI provider rate limit exceeded";
    logWarn(run, `AI RATE LIMIT: ${errMsg}`);
    logWarn(run, `Tests generated before limit: ${rawTests.length}. Switch to a different AI provider in Settings, or wait and retry.`);
    run.rateLimitError = errMsg;
  }

  // ── Step 4b: API test generation from captured HAR traffic ──────────────
  if (apiEndpoints.length === 0) {
    log(run, `🌐 No API endpoints captured — site made no fetch/XHR calls during ${mode === "state" ? "exploration" : "crawl"}. API test generation skipped.`);
    log(run, `💡 Tip: Use "State exploration" mode to trigger API calls via button clicks and form submissions.`);
  }
  if (apiEndpoints.length > 0 && !genResult.rateLimitHit) {
    throwIfAborted(signal);
    log(run, `🌐 Generating API tests from ${apiEndpoints.length} discovered endpoints...`);
    try {
      const apiTests = await generateApiTests(apiEndpoints, project.url, { dialsPrompt, testCount: "small", signal });
      if (apiTests.length > 0) {
        for (const t of apiTests) rawTests.push(t);
        log(run, `📝 API tests generated: ${apiTests.length} (total raw: ${rawTests.length})`);
      } else {
        log(run, `No API tests generated (AI returned empty)`);
      }
    } catch (err) {
      if (err.name === "AbortError" || signal?.aborted) throw err;
      const classified = classifyError(err, "crawl");
      logWarn(run, `API test generation failed: ${classified.message}`);
    }
  }

  throwIfAborted(signal);

  // ── Steps 5-7: Dedup → Enhance → Validate (shared pipeline) ────────────
  const { validatedTests, enhancedTests, rejected, removed, enhancedCount, dedupStats } =
    await runPostGenerationPipeline(rawTests, project, db, run, { snapshotsByUrl, classifiedPagesByUrl, signal });

  // ── Step 8: Store & Done ────────────────────────────────────────────────
  persistGeneratedTests(validatedTests, project, db, run);

  run.snapshots = filteredSnapshots;
  run.pages = filteredSnapshots.map(s => ({ url: s.url, title: s.title || s.url, status: "crawled" }));
  run.testsGenerated = run.tests.length;
  run.pipelineStats = buildPipelineStats({
    pagesFound: snapshots.length, rawTests, removed, enhancedCount, rejected, journeys, dedupStats,
    apiEndpointsDiscovered: apiEndpoints.length,
  });

  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    run.duration = Date.now() - runStart;
    setStep(run, 8);
    log(run, `\n📊 Pipeline Summary:`);
    log(run, `Pages: ${snapshots.length} | Raw tests: ${rawTests.length} | Enhanced: ${enhancedTests.length} | Validated: ${validatedTests.length}`);
    log(run, `Journey tests: ${validatedTests.filter(t => t.isJourneyTest).length} | API tests: ${validatedTests.filter(t => t._generatedFrom === "api_har_capture" || t._generatedFrom === "api_user_described").length} | Rejected: ${rejected} | Avg quality: ${dedupStats.averageQuality}/100`);
    if (apiEndpoints.length > 0) {
      log(run, `API endpoints discovered: ${apiEndpoints.length}`);
    }
    if (run.rateLimitError) {
      logWarn(run, `Completed with rate limit — only ${run.tests.length} test(s) generated. Switch AI provider or retry later.`);
    } else {
      logSuccess(run, `Done! ${run.tests.length} high-quality tests generated.`);
    }
    structuredLog("crawl.complete", {
      runId: run.id, projectId: project.id, mode,
      pages: snapshots.length, tests: run.tests.length, durationMs: run.duration,
      apiEndpoints: apiEndpoints.length,
    });
    emitRunEvent(run.id, "done", { status: "completed" });
  });
}
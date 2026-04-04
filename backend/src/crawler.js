/**
 * crawler.js — Sentri autonomous QA pipeline (thin orchestration layer)
 *
 * 8-layer pipeline:
 *   1. Smart crawl           (pipeline/crawlBrowser.js)
 *   2. Element filtering     (pipeline/elementFilter.js)
 *   3. Intent classification (pipeline/intentClassifier.js)
 *   4. Journey generation    (pipeline/journeyGenerator.js)
 *   5. Deduplication         (pipeline/pipelineOrchestrator.js)
 *   6. Assertion enhancement (pipeline/pipelineOrchestrator.js)
 *   7. Validate generated tests (pipeline/pipelineOrchestrator.js)
 *   8. Feedback loop         (pipeline/feedbackLoop.js — runs post-execution)
 *
 * Sub-concerns extracted to focused modules:
 *   - pipeline/pageSnapshot.js       — takeSnapshot()
 *   - pipeline/testValidator.js      — validateTest()
 *   - pipeline/testPersistence.js    — persistGeneratedTests(), buildPipelineStats()
 *   - pipeline/crawlBrowser.js       — crawlPages()
 *   - pipeline/pipelineOrchestrator.js — runPostGenerationPipeline()
 */

import { getProviderName } from "./aiProvider.js";
import { throwIfAborted, finalizeRunIfNotAborted } from "./utils/abortHelper.js";
import { filterElements, filterStats } from "./pipeline/elementFilter.js";
import { classifyPageWithAI, buildUserJourneys } from "./pipeline/intentClassifier.js";
import { generateAllTests, generateUserRequestedTest } from "./pipeline/journeyGenerator.js";
import { crawlPages } from "./pipeline/crawlBrowser.js";
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
export async function generateSingleTest(project, run, db, { name, description, dialsPrompt = "", testCount = "auto", signal }) {
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

export async function crawlAndGenerateTests(project, run, db, { dialsPrompt = "", testCount = "auto", signal } = {}) {
  const runStart = Date.now();

  // ── Step 1: Smart crawl ─────────────────────────────────────────────────
  log(run, `🕷️  Starting smart crawl of ${project.url}`);
  log(run, `🤖 AI provider: ${getProviderName()}`);
  setStep(run, 1);

  const { snapshots, snapshotsByUrl } = await crawlPages(project, run, { signal });

  throwIfAborted(signal);

  // ── Step 2: Element filtering ───────────────────────────────────────────
  setStep(run, 2);
  log(run, `🔍 Filtering elements (removing noise)...`);
  const filteredSnapshots = snapshots.map(snap => {
    const filtered = filterElements(snap.elements);
    log(run, `   ${snap.url.replace(project.url, "")}: ${filterStats(snap.elements, filtered)}`);
    return { ...snap, elements: filtered };
  });
  for (const snap of filteredSnapshots) snapshotsByUrl[snap.url] = snap;

  throwIfAborted(signal);

  // Layer 2: Intent classification (AI-assisted when heuristic confidence is low)
  setStep(run, 3);
  log(run, `🧠 Classifying page intents...`);
  const classifiedPages = [];
  for (const snap of filteredSnapshots) {
    throwIfAborted(signal);
    const classified = await classifyPageWithAI(snap, snap.elements);
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

  // Journey detection
  const journeys = buildUserJourneys(classifiedPages);
  if (journeys.length > 0) {
    log(run, `🗺️  Detected ${journeys.length} user journey(s): ${journeys.map(j => j.name).join(", ")}`);
  }

  throwIfAborted(signal);

  // AI test generation
  setStep(run, 4);
  log(run, `🤖 Generating intent-driven tests...`);
  const rawTests = await generateAllTests(classifiedPages, journeys, snapshotsByUrl, (msg) => log(run, msg), { dialsPrompt, testCount, signal });
  log(run, `📝 Raw tests: ${rawTests.length}`);

  throwIfAborted(signal);

  // Layer 3: Deduplication
  setStep(run, 5);
  log(run, `🚫 Deduplicating...`);
  const existingTests = Object.values(db.tests).filter(t => t.projectId === project.id);
  const { unique, removed, stats: dedupStats } = deduplicateTests(rawTests);
  const finalTests = deduplicateAcrossRuns(unique, existingTests);
  log(run, `   ${removed} duplicates removed | ${unique.length - finalTests.length} already exist | ${finalTests.length} new unique tests`);

  throwIfAborted(signal);

  // Layer 4: Assertion enhancement
  setStep(run, 6);
  log(run, `✨ Enhancing assertions...`);
  const { tests: enhancedTests, enhancedCount } = enhanceTests(finalTests, snapshotsByUrl, classifiedPagesByUrl);
  log(run, `   ${enhancedCount} tests had assertions strengthened`);

  throwIfAborted(signal);

  // Layer 5: Validate generated tests — reject malformed / placeholder tests
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
      logWarn(run, `Rejected "${t.name || "unnamed"}": ${issues.join("; ")}`);
    }
  }
  log(run, `   ${validatedTests.length} valid | ${rejected} rejected`);

  throwIfAborted(signal);

  // Store in db
  for (const t of validatedTests) {
    const testId = generateTestId(db);
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
  run.pages = filteredSnapshots.map(s => ({ url: s.url, title: s.title || s.url, status: "crawled" }));
  run.testsGenerated = run.tests.length;
  run.pipelineStats = {
    pagesFound: snapshots.length,
    rawTestsGenerated: rawTests.length,
    duplicatesRemoved: removed,
    assertionsEnhanced: enhancedCount,
    validationRejected: rejected,
    journeysDetected: journeys.length,
    averageQuality: dedupStats.averageQuality,
  };

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
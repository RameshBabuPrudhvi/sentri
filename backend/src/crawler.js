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
import { trackTelemetry } from "./utils/telemetry.js";
import { filterElements, filterStats } from "./pipeline/elementFilter.js";
import { classifyPageWithAI, buildUserJourneys } from "./pipeline/intentClassifier.js";
import { generateAllTests, generateFromDescription, generateApiTests } from "./pipeline/journeyGenerator.js";
import { crawlPages } from "./pipeline/crawlBrowser.js";
import { exploreStates } from "./pipeline/stateExplorer.js";
import { runPostGenerationPipeline, sanitizeRunInputs } from "./pipeline/pipelineOrchestrator.js";
import { persistGeneratedTests, buildPipelineStats } from "./pipeline/testPersistence.js";
import { emitRunEvent, log, logWarn, logSuccess } from "./utils/runLogger.js";
import { setStep } from "./utils/pipelineState.js";
import { classifyError } from "./utils/errorClassifier.js";
import { structuredLog } from "./utils/logFormatter.js";
import * as runRepo from "./database/repositories/runRepo.js";
import * as crawlBaselineRepo from "./database/repositories/crawlBaselineRepo.js";
import { diffCrawlSnapshots } from "./pipeline/crawlDiff.js";
import { crawlPagesTotal, recordRunOutcome } from "./utils/metrics.js"; // INF-007 — crawler + run-level telemetry.

/**
 * setStep is imported from utils/pipelineState.js — shared with pipelineOrchestrator.js.
 */

/**
 * AUTO-002 / AUTO-002b: shared diff-aware baseline runner. Compares the
 * current crawl's snapshots against the persisted baseline, emits the
 * `pages_changed` SSE event, and merges the new fingerprints into the
 * baseline table.
 *
 * Two callers, two key-derivation strategies:
 *
 * - **Link crawl** (`mode="crawl"`) keys baselines by snapshot URL — one
 *   row per page. The caller filters `snapshots[]` down to changed pages
 *   so generation only runs on what changed.
 *
 * - **State explorer** (`mode="state"`) keys baselines by a composite
 *   `url#fp=<fingerprint>` — distinct states at the same URL (login form
 *   blank vs login form with errors) are tracked as separate baseline
 *   rows. The caller does **not** filter `snapshots[]` post-diff because
 *   journeys reference unchanged states for context; filtering would
 *   break flow generation. The diff is informational + persistent, but
 *   no-change crawls still short-circuit the generation pipeline.
 *
 * @param {object} project - project record (must carry id + canonicalUrl/url)
 * @param {object} run - mutable run record
 * @param {object[]} snapshots - normalised snapshots (with synthetic .url for state mode)
 * @param {string} mode - "crawl" | "state"
 * @param {object} [opts]
 * @param {function(object): string} [opts.fingerprintOf]
 *   Forwarded to `diffCrawlSnapshots`. State mode supplies a function that
 *   returns a pre-computed fingerprint so the composite `url#fp=<fp>` key
 *   doesn't feed back into `fingerprintState`'s URL-derived computation
 *   (which would make every state-mode re-crawl look "changed" — the
 *   bug AUTO-002b's first round shipped with).
 * @returns {{noChanges: boolean, changedSet: (Set<string>|null), skipped: boolean}}
 *   `skipped=true` when the diff was bypassed (preview crawl or zero snapshots).
 *   `noChanges=true` when there's an existing baseline and nothing changed.
 *   `changedSet` is the set of keys (URLs or composite keys) that changed;
 *   the caller decides whether to filter `snapshots[]` against it.
 */
function runDiffAwareBaseline(project, run, snapshots, mode, opts = {}) {
  // AUTO-002 / AUTO-015: classify "preview crawl" by comparing the URL we
  // *asked Playwright to load* (`project.url`) against the project's
  // CANONICAL production URL. The AUTO-015 trigger routes overwrite
  // `project.url` with the deployment preview URL while preserving
  // `canonicalUrl`, so a mismatch is the unambiguous signal that this is a
  // preview crawl and baselines must be preserved.
  //
  // We deliberately do NOT consult `snapshots[0].url` here. The first
  // snapshot's URL is post-redirect — production sites routinely redirect
  // their entry URL to a different origin (`example.com` → `www.example.com`,
  // `http://` → `https://`, apex → www, etc.) and the previous code that
  // used `snapshots[0]?.url || project.url` would falsely classify those
  // crawls as "preview" and silently skip baseline updates on every
  // subsequent crawl. Redirects are a property of the site, not a signal
  // about *which* deployment we're hitting.
  const canonicalForOriginCheck = project.canonicalUrl || project.url;
  const sameOrigin = (() => {
    try {
      return new URL(project.url).origin === new URL(canonicalForOriginCheck).origin;
    } catch { return false; }
  })();
  if (!sameOrigin) {
    log(run, `↪️  Preview-deployment crawl detected — skipping baseline diff (preserving production baselines).`);
    return { noChanges: false, changedSet: null, skipped: true };
  }
  if (snapshots.length === 0) {
    // Defence-in-depth: a crawl that yielded zero snapshots but passed
    // the unreachable-target check above (e.g. auth wall, SPA with no
    // crawlable links, Playwright silent failure) must not wipe the
    // project's baselines. Skip the diff entirely.
    log(run, `⚠️  ${mode === "state" ? "State exploration" : "Crawl"} returned zero snapshots — skipping baseline diff to preserve existing fingerprints.`);
    return { noChanges: false, changedSet: null, skipped: true };
  }

  const existingBaselines = crawlBaselineRepo.getMapByProjectId(project.id);
  const diff = diffCrawlSnapshots(existingBaselines, snapshots, opts);
  run.changedPages = diff.changedPages;
  run.removedPages = diff.removedPages;
  emitRunEvent(run.id, "pages_changed", {
    changedPages: diff.changedPages,
    removedPages: diff.removedPages,
    unchangedPages: diff.unchangedPages,
  });

  if (Object.keys(existingBaselines).length > 0 && diff.changedPages.length === 0) {
    // No-change crawl: existing baselines still authoritative for observed
    // pages. Signal short-circuit to the caller via run.noChangesDetected.
    //
    // Edge case: a crawl with zero added/changed pages can still report
    // `removedPages` (a page genuinely went away while the rest stayed
    // identical). We must drop those baseline rows here — otherwise they
    // persist forever and every subsequent crawl re-reports them as
    // `removedPages` indefinitely. The merge call with empty fingerprints
    // is upsert-only, so existing observed-page rows are untouched.
    if (diff.removedPages.length > 0) {
      crawlBaselineRepo.mergeProjectBaselines(project.id, {}, diff.removedPages);
    }
    log(run, `🟰 No ${mode === "state" ? "state" : "page"} changes detected against the previous crawl baseline.`);
    run.noChangesDetected = true;
    return { noChanges: true, changedSet: null, skipped: false };
  }

  // Changes detected (or first-ever crawl). Merge upserts observed entries
  // and only deletes URLs the diff explicitly classified as removed —
  // partial-crawl-safe (a transient page failure won't wipe the baseline).
  crawlBaselineRepo.mergeProjectBaselines(project.id, diff.fingerprints, diff.removedPages);
  log(run, `🧬 ${mode === "state" ? "State" : "Crawl"} diff: ${diff.changedPages.length} changed/new, ${diff.removedPages.length} removed, ${diff.unchangedPages.length} unchanged.`);
  return {
    noChanges: false,
    changedSet: new Set(diff.changedPages),
    skipped: false,
    hadExistingBaseline: Object.keys(existingBaselines).length > 0,
  };
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
  // DIF-013: anonymous opt-out telemetry — coarse-grained event with PII
  // stripped (URL → domain via sanitizeProps).
  trackTelemetry("generate.start", {
    projectId: project.id,
    provider: getProviderName(),
    testCount,
    descriptionLength: (description || "").length,
    url: project.url,
  });
  log(run, `✦ Starting test generation from requirement for "${name}"`);
  log(run, `🤖 AI provider: ${getProviderName()}`);
  log(run, `⚙️ Run config:`);
  log(run, `Generation mode: 📝 From requirement (no crawl)`);
  log(run, `Explorer mode: ⏭️ None (crawl skipped — generating from requirement)`);
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
    // INF-007: emit run-outcome + duration histograms via the shared helper.
    // Labelled `type: "generate"` so dashboards can split crawl-driven
    // generation from description-driven generation — the latter has very
    // different latency characteristics (no Playwright launch, no element
    // classification). See `utils/metrics.js#recordRunOutcome`.
    recordRunOutcome(run, "generate");
    setStep(run, 8);
    log(run, `\n📊 Pipeline Summary:`);
    log(run, `Raw: ${rawTests.length} | Enhanced: ${enhancedTests.length} | Validated: ${validatedTests.length} | Rejected: ${rejected}`);
    logSuccess(run, `Done! ${run.tests.length} test(s) generated from description for "${name}".`);
    structuredLog("generate.complete", { runId: run.id, projectId: project.id, tests: run.tests.length, durationMs: run.duration });
    // DIF-013: report generation outcome (count + rejection rate proxy).
    trackTelemetry("generate.complete", {
      projectId: project.id,
      provider: getProviderName(),
      testsGenerated: run.tests.length,
      rejected,
      durationMs: run.duration,
      url: project.url,
    });
    emitRunEvent(run.id, "done", { status: "completed", testsGenerated: run.tests.length });
  });

  return createdTestIds;
}

/**
 * Full 8-stage pipeline: crawl a project URL, classify pages, generate tests,
 * deduplicate, enhance, validate, and persist.
 *
 * @param {Object} project                - The project `{ id, name, url, credentials? }`.
 * @param {Object} run                    - The run record (mutated in place with results).
 * @param {Object} [options]
 * @param {string} [options.dialsPrompt]   - Pre-built prompt fragment from Test Dials config.
 * @param {string} [options.testCount]     - Test count hint (`"one"` | `"small"` | `"medium"` | `"large"` | `"ai_decides"`).
 * @param {string} [options.explorerMode]   - `"crawl"` (default) or `"state"` — from Test Dials.
 * @param {Object} [options.explorerTuning] - Numeric tuning for state explorer `{ maxStates, maxDepth, maxActions, actionTimeout }`.
 * @param {AbortSignal} [options.signal]   - Abort signal for cancellation.
 * @returns {Promise<void>}
 */
export async function crawlAndGenerateTests(project, run, { dialsPrompt = "", testCount = "ai_decides", explorerMode, explorerTuning, signal } = {}) {
  const runStart = Date.now();
  const mode = (explorerMode || "crawl").toLowerCase();

  // ── Step 1: Smart crawl or state exploration ─────────────────────────────
  structuredLog("crawl.start", { runId: run.id, projectId: project.id, mode, url: project.url });
  // DIF-013: report crawl/state-explore launch. URL is stripped to domain
  // by sanitizeProps before sending — no full URLs leave the host.
  trackTelemetry("crawl.start", {
    projectId: project.id,
    mode,
    provider: getProviderName(),
    testCount,
    url: project.url,
  });
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
  // AUTO-002: track the total pages the crawl actually discovered (before
  // diff-aware filtering reduces `snapshots` to just the changed subset).
  // Reported to the user as "pages found" / telemetry — otherwise a crawl
  // that discovered 10 pages with 3 changed would misleadingly report
  // `pagesFound: 3`, skewing both the UI and the `crawl.complete`
  // telemetry funnel which measures crawl quality.
  let pagesCrawled = 0;

  if (mode === "state") {
    // ── State-based exploration (new engine) ─────────────────────────────
    //
    // AUTO-002b: state-explorer mode is now diff-aware via composite keys.
    // The state explorer produces multiple snapshots per URL (login form
    // blank vs login form with errors), so we key the baseline by the
    // composite `url#fp=<fingerprint>` instead of plain URL — this lets
    // distinct states at the same URL be tracked as separate baseline
    // rows. The caller does NOT filter `snapshots[]` post-diff because
    // journeys reference unchanged states for flow context; we run the
    // full state set through generation but short-circuit when nothing
    // changed against the baseline (no-change crawl → `completed_empty`).
    const exploration = await exploreStates(project, run, { signal, tuning: explorerTuning });
    snapshots = exploration.snapshots;
    snapshotsByUrl = exploration.snapshotsByUrl;
    apiEndpoints = exploration.apiEndpoints || [];
    pagesCrawled = snapshots.length;

    throwIfAborted(signal);

    // AUTO-002b: diff-aware baseline for state mode.
    //
    // We synthesise a composite key per state (`originalUrl#fp=<fp>`) so
    // distinct states at the same URL (login blank vs login with errors)
    // track as separate baseline rows. But we must NOT let the diff
    // helper re-derive fingerprints from the composite-keyed snapshots —
    // `fingerprintState()` includes `snap.url` in its hash, so feeding
    // it a `url#fp=<fp>` URL would produce a different fingerprint than
    // the one originally computed (and stored as the suffix of the
    // composite key). Every re-crawl would then look "changed".
    //
    // Instead, we extract the pre-computed fingerprint directly from the
    // composite-key suffix and pass it through `fingerprintOf`. The
    // baseline stores it; the next run's diff compares apples to apples.
    if (snapshots.length > 0) {
      // Build an O(n) reverse lookup (snapshot → fingerprint) once, rather
      // than scanning `fpMap.entries()` per snapshot (O(n²)) AND — more
      // importantly — avoiding the fragility of relying on object identity
      // via `===`. stateExplorer.js:215-216 currently stores the SAME
      // snapshot reference in `snapshotsByFp` and `ctx.snapshots`, but if
      // any future refactor ever clones snapshots between those two stores,
      // identity comparison silently collapses all states into one baseline
      // row (defeating AUTO-002b's composite-key design). A WeakMap keyed
      // on the snapshot object is the same one-liner but makes the identity
      // dependency explicit; callers that produce a fresh snapshot simply
      // fall through to the `snap.url` fallback on line below.
      const fpMap = exploration.stateGraph?.snapshotsByFp;
      const snapshotToFp = new WeakMap();
      if (fpMap) {
        for (const [fp, s] of fpMap.entries()) snapshotToFp.set(s, fp);
      }
      const stateKeyed = snapshots.map((snap) => {
        const fp = snapshotToFp.get(snap) || null;
        return fp ? { ...snap, url: `${snap.url}#fp=${fp}`, _stateFp: fp } : snap;
      });
      const stateDiff = runDiffAwareBaseline(project, run, stateKeyed, "state", {
        // Pull the pre-computed fingerprint off the snapshot rather than
        // recomputing — the composite-key URL would otherwise feed back
        // into `fingerprintState` and falsely flip every state to changed.
        fingerprintOf: (snap) => snap._stateFp || snap.url,
      });
      if (stateDiff.noChanges) {
        // Short-circuit: nothing changed, skip generation entirely.
        snapshots = [];
        snapshotsByUrl = {};
      }
      // else: keep all snapshots — generation needs the full state set
      // for journey/flow context; the diff has been persisted + emitted.
    }

    // ── No-change short-circuit: skip filter/classify/journey/generation ─
    // When the state-mode diff reported zero changes, `snapshots` is empty
    // above. We must also zero out `journeys` and skip the supplementary
    // link-journey discovery — otherwise `exploration.journeys` (still
    // populated from the in-memory explorer run) would feed `generateAllTests`
    // and produce LLM calls + tests on a "no changes" run, which the run
    // is supposed to short-circuit to `completed_empty`.
    if (run.noChangesDetected) {
      filteredSnapshots = [];
      classifiedPages = [];
      classifiedPagesByUrl = {};
      journeys = [];
    } else {
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
    }
  } else {
    // ── Legacy link-based crawl ──────────────────────────────────────────
    const crawlResult = await crawlPages(project, run, { signal });
    snapshots = crawlResult.snapshots;
    snapshotsByUrl = crawlResult.snapshotsByUrl;
    apiEndpoints = crawlResult.apiEndpoints || [];
    pagesCrawled = snapshots.length;

    // ── Early failure: unreachable target ────────────────────────────────
    // If the crawl produced zero pages AND every navigation attempt failed
    // with a network-class error (DNS, connection refused, TLS, timeout),
    // throw a navigation error so the run is classified `failed` with a
    // clear DNS/network reason — instead of silently completing as
    // "completed_empty" after the Filter/Classify/Generate stages run on
    // an empty snapshot list.
    //
    // NOTE: This check uses the raw crawl result (before diff filtering) and
    // runs BEFORE baselines are replaced — so a transient network failure
    // does not wipe the project's baseline fingerprints.
    const failures = crawlResult.navigationFailures || [];
    if (snapshots.length === 0 && failures.length > 0) {
      const networkFailures = failures.filter(f =>
        f.category === "dns" || f.category === "network" || f.category === "timeout"
      );
      if (networkFailures.length === failures.length) {
        const primary = networkFailures[0];
        const isDns = networkFailures.some(f => f.category === "dns");
        logWarn(run, isDns
          ? `Crawl aborted: DNS resolution failed for ${project.url} (${primary.message})`
          : `Crawl aborted: target URL unreachable — ${primary.message}`);
        structuredLog("crawl.unreachable", {
          runId: run.id, projectId: project.id, url: project.url,
          category: primary.category, message: primary.message,
        });
        // Throw with a message that contains "net::err_" / DNS markers so
        // classifyError() routes it to the NAVIGATION category (and the DNS
        // branch added in this change produces the DNS-specific hint).
        throw new Error(isDns
          ? `Target host could not be resolved (DNS). "${project.url}" is not reachable — ${primary.message}`
          : `Target URL is unreachable — ${primary.message}`
        );
      }
    }

    // ── Diff-aware crawl baseline (AUTO-002) ──────────────────────────────
    // Runs after the unreachable-target check so that transient network
    // failures cannot wipe existing baselines. The shared helper handles
    // canonical-URL origin checking (AUTO-015 preview-crawl preservation),
    // zero-snapshot defence, no-change short-circuit, and partial-crawl-safe
    // baseline merging. See `runDiffAwareBaseline` JSDoc for details.
    const diffOutcome = runDiffAwareBaseline(project, run, snapshots, "crawl");
    if (diffOutcome.noChanges) {
      // No-change crawl → short-circuit generation. The finalize block
      // checks `run.noChangesDetected` to render the correct
      // `completed_empty` message ("no changes" vs "AI returned empty").
      snapshots = [];
      snapshotsByUrl = {};
    } else if (!diffOutcome.skipped && diffOutcome.hadExistingBaseline && diffOutcome.changedSet) {
      // Diff-aware generation scope: filter to changed pages only.
      // First-ever crawl (no existing baseline) skips this filter so every
      // page flows through generation, matching pre-AUTO-002 behaviour.
      const changedSet = diffOutcome.changedSet;
      snapshots = snapshots.filter((snap) => changedSet.has(snap.url));
      snapshotsByUrl = Object.fromEntries(
        Object.entries(snapshotsByUrl).filter(([url]) => changedSet.has(url))
      );
      log(run, `🎯 Diff-aware generation scope: ${snapshots.length} changed page(s).`);
    }

    throwIfAborted(signal);

    // ── No-change short-circuit: skip filter/classify/journey/generation ─
    // Mirrors the state-mode branch above (see `if (run.noChangesDetected)`
    // around line 442). When the diff reported zero changes, `snapshots` is
    // empty — running filter/classify/journey detection on empty inputs is
    // wasted work AND `journey` ends up undefined which `generateAllTests`
    // happily processes (no LLM cost, but `journeys.length` access at the
    // structuredLog call later would crash). Short-circuit to empty arrays
    // and let the finalize block route to `completed_empty` with the
    // "no page changes since baseline" message.
    if (run.noChangesDetected) {
      filteredSnapshots = [];
      classifiedPages = [];
      classifiedPagesByUrl = {};
      journeys = [];
    } else {
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
  }

  throwIfAborted(signal);

  // INF-007: Prometheus counter for total pages discovered by the crawler
  // (`app_crawl_pages_total`), labelled by explorer mode so link-crawl vs.
  // state-exploration cost can be tracked independently in dashboards.
  // `pagesCrawled` is the full breadth from either branch above, BEFORE
  // AUTO-002 diff-aware filtering narrows `snapshots` to changed pages — the
  // counter measures crawl cost, not generation scope. Best-effort: a
  // counter hiccup must never fail the run.
  try { if (pagesCrawled > 0) crawlPagesTotal.inc({ mode }, pagesCrawled); } catch { /* best-effort */ }

  // SEC-006: PII firewall — sanitize snapshots + classified pages before
  // they reach `generateAllTests` (which builds the LLM prompt). Wiring
  // lives in `pipelineOrchestrator.sanitizeRunInputs` so any future caller
  // of the generation pipeline gets the same firewall behaviour from one
  // place. Honours `project.strictPiiFirewall` (default ON) and
  // `project.piiAllowlist`.
  const { snapshotsByUrl: effectiveSnapshotsByUrl, classifiedPages: effectiveClassifiedPages } =
    sanitizeRunInputs(project, run, { snapshotsByUrl, classifiedPages });

  // ── Step 4: AI test generation ──────────────────────────────────────────
  setStep(run, 4);
  structuredLog("pipeline.generate", { runId: run.id, pages: effectiveClassifiedPages.length, journeys: journeys.length });
  log(run, `🤖 Generating intent-driven tests...`);
  const genResult = await generateAllTests(effectiveClassifiedPages, journeys, effectiveSnapshotsByUrl, (msg) => log(run, msg), { dialsPrompt, testCount, signal });
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
  // Skip API test generation for trivial traffic — sites like google.com
  // emit a few GET requests for assets/telemetry that don't produce useful
  // API contract tests. Only invest an LLM call when there are enough
  // meaningful endpoints (≥4) or at least one mutation (POST/PUT/PATCH/DELETE).
  const hasMutationEndpoints = apiEndpoints.some(ep => ep.method !== "GET");
  const skipApiTests = apiEndpoints.length > 0 && apiEndpoints.length < 4 && !hasMutationEndpoints;
  if (skipApiTests) {
    log(run, `🌐 Only ${apiEndpoints.length} trivial GET endpoint(s) captured — skipping API test generation (need ≥4 endpoints or a mutation)`);
  }
  if (apiEndpoints.length > 0 && !skipApiTests && !genResult.rateLimitHit) {
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
    await runPostGenerationPipeline(rawTests, project, run, { snapshotsByUrl: effectiveSnapshotsByUrl, classifiedPagesByUrl, signal });

  // ── Step 8: Store & Done ────────────────────────────────────────────────
  persistGeneratedTests(validatedTests, project, run);

  run.snapshots = filteredSnapshots;
  run.pages = filteredSnapshots.map(s => ({ url: s.url, title: s.title || s.url, status: "crawled" }));
  run.testsGenerated = run.tests.length;
  run.pipelineStats = buildPipelineStats({
    // pagesCrawled = total pages the crawl discovered, before AUTO-002 diff
    // filtering. `snapshots.length` at this point has been narrowed to just
    // the changed pages; reporting that as "pagesFound" would understate
    // crawl breadth and break the telemetry funnel that distinguishes
    // "small site" from "big site with few changes".
    pagesFound: pagesCrawled, rawTests, removed, enhancedCount, rejected, journeys, dedupStats,
    apiEndpointsDiscovered: apiEndpoints.length,
  });

  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    run.duration = Date.now() - runStart;
    setStep(run, 8);
    log(run, `\n📊 Pipeline Summary:`);
    // Show both the crawl breadth AND the diff-aware generation scope when
    // they differ, so reviewers can distinguish "big site with few changes"
    // from "small site, everything generated". `pagesCrawled` is the full
    // count, `snapshots.length` is the filtered subset that drove generation.
    const scopeSuffix = pagesCrawled !== snapshots.length ? ` (${snapshots.length} changed → generated)` : "";
    log(run, `Pages: ${pagesCrawled}${scopeSuffix} | Raw tests: ${rawTests.length} | Enhanced: ${enhancedTests.length} | Validated: ${validatedTests.length}`);
    log(run, `Journey tests: ${validatedTests.filter(t => t.isJourneyTest).length} | API tests: ${validatedTests.filter(t => t._generatedFrom === "api_har_capture" || t._generatedFrom === "api_user_described").length} | Rejected: ${rejected} | Avg quality: ${dedupStats.averageQuality}/100`);
    if (apiEndpoints.length > 0) {
      log(run, `API endpoints discovered: ${apiEndpoints.length}`);
    }

    // ── ENH-034: Distinguish empty crawl results ──────────────────────────
    // When a crawl completes but generates zero tests (site behind auth,
    // SPA with no crawlable links, AI returned empty), mark as
    // "completed_empty" so the UI can show a warning instead of green success.
    if (run.tests.length === 0) {
      run.status = "completed_empty";
      if (run.noChangesDetected) {
        log(run, `✅ Crawl completed — no page changes since the last baseline; generation skipped.`);
      } else {
      logWarn(run, `Crawl completed but no tests were generated.`);
      logWarn(run, `Possible causes:`);
      logWarn(run, `  1. AI provider is temporarily overloaded (503) — wait 5-10 min and Re-run, or configure multi-provider fallback in Settings`);
      logWarn(run, `  2. Site requires authentication — add credentials in Project Settings`);
      logWarn(run, `  3. Pages have no interactive elements — try a different start URL`);
      logWarn(run, `  4. AI provider returned empty — check your API key in Settings`);
      logWarn(run, `  5. Try "State exploration" mode to discover dynamic content`);
      }
    } else if (run.rateLimitError) {
      logWarn(run, `Completed with rate limit — only ${run.tests.length} test(s) generated. Switch AI provider or retry later.`);
    } else {
      logSuccess(run, `Done! ${run.tests.length} high-quality tests generated.`);
    }
    structuredLog("crawl.complete", {
      runId: run.id, projectId: project.id, mode,
      // `pages` = full crawl breadth; `pagesGenerated` = diff-filtered
      // subset that actually drove generation. Splitting these lets
      // telemetry funnels measure both crawl cost and generation scope.
      pages: pagesCrawled, pagesGenerated: snapshots.length,
      tests: run.tests.length, durationMs: run.duration,
      apiEndpoints: apiEndpoints.length,
    });
    // DIF-013: report crawl outcome with the same shape as crawl.start so
    // PostHog funnels (start → complete) line up. `status` distinguishes
    // success from `completed_empty` so we can measure crawl quality.
    trackTelemetry("crawl.complete", {
      projectId: project.id,
      mode,
      status: run.status,
      // pages = full crawl breadth (matches crawl.start funnel shape);
      // pagesGenerated = diff-filtered subset that drove generation.
      pages: pagesCrawled,
      pagesGenerated: snapshots.length,
      testsGenerated: run.tests.length,
      apiEndpoints: apiEndpoints.length,
      rateLimitHit: !!run.rateLimitError,
      durationMs: run.duration,
      url: project.url,
    });
    // INF-007: emit crawl-run outcome + duration histograms via the shared
    // helper. Bucketed by `(type, status)` so the `completed_empty`
    // short-circuit (no changes since baseline, or no interactive elements)
    // surfaces as a distinct series from `completed` — operators can
    // distinguish "crawls that ran but found nothing" from real successes
    // without re-querying the DB. Emitted at the END of the finalize callback
    // (after the empty-result branch above may have flipped `run.status` to
    // `completed_empty`) so the label reflects the final status, not the
    // default set by `finalizeRunIfNotAborted`. See
    // `utils/metrics.js#recordRunOutcome`.
    recordRunOutcome(run, "crawl");
    emitRunEvent(run.id, "done", { status: run.status, testsGenerated: run.tests.length });
  });
}

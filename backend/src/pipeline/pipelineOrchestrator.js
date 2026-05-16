/**
 * pipelineOrchestrator.js — Shared post-generation pipeline stages
 *
 * Steps 5–7 (Dedup → Enhance → Validate) are identical between
 * generateSingleTest and crawlAndGenerateTests. This module extracts
 * that shared logic so both callers stay thin.
 *
 * Exports:
 *   runPostGenerationPipeline(rawTests, project, run, opts) → result
 */

import { throwIfAborted } from "../utils/abortHelper.js";
import { deduplicateTests, deduplicateAcrossRuns, scoreTestWithFactors, normalizeQualityToConfidence } from "./deduplicator.js";
import { enhanceTests } from "./assertionEnhancer.js";
import { validateTest } from "./testValidator.js";
import { applyHealingTransforms } from "../selfHealing.js";
import { sanitizeDomSnapshot } from "./domSanitizer.js";
import { log, logWarn } from "../utils/runLogger.js";
import { emitRunEvent } from "../utils/runLogger.js";
import { structuredLog } from "../utils/logFormatter.js";
import { setStep } from "../utils/pipelineState.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";

/**
 * SEC-006: PII firewall — single wiring point between the crawler/classify
 * stages and the AI prompt builder. Called once per run to redact PII from
 * the snapshots AND classified pages that feed `generateAllTests` and the
 * post-generation pipeline.
 *
 * Honours per-project controls:
 *   - `project.strictPiiFirewall` (default ON; explicit `false` disables)
 *   - `project.piiAllowlist`      (string[] passed through to the sanitizer)
 *
 * Returns the same shape it was given so callers can transparently swap in
 * the sanitized values. When the firewall is disabled, inputs are returned
 * unchanged and no audit log is emitted.
 *
 * @param {object} project
 * @param {object} run
 * @param {{ snapshotsByUrl?: object, classifiedPages?: object[] }} inputs
 * @returns {{ snapshotsByUrl: object, classifiedPages: object[] }}
 */
export function sanitizeRunInputs(project, run, { snapshotsByUrl = {}, classifiedPages = [] } = {}) {
  const strict = project?.strictPiiFirewall !== false;
  if (!strict) {
    return { snapshotsByUrl, classifiedPages };
  }
  const allowlist = Array.isArray(project?.piiAllowlist) ? project.piiAllowlist : [];
  const sanSnaps = sanitizeDomSnapshot(snapshotsByUrl, { allowlist, runId: run?.id });
  const sanClassified = sanitizeDomSnapshot(classifiedPages, { allowlist, runId: run?.id });
  return {
    snapshotsByUrl: sanSnaps.output,
    classifiedPages: sanClassified.output,
  };
}

/**
 * setStep is now imported from utils/pipelineState.js — the single source of
 * truth shared with crawler.js. Keeping this comment so reviewers know the
 * function did not disappear, it moved.
 */

/**
 * Run the shared post-generation pipeline stages:
 *   Step 5: Deduplicate against batch + existing project tests
 *   Step 6: Enhance assertions
 *   Step 7: Validate (reject malformed / placeholder tests)
 *
 * @param {object[]} rawTests              — AI-generated test objects
 * @param {object}   project               — project record
 * @param {object}   run                   — mutable run record
 * @param {object}   opts
 * @param {Record<string,object>} [opts.snapshotsByUrl]        — page snapshots by URL
 * @param {Record<string,object>} [opts.classifiedPagesByUrl]  — classified pages by URL
 * @param {AbortSignal}           [opts.signal]
 * @returns {{ validatedTests: object[], enhancedTests: object[], rejected: number, removed: number, enhancedCount: number, dedupStats: object }}
 */
export async function runPostGenerationPipeline(rawTests, project, run, { snapshotsByUrl = {}, classifiedPagesByUrl = {}, signal } = {}) {
  // ── Step 5: Deduplicate ─────────────────────────────────────────────────
  throwIfAborted(signal);
  setStep(run, 5);
  log(run, `🚫 Deduplicating...`);
  const existingTests = testRepo.getByProjectId(project.id);
  const { unique, removed, stats: dedupStats } = deduplicateTests(rawTests);
  const finalTests = deduplicateAcrossRuns(unique, existingTests);
  log(run, `   ${removed} duplicates removed | ${unique.length - finalTests.length} already exist | ${finalTests.length} new unique tests`);
  structuredLog("pipeline.dedup", { runId: run.id, input: rawTests.length, unique: unique.length, removed, final: finalTests.length });

  // ── Step 6: Enhance assertions ──────────────────────────────────────────
  throwIfAborted(signal);
  setStep(run, 6);
  log(run, `✨ Enhancing assertions...`);
  const { tests: enhancedTests, enhancedCount } = enhanceTests(finalTests, snapshotsByUrl, classifiedPagesByUrl);
  log(run, `   ${enhancedCount} tests had assertions strengthened`);
  structuredLog("pipeline.enhance", { runId: run.id, enhanced: enhancedCount, total: enhancedTests.length });

  // ── Step 6a: Re-score quality factors against the enhanced code ─────────
  // The dedup stage (Step 5) attached `_quality` and `_qualityFactors` based
  // on the *pre-enhancement* `playwrightCode`. Step 6 then injects assertions
  // (toBeVisible, toHaveURL, …) which directly affect the rubric outcome —
  // a test that hit `assert.none -30` before enhancement should no longer
  // carry that penalty after the enhancer adds an `expect(...)`. Without
  // this re-score, the Review Queue's "why was this drafted?" popover
  // shows penalties that no longer apply to the persisted code, and
  // `qualityScore` is systematically biased downward for any test that
  // benefited from enhancement.
  for (const t of enhancedTests) {
    const { score, factors } = scoreTestWithFactors(t);
    t._quality = score;
    t._qualityFactors = factors;
    // AUTO-003b: keep `confidenceScore` (0–1 scale) in lock-step with the
    // re-scored `_quality` (0–100 scale) so `persistGeneratedTests` compares
    // the post-enhancement score against `autoApproveThreshold`. Without
    // this, `confidenceScore` would retain its pre-enhancement value set by
    // `deduplicateTests` and a test strengthened by the assertion enhancer
    // could miss the auto-approval threshold despite deserving to clear it.
    t.confidenceScore = normalizeQualityToConfidence(score);
  }

  // ── Step 6b: Apply self-healing transforms ────────────────────────────
  // Rewrite raw Playwright calls (page.click, page.fill, page.getByRole().click())
  // into self-healing helpers (safeClick, safeFill, safeExpect) BEFORE validation.
  // Without this, the validator rejects code that uses raw Playwright methods —
  // but at runtime executeTest.js applies the same transforms, so the code would
  // actually work. This was the #1 cause of false-positive rejections, especially
  // with Ollama which frequently ignores the "use safeClick" prompt instruction.
  let healingTransformed = 0;
  for (const t of enhancedTests) {
    if (t.playwrightCode) {
      const before = t.playwrightCode;
      t.playwrightCode = applyHealingTransforms(t.playwrightCode);
      if (t.playwrightCode !== before) healingTransformed++;
    }
  }
  if (healingTransformed > 0) {
    log(run, `🩹 ${healingTransformed} test(s) had raw Playwright calls rewritten to self-healing helpers`);
  }

  // ── Step 7: Validate ────────────────────────────────────────────────────
  throwIfAborted(signal);
  setStep(run, 7);
  log(run, `✅ Validating generated tests...`);
  const validatedTests = [];
  let rejected = 0;
  for (const t of enhancedTests) {
    const issues = validateTest(t, project.url);
    // CAP-003: validateTest() runs the secret scanner and annotates `t.secretScan`
    // when findings exist. Promote that to a run-level flag here so callers
    // (CI consumers, reviewer UI) can distinguish "rejected for malformed code"
    // from "rejected because the AI leaked credentials into the test body".
    if (t.secretScan?.blocked) {
      run.secretScanBlocked = true;
    }
    if (issues.length === 0) {
      validatedTests.push(t);
    } else {
      rejected++;
      logWarn(run, `Rejected "${t.name || "unnamed"}": ${issues.join("; ")}`);
    }
  }
  log(run, `   ${validatedTests.length} valid | ${rejected} rejected`);
  structuredLog("pipeline.validate", { runId: run.id, valid: validatedTests.length, rejected });

  throwIfAborted(signal);

  return { validatedTests, enhancedTests, rejected, removed, enhancedCount, dedupStats };
}

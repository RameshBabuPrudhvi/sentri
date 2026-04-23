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
import { deduplicateTests, deduplicateAcrossRuns } from "./deduplicator.js";
import { enhanceTests } from "./assertionEnhancer.js";
import { validateTest } from "./testValidator.js";
import { applyHealingTransforms } from "../selfHealing.js";
import { log, logWarn } from "../utils/runLogger.js";
import { emitRunEvent } from "../utils/runLogger.js";
import { structuredLog } from "../utils/logFormatter.js";
import { setStep } from "../utils/pipelineState.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";

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

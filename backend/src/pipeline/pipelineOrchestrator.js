/**
 * pipelineOrchestrator.js — Shared post-generation pipeline stages
 *
 * Steps 5–7 (Dedup → Enhance → Validate) are identical between
 * generateSingleTest and crawlAndGenerateTests. This module extracts
 * that shared logic so both callers stay thin.
 *
 * Exports:
 *   runPostGenerationPipeline(rawTests, project, db, run, opts) → result
 */

import { throwIfAborted } from "../utils/abortHelper.js";
import { deduplicateTests, deduplicateAcrossRuns } from "./deduplicator.js";
import { enhanceTests } from "./assertionEnhancer.js";
import { validateTest } from "./testValidator.js";
import { log, logWarn } from "../utils/runLogger.js";
import { emitRunEvent } from "../utils/runLogger.js";
import { structuredLog } from "../utils/logFormatter.js";

/**
 * setStep — update the run's currentStep and broadcast a snapshot to SSE.
 */
function setStep(run, step) {
  run.currentStep = step;
  emitRunEvent(run.id, "snapshot", { run });
}

/**
 * Run the shared post-generation pipeline stages:
 *   Step 5: Deduplicate against batch + existing project tests
 *   Step 6: Enhance assertions
 *   Step 7: Validate (reject malformed / placeholder tests)
 *
 * @param {object[]} rawTests              — AI-generated test objects
 * @param {object}   project               — project record
 * @param {object}   db                    — in-memory database
 * @param {object}   run                   — mutable run record
 * @param {object}   opts
 * @param {Record<string,object>} [opts.snapshotsByUrl]        — page snapshots by URL
 * @param {Record<string,object>} [opts.classifiedPagesByUrl]  — classified pages by URL
 * @param {AbortSignal}           [opts.signal]
 * @returns {{ validatedTests: object[], enhancedTests: object[], rejected: number, removed: number, enhancedCount: number, dedupStats: object }}
 */
export async function runPostGenerationPipeline(rawTests, project, db, run, { snapshotsByUrl = {}, classifiedPagesByUrl = {}, signal } = {}) {
  // ── Step 5: Deduplicate ─────────────────────────────────────────────────
  throwIfAborted(signal);
  setStep(run, 5);
  log(run, `🚫 Deduplicating...`);
  const existingTests = Object.values(db.tests).filter(t => t.projectId === project.id);
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

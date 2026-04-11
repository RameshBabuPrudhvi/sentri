/**
 * @module utils/pipelineState
 * @description Shared pipeline state helpers used by crawler.js and
 * pipelineOrchestrator.js.
 *
 * Previously both modules defined an identical `setStep()` function inline —
 * a DRY violation that meant any change to the step-update contract had to be
 * made in two places. This module is the single source of truth.
 *
 * ### Exports
 * - {@link setStep} — Update run.currentStep, persist to DB, broadcast SSE snapshot.
 */

import { emitRunEvent } from "./runLogger.js";
import * as runRepo from "../database/repositories/runRepo.js";

/**
 * Update the pipeline's current step counter on a run object.
 *
 * - Mutates `run.currentStep` in memory (so SSE snapshot reflects the new step).
 * - Persists the new step to SQLite (so the frontend polling fallback stays in sync).
 * - Emits a `"snapshot"` SSE event so connected clients update their progress bar.
 *
 * @param {Object} run  - The mutable run record (created in routes/runs.js).
 * @param {number} step - Pipeline step number (1–8).
 */
export function setStep(run, step) {
  run.currentStep = step;
  runRepo.update(run.id, { currentStep: step });
  emitRunEvent(run.id, "snapshot", { run });
}

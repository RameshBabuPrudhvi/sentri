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
 * - {@link PIPELINE_STEPS} — Named step constants used by `agent_event`
 *   emit sites + `agentLoop.js` so we never type the magic number `7`
 *   inline. Mirrors `backend/src/crawler.js`'s docblock + the frontend's
 *   `PIPELINE_STAGES` array.
 */

import { emitRunEvent } from "./runLogger.js";
import * as runRepo from "../database/repositories/runRepo.js";

/**
 * Canonical pipeline step numbering. Single source of truth for the
 * backend; the frontend mirrors this in `frontend/src/pages/TestLab.jsx`'s
 * `PIPELINE_STAGES` array and `frontend/src/config.js`'s
 * `PIPELINE_STEP_ROLES` map.
 *
 * Step 7 (`REVIEW`) is the validate / quality-check stage that the
 * `feedbackLoop` regenerator and `agentLoop`'s single-agent-collapse
 * advisory both target. Naming it explicitly here means a future
 * pipeline-renumbering refactor only has to touch one file.
 */
export const PIPELINE_STEPS = Object.freeze({
  CRAWL: 1,
  FILTER: 2,
  CLASSIFY: 3,
  GENERATE: 4,
  DEDUP: 5,
  ENHANCE: 6,
  REVIEW: 7,
  DONE: 8,
});

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

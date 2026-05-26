/**
 * @module utils/pipelineState
 * @description Shared pipeline stage-state helper.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` so both the legacy
 * `PipelinePanel` stage list and the new `AgentConversation` chat transcript
 * derive stage state from the same single source of truth. Pre-extraction,
 * a fork between the two would have shown the conversation freezing at one
 * step while the panel sidebar advanced — a guaranteed-confusing UX gap.
 *
 * Naming note — the backend already has a `backend/src/utils/pipelineState.js`
 * that exposes a different export (`setStep` — writer side, persists the
 * step + emits SSE). The frontend module name mirrors it intentionally so
 * the "where does pipeline-stage logic live?" answer is symmetric across
 * the two stacks. The exports don't collide because the backend file is
 * server-side ESM and never imported from the frontend bundle.
 */

/**
 * Derive a stage's display state for a given run.
 *
 * Returns one of:
 *   - `"done"`    — stage has been reached/finished
 *   - `"active"`  — pipeline is currently working this stage
 *   - `"pending"` — pipeline hasn't reached this stage yet
 *
 * ### Status semantics
 *
 * - `completed` / `completed_empty` — every stage reads "done".
 * - `failed` / `aborted` / `interrupted` — the stage we stopped on reads
 *   "done" (we reached it), every later stage reads "pending". Nothing
 *   pulses — freezing the visualisation at the stop point reads more
 *   honestly than leaving the spinner running on a stage that's never
 *   going to make progress. `interrupted` is the orphan-recovery status
 *   set by `backend/src/database/repositories/runRepo.js#markOrphansInterrupted`
 *   on server restart; it's a terminal state from the UI's perspective
 *   so it shares the freeze semantics with `failed` / `aborted`.
 * - `running` (or status unset) — stages before `currentStep` are "done",
 *   `currentStep` itself is "active", everything after is "pending". When
 *   `currentStep` is null (run just started, no step set yet) every stage
 *   reads "pending" so the visualisation can show a "starting up" idle
 *   state without false-claiming any stage is in flight.
 *
 * @param {number}      step         - 1-based pipeline step (1..8).
 * @param {number|null} currentStep  - `run.currentStep` (1..8 or null).
 * @param {string}      status       - `run.status` (`running` | `completed` |
 *   `completed_empty` | `failed` | `aborted` | `interrupted`).
 * @returns {"done"|"active"|"pending"}
 */
export function stageStatus(step, currentStep, status) {
  if (status === "completed" || status === "completed_empty") {
    return "done";
  }
  // For failed/aborted/interrupted runs, freeze the pipeline at the step
  // where it stopped rather than leaving it pulsing as if still running.
  // The step the run stopped on is marked "done" (we reached it) but no
  // step is "active". `interrupted` is included so server-restart orphan
  // runs (set by `runRepo.markOrphansInterrupted`) don't render with a
  // spinner stuck mid-pipeline forever.
  if (status === "failed" || status === "aborted" || status === "interrupted") {
    if (currentStep == null) return "pending";
    if (step <= currentStep) return "done";
    return "pending";
  }
  if (currentStep == null) return "pending";
  if (step < currentStep) return "done";
  if (step === currentStep) return "active";
  return "pending";
}

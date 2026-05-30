/**
 * @module utils/runRetry
 * @description Pure helper for the G11 "Retry failed run" path.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx#handleRetry` so the
 * payload-building logic lives in `utils/` (AGENTS.md §40 — "Never define a
 * helper mid-component file") and can be unit-tested without rendering the
 * 2500-line TestLab component. The React-state side-effects (setActiveRun,
 * setLaunching, ensureAiProvider, …) stay in the page; this module is
 * intentionally I/O-free.
 *
 * ### Contract
 *
 * Crawl + generate runs persist their launch configuration in different
 * places:
 *   - Both store `dialsConfig` inside `run.generateInput`
 *     (`backend/src/routes/runs.js:95` for crawl,
 *      `backend/src/routes/tests.js:735` for generate).
 *   - `environmentId` lives directly on the `runs` table
 *     (`runRepo.js#INSERT_COLS`, since migration 024).
 *   - Generate runs additionally persist `name` + `description` in
 *     `generateInput` so the same prompt re-runs verbatim.
 *
 * Attachments are NOT preserved on retry — they were folded into
 * `description` at launch time by `handleGenerateFromRequirement`, so the
 * persisted prompt already carries them inline.
 *
 * Legacy / interrupted runs that pre-date the `generateInput` column fall
 * back to the page-level `dialsConfig` passed in via `fallbackDialsConfig`.
 */

/**
 * Build the request body + metadata needed to re-launch a failed/aborted run.
 *
 * @param {Object} runData              - The failed run's full row (from SSE snapshot).
 * @param {Object} fallbackDialsConfig  - Page-level dials config (used when
 *   the persisted run doesn't carry `generateInput.dialsConfig` — legacy /
 *   interrupted runs that pre-date the column).
 * @returns {{ body: Object, name?: string, description?: string }}
 *   The body is shaped for either `api.crawl(projectId, body)` (no `name` /
 *   `description`) or `api.generateTest(projectId, body)` (includes both).
 *   Caller picks the API based on the run's `type` field.
 */
export function buildRetryPayload(runData, fallbackDialsConfig) {
  const persistedDials = runData?.generateInput?.dialsConfig || fallbackDialsConfig;
  const persistedEnv = runData?.environmentId || "";
  const body = { dialsConfig: persistedDials };
  if (persistedEnv) body.environmentId = persistedEnv;
  return { body, persistedDials, persistedEnv };
}

/**
 * Resolve the name + description for a generate retry, with defence-in-depth
 * fallbacks for runs missing `generateInput` (legacy / interrupted).
 *
 * @param {Object} runData
 * @returns {{ name: string, description: string }}
 */
export function resolveGenerateRetryFields(runData) {
  const input = runData?.generateInput || {};
  return {
    name: input.name || "Retry",
    description: input.description || "",
  };
}

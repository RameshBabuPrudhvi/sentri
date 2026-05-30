/**
 * @module utils/routeHelpers
 * @description Shared route-layer helpers used by `routes/tests.js`,
 * `routes/recorder.js`, `routes/runs.js`, `routes/trigger.js` so the
 * validation contract for shared concerns (env scoping, etc.) lives in
 * one place. Per AGENTS.md pre-flight rule #4 — helpers used by ≥2 call
 * sites belong in `utils/`, not duplicated inline in each route file.
 */

import * as environmentRepo from "../database/repositories/environmentRepo.js";

/**
 * DIF-012: Resolve and validate an optional `environmentId` against the
 * given project, returning the env row when valid. Returns `null` when no
 * envId was supplied; throws an `Error` with `httpStatus` and `message`
 * fields when the envId is invalid (unknown or belongs to a different
 * project) so callers can `return res.status(httpStatus).json({error})`.
 *
 * Mirrors the validation contract used by every entry point that accepts
 * a per-request env override (crawl, run, generate, record) so all four
 * paths share one source of truth.
 *
 * @param {string|null|undefined} environmentId
 * @param {Object} project — already-resolved, workspace-scoped project row.
 * @returns {Object|null}
 */
export function resolveEnvOrThrow(environmentId, project) {
  if (!environmentId) return null;
  const env = environmentRepo.getById(environmentId);
  if (!env || env.projectId !== project.id) {
    const err = new Error("invalid environmentId");
    err.httpStatus = 400;
    throw err;
  }
  return env;
}

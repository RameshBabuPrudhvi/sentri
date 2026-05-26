/**
 * @module aiProvider/agentLoopConstants
 * @description AUTO-023 B3 — leaf constants module for the reviewer↔author
 *   loop, broken out of `agentLoop.js` to avoid a circular import between
 *   the loop runner and `agentConfigRepo`.
 *
 * The loop runner imports `getMaxReviewRounds` from `agentConfigRepo`
 * (workspace-scoped override lookup); the repo's `upsert` clamps writes
 * against `HARD_MAX_REVIEW_ROUNDS`. Putting `HARD_MAX_REVIEW_ROUNDS` on
 * `agentLoop.js` directly created a cycle: `agentLoop → agentConfigRepo
 * → agentLoop`. ES modules tolerate this when both consumers read the
 * cycled binding from inside function bodies (runtime resolution), but
 * a future change that touches either binding at top level (e.g. using
 * the constant as a default-arg in a function declaration that needs
 * the binding evaluated at import time) would trip a TDZ ReferenceError.
 *
 * This module has zero dependencies on either side of the cycle, so
 * `agentLoop.js` and `agentConfigRepo.js` can both import from it
 * without forming a cycle. Industry standard for breaking import
 * cycles between sibling modules.
 */

/**
 * Hard upper bound on `runReviewerAuthorLoop`'s round count. Operators
 * can configure a smaller per-workspace ceiling via
 * `agent_configs.maxReviewRounds`, but no value (caller-supplied or
 * workspace-configured) can exceed this — both `clampReviewRounds` in
 * the loop runner AND `agentConfigRepo.upsert`'s repo-layer clamp
 * import this constant and enforce `[1, HARD_MAX_REVIEW_ROUNDS]`.
 *
 * Bumping the ceiling = edit ONE line here.
 */
export const HARD_MAX_REVIEW_ROUNDS = 10;

/**
 * Default round count when no caller value is supplied AND no
 * per-workspace `agent_configs.maxReviewRounds` override exists.
 * Three rounds is the roadmap-documented Bundle 3 default — enough
 * for one revision + one safety margin, while still bounding cost.
 */
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

/**
 * Wall-clock budget per loop. Pinned to 5 minutes by default so a
 * stuck reviewer or author LLM call can't hold the loop open
 * indefinitely. Hard cap of 30 minutes prevents pathological caller
 * configs from disabling the budget entirely.
 */
export const DEFAULT_LOOP_TIMEOUT_MS = 5 * 60 * 1000;
export const HARD_MAX_LOOP_TIMEOUT_MS = 30 * 60 * 1000;

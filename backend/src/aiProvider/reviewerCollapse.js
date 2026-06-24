/**
 * @module aiProvider/reviewerCollapse
 * @description B3 (AUDIT-ROADMAP Bundle 3) — shared collapse-detection
 * helper used by both the pre-run gate (`crawler.js`) and the in-loop
 * skip path (`runReviewerAuthorLoop`).
 *
 * Collapse means: the `author` and `reviewer` `agent_configs` rows
 * resolve (via `resolveRoute`) to the SAME `provider_routes.id`. In
 * that configuration the loop's two LLM calls are mathematically the
 * same model talking to itself at the same temperature against
 * structurally similar prompts — the reviewer cannot produce
 * independent signal, and the AI-005c warning shipped in
 * `agentLoop.js#maybeWarnSingleAgentCollapse` is advisory only.
 *
 * B3-1 (spec at `docs/roadmap/AUDIT-ROADMAP.md:471-486`) upgrades this
 * to a hard policy decision: when collapse is detected, skip every
 * LLM reviewer call and route through `validateTest` heuristics
 * directly. The audit trail (`agent_messages`) reflects that no
 * independent review occurred — no synthetic envelope rows are
 * emitted, mirroring the SOC 2 / NIST 800-53 principle that an
 * audit log must reflect what happened, not what would have happened.
 *
 * Hoisted from `agentLoop.js`'s in-line check so the pre-run gate in
 * `crawler.js` can run the same probe BEFORE any LLM cost lands.
 *
 * Failure-mode contract: `resolveRoute` may throw on corrupted
 * `agent_configs` / `provider_routes` rows; this helper swallows
 * those errors and returns `{ collapsed: false }`. A DB hiccup must
 * NEVER turn a healthy multi-agent workspace into a collapsed one
 * (industry "fail open on observability" pattern — same contract as
 * `quotaGuard.readSpendCaps` and `recordRunOutcome`).
 *
 * @typedef {Object} CollapseInfo
 * @property {boolean} collapsed - True when author + reviewer share routeId.
 * @property {string|null} routeId - The shared route id (or null on miss/error).
 * @property {string|null} model - The model id on the shared route (best-effort).
 */

import { resolveRoute } from "./registry.js";

/**
 * Probe `agent_configs` for a per-workspace author/reviewer route
 * collapse.
 *
 * @param {string|null} workspaceId
 * @returns {CollapseInfo}
 */
export function detectReviewerCollapse(workspaceId) {
  if (!workspaceId) return { collapsed: false, routeId: null, model: null };
  try {
    const author = resolveRoute({ agentRole: "author", workspaceId });
    const reviewer = resolveRoute({ agentRole: "reviewer", workspaceId });
    const aId = author?.route?.id || null;
    const rId = reviewer?.route?.id || null;
    if (!aId || !rId || aId !== rId) {
      return { collapsed: false, routeId: null, model: null };
    }
    return {
      collapsed: true,
      routeId: aId,
      model: reviewer?.route?.model || author?.route?.model || null,
    };
  } catch {
    // Fail open — see module docblock for rationale.
    return { collapsed: false, routeId: null, model: null };
  }
}

// AI-005: mirrors the canonical user-configurable role list in
// `backend/src/aiProvider/agentHealthCheck.js#AGENT_ROLES`. Frontend can't
// import from backend (no shared package today), so this is a deliberate
// duplicate kept in sync byte-for-byte. Drift between this list and the
// backend validator surfaces as a 400 "Invalid role" from
// `POST /api/v1/settings/agent-roles` — adding a role here without adding
// it to the canonical backend list is rejected at save time.
//
// Removed "executor" from the pre-AI-005 list: no pipeline stage ever
// passed `agentRole: "executor"` to `generateText`, so saving it produced
// a dead row that did nothing. The synthetic `"default"` metric label is
// intentionally not user-configurable (it's a Prometheus catch-all).
export const AGENT_ROLES = ["explorer", "planner", "author", "oracle", "reviewer", "healer", "triager"];

// GAP-005 (audit, fix) — per-pipeline-step agent attribution. The earlier
// hardcoded `STEP_TO_AGENT_ROLE` in CrawlView / GenerateView / TestLab
// (1) only covered 2 of the 7 roles and (2) was WRONG on step 3 — the
// real `backend/src/pipeline/intentClassifier.js#L158` call uses the
// `explorer` role (not `planner`), and `backend/src/pipeline/journeyGenerator.js#L218`
// adds `planner` to the same stage for journey decomposition. Multiple
// roles can run within a single pipeline step.
//
// Source of truth: the `agentRole: "<name>"` argument passed to
// `generateText` / `streamText` at each pipeline call site:
//
//   step 1 (Crawl)         → no LLM agent, pre-LLM Playwright crawl
//   step 2 (Filter)        → no LLM agent, heuristic DOM element filter
//   step 3 (Classify)      → "explorer" (intent classification at
//                            intentClassifier.js:158) +
//                            "planner" (journey decomposition at
//                            journeyGenerator.js:218)
//   step 4 (Generate)      → "author" (codegen at journeyGenerator.js
//                            :186-187, :242, :457)
//   step 5 (Deduplicate)   → "author" (LLM-assisted dedup)
//   step 6 (Enhance)       → "author" (assertion enhancement)
//   step 7 (Validate)      → "author" (validation pass)
//   step 8 (Done)          → terminal marker, no agent
//
// `healer` runs at RUNTIME (selfHealing.js:274, vision.js:186) — not in
// the pipeline stage list, so it doesn't appear in this map. `oracle`,
// `reviewer`, `triager` are declared in AGENT_ROLES but not yet wired to
// any pipeline call site (per the docblock at
// `backend/src/aiProvider/agentHealthCheck.js`), so they don't appear here
// either. Adding them here without a real call site would mis-attribute
// the stage's actual agent.
//
// **Drift contract:** when the backend wires a new `agentRole: "<name>"`
// at a pipeline call site, update this map AND the canonical
// `AGENT_ROLES` list above. The two stay in sync; this map adds the
// step → role(s) layer on top.
//
// Returns `string[]` because step 3 is multi-agent today. CrawlView /
// GenerateView / TestLab all consume the array shape — PipelineCard
// renders one badge per role.
const PIPELINE_STEP_ROLES = {
  3: ["explorer", "planner"],
  4: ["author"],
  5: ["author"],
  6: ["author"],
  7: ["author"],
};

/**
 * Return the AI agent role(s) that run during a given pipeline step.
 *
 * @param {number} step - 1-based pipeline step index (matches `run.currentStep`).
 * @returns {string[]} Zero, one, or more AGENT_ROLES values. Empty array
 *   for pre-LLM (step 1-2) and terminal (step 8) stages.
 */
export function getStageAgentRoles(step) {
  return PIPELINE_STEP_ROLES[step] || [];
}

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

export const ROLES = Object.freeze([
  "explorer", "planner", "author", "reviewer", "oracle", "healer", "triager", "supervisor", "default",
]);

export const INTENTS = Object.freeze([
  "handoff", "request_revision", "accept", "reject", "question", "answer", "final", "tool_call", "tool_result", "reject_final",
]);

const ROLE_SET = new Set(ROLES);
const INTENT_SET = new Set(INTENTS);

export function validateEnvelope(msg) {
  const issues = [];
  const m = msg || {};
  const reqStr = ["id", "runId", "threadId", "traceId", "fromRole", "intent", "workspaceId", "createdAt"];
  for (const k of reqStr) if (!m[k] || typeof m[k] !== "string") issues.push(k);
  if (m.toRole != null && !ROLE_SET.has(m.toRole)) issues.push("toRole");
  if (!ROLE_SET.has(m.fromRole)) issues.push("fromRole");
  if (!INTENT_SET.has(m.intent)) issues.push("intent");
  if (m.round != null && (!Number.isInteger(m.round) || m.round < 0)) issues.push("round");
  if (m.createdAt && Number.isNaN(Date.parse(m.createdAt))) issues.push("createdAt");
  if (issues.length) {
    const err = new Error(`Invalid agent envelope: ${issues.join(", ")}`);
    err.code = "ERR_AGENT_ENVELOPE_INVALID";
    err.issues = issues;
    throw err;
  }
  return { ...m, round: m.round ?? 0, toRole: m.toRole ?? null, replyToId: m.replyToId ?? null, artifact: m.artifact ?? null, rationale: m.rationale ?? null };
}

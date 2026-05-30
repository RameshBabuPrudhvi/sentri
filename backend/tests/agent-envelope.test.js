import assert from "node:assert/strict";
import { validateEnvelope, INTENTS, ROLES } from "../src/aiProvider/agentEnvelope.js";

const msg = validateEnvelope({ id:"m1", runId:"r1", threadId:"t1", traceId:"tr1", fromRole:"author", intent:"handoff", workspaceId:"w1", createdAt:new Date().toISOString() });
assert.equal(msg.id, "m1");
assert.ok(ROLES.includes("supervisor"));
assert.ok(INTENTS.includes("request_revision"));
assert.throws(() => validateEnvelope({ runId:"r1" }), /ERR_AGENT_ENVELOPE_INVALID|Invalid agent envelope/);

// Bundle-A fix #4 — pin that the Zod `fromRole`/`toRole` enum actually
// accepts `supervisor` (not just that the closed-set list exports it).
// AUTO-023 Bundle 4 added `supervisor` to `ROLES`; without this
// regression assertion a future refactor that swaps `z.enum(ROLES)` for
// a hand-written enum could silently drop `supervisor` from the schema
// while the list export still includes it, and the orchestrator's
// supervisor→nextRole handoff envelope would 500 on validation.
const supervisorOut = validateEnvelope({
  id: "m-sup-1",
  runId: "r-sup",
  threadId: "t-sup",
  traceId: "tr-sup",
  fromRole: "supervisor",
  toRole: "author",
  intent: "handoff",
  artifact: { instruction: "go" },
  workspaceId: "w-sup",
  createdAt: new Date().toISOString(),
});
assert.equal(supervisorOut.fromRole, "supervisor");
assert.equal(supervisorOut.toRole, "author");
assert.equal(supervisorOut.intent, "handoff");

// Negative-path counterpart: a role outside the closed set MUST throw.
// Without this guard, a regression that broadened `z.enum(ROLES)` to
// `z.string()` could silently accept hallucinated supervisor outputs
// (`"debugger"`, `"analyzer"`, typos).
assert.throws(() => validateEnvelope({
  id: "m-bad",
  runId: "r-bad",
  threadId: "t-bad",
  traceId: "tr-bad",
  fromRole: "analyzer", // not in ROLES
  intent: "handoff",
  workspaceId: "w-bad",
  createdAt: new Date().toISOString(),
}), /ERR_AGENT_ENVELOPE_INVALID|Invalid agent envelope/);

console.log("✅ agent-envelope.test passed");

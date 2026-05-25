import assert from "node:assert/strict";
import { validateEnvelope, INTENTS, ROLES } from "../src/aiProvider/agentEnvelope.js";

const msg = validateEnvelope({ id:"m1", runId:"r1", threadId:"t1", traceId:"tr1", fromRole:"author", intent:"handoff", workspaceId:"w1", createdAt:new Date().toISOString() });
assert.equal(msg.id, "m1");
assert.ok(ROLES.includes("supervisor"));
assert.ok(INTENTS.includes("request_revision"));
assert.throws(() => validateEnvelope({ runId:"r1" }), /ERR_AGENT_ENVELOPE_INVALID|Invalid agent envelope/);
console.log("✅ agent-envelope.test passed");

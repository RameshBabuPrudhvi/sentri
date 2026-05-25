import assert from "node:assert/strict";
import { runListeners } from "../src/routes/sse.js";
import { emitAgentMessage } from "../src/aiProvider/agentEventEmitter.js";
import * as repo from "../src/database/repositories/agentMessageRepo.js";

const runId = "r-emitter";
const ws = "w-emitter";
const chunks = [];
const fakeRes = { write: (c) => chunks.push(c) };
if (!runListeners.has(runId)) runListeners.set(runId, new Set());
runListeners.get(runId).add(fakeRes);

const row = emitAgentMessage({runId,threadId:"t-em",traceId:"tr-em",fromRole:"planner",toRole:"author",intent:"handoff",artifact:{x:1},workspaceId:ws});
assert.ok(row.id);
assert.equal(chunks.length,1);
const payload = JSON.parse(chunks[0].slice("data: ".length).trim());
assert.equal(payload.type,"agent_message");
assert.equal(payload.intent,"handoff");
assert.equal(repo.listByRun(runId,ws).length,1);

runListeners.get(runId)?.delete(fakeRes);
repo.purgeOlderThan(36500);
console.log("✅ agent-message-emitter.test passed");

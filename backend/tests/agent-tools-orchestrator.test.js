import assert from "node:assert/strict";
import test from "node:test";
import { runAutonomousThread } from "../src/aiProvider/agentOrchestrator.js";

test("orchestrator executes tool_call and appends tool_result", async () => {
  const out = await runAutonomousThread({ artifact: {} }, {
    workspaceId: null,
    runId: "r1",
    supervisorDecision: async ({ step }) => {
      if (step === 0) return { nextRole: "author", instruction: "tool" };
      return { terminate: true, finalArtifact: { done: true } };
    },
    runAgent: async () => ({
      id: "msg-1",
      fromRole: "author",
      intent: "tool_call",
      artifact: { tool: "playwright.dryRun", args: { testCode: "test('x', async()=>{})" } },
    }),
  });
  assert.equal(out.outcome, "terminate");
  assert.deepEqual(out.artifact, { done: true });
});

test("orchestrator records tool_result error when tool is forbidden", async () => {
  const out = await runAutonomousThread({ artifact: {} }, {
    workspaceId: null,
    runId: "r2",
    maxSteps: 2,
    supervisorDecision: async ({ step, thread }) => {
      if (step === 0) return { nextRole: "author", instruction: "tool" };
      return { terminate: true, finalArtifact: thread[thread.length - 1]?.artifact || null };
    },
    runAgent: async () => ({
      id: "msg-2",
      fromRole: "author",
      intent: "tool_call",
      artifact: { tool: "db.getTest", args: { testId: "t-1" } },
    }),
  });
  assert.equal(out.outcome, "terminate");
  assert.equal(out.artifact.tool, "db.getTest");
  assert.equal(out.artifact.code, "ERR_AGENT_TOOL_FORBIDDEN");
});

import test from "node:test";
import assert from "node:assert/strict";
import { runAutonomousThread } from "../src/aiProvider/agentOrchestrator.js";

test("autonomous happy path terminates from supervisor", async () => {
  const roles = ["explorer", "planner", "author", "reviewer"];
  let i = 0;
  const out = await runAutonomousThread({ artifact: { tests: [] } }, {
    workspaceId: null,
    supervisorDecision: async () => (i >= roles.length
      ? { terminate: true, finalArtifact: { ok: true } }
      : { nextRole: roles[i++], instruction: "go" }),
    runAgent: async ({ role }) => ({ fromRole: role, intent: "handoff", artifact: { role } }),
  });
  assert.equal(out.outcome, "terminate");
  assert.deepEqual(out.artifact, { ok: true });
});

test("enforces max steps", async () => {
  const out = await runAutonomousThread({ artifact: null }, {
    workspaceId: null,
    maxSteps: 2,
    supervisorDecision: async () => ({ nextRole: "author", instruction: "again" }),
    runAgent: async () => ({ fromRole: "author", intent: "handoff", artifact: null }),
  });
  assert.equal(out.outcome, "max_steps");
});

test("ineligible role triggers fallback callback", async () => {
  const out = await runAutonomousThread({ artifact: { seed: true } }, {
    workspaceId: "ws-missing",
    supervisorDecision: async () => ({ nextRole: "oracle", instruction: "x" }),
    runAgent: async () => ({ fromRole: "oracle", intent: "handoff", artifact: { ok: true } }),
    runLinearFallback: async ({ reason, nextRole, lastArtifact }) => ({ outcome: "fallback_linear", reason, nextRole, artifact: lastArtifact }),
  });
  assert.equal(out.outcome, "fallback_linear");
  assert.equal(out.reason, "ineligible_role");
  assert.equal(out.nextRole, "oracle");
  assert.deepEqual(out.artifact, { seed: true });
});

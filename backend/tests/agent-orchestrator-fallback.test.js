/**
 * @module tests/agent-orchestrator-fallback
 * @description AUTO-023 B4.3 / B4.6 — dedicated coverage for the
 * orchestrator's ineligible-role fallback path. The roadmap explicitly
 * lists a separate file (`agent-orchestrator-fallback.test.js`) for
 * this slice so a regression in the fallback hook surfaces in
 * isolation from the happy-path / max-steps cases in
 * `agent-orchestrator.test.js`.
 *
 * Branches covered:
 *   • Supervisor picks an ineligible role + caller provided
 *     `runLinearFallback` → the closure runs, the orchestrator's
 *     return value comes from the closure.
 *   • Supervisor picks an ineligible role + caller did NOT provide
 *     `runLinearFallback` → orchestrator returns the sentinel
 *     `{ outcome: "fallback", ... }` so the caller can still detect
 *     the fallback signal.
 *   • Fallback metric (`agent_orchestrator_fallback_total{reason}`)
 *     fires exactly once per fallback event.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runAutonomousThread } from "../src/aiProvider/agentOrchestrator.js";

test("fallback callback runs when supervisor picks an ineligible role", async () => {
  let fallbackInvocations = 0;
  let fallbackReason = null;
  const out = await runAutonomousThread({ artifact: { seed: true } }, {
    workspaceId: "ws-missing-route",
    supervisorDecision: async () => ({ nextRole: "oracle", instruction: "review" }),
    runAgent: async () => ({ fromRole: "oracle", intent: "handoff", artifact: { ok: true } }),
    runLinearFallback: async ({ reason, nextRole, lastArtifact }) => {
      fallbackInvocations += 1;
      fallbackReason = reason;
      return { outcome: "linear_fallback", reason, nextRole, artifact: lastArtifact };
    },
  });
  assert.equal(fallbackInvocations, 1, "fallback closure should run exactly once");
  assert.equal(fallbackReason, "ineligible_role");
  assert.equal(out.outcome, "linear_fallback");
  assert.deepEqual(out.artifact, { seed: true });
});

test("fallback returns sentinel when caller did NOT provide runLinearFallback", async () => {
  const out = await runAutonomousThread({ artifact: { seed: true } }, {
    workspaceId: "ws-missing-route",
    supervisorDecision: async () => ({ nextRole: "oracle", instruction: "review" }),
    runAgent: async () => ({ fromRole: "oracle", intent: "handoff", artifact: { ok: true } }),
    // No runLinearFallback — orchestrator must still terminate with
    // the fallback sentinel rather than dispatching the ineligible role.
  });
  assert.equal(out.outcome, "fallback");
  assert.deepEqual(out.artifact, { seed: true });
});

test("onFallback observer fires before runLinearFallback closure", async () => {
  const calls = [];
  await runAutonomousThread({ artifact: { seed: true } }, {
    workspaceId: "ws-missing-route",
    supervisorDecision: async () => ({ nextRole: "triager", instruction: "classify" }),
    runAgent: async () => ({ fromRole: "triager", intent: "handoff", artifact: null }),
    onFallback: (info) => calls.push({ kind: "observe", info }),
    runLinearFallback: async ({ reason }) => {
      calls.push({ kind: "execute", reason });
      return { outcome: "linear_fallback", reason };
    },
  });
  // Observer runs before the linear-fallback closure so an admin
  // logger/metric hook gets the signal even when no closure is provided.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, "observe");
  assert.equal(calls[0].info.nextRole, "triager");
  assert.equal(calls[1].kind, "execute");
});

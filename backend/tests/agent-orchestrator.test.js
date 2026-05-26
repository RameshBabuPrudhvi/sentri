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

// AUTO-023 B4.6 — supervisor loops author when reviewer requests revision.
// Pins the orchestrator's ability to route the same role multiple times
// in a single thread (the loop-vs-DAG distinction): supervisor sees a
// reviewer revision verdict and re-routes back to `author` before
// finally terminating. Without this coverage the happy-path test (which
// walks a hard-coded role array) would mask a regression where the
// supervisor's nextRole gets stuck on the first request.
test("supervisor can loop author when reviewer requests revision", async () => {
  const decisions = [
    { nextRole: "author", instruction: "draft" },
    { nextRole: "reviewer", instruction: "review" },
    { nextRole: "author", instruction: "revise" },
    { nextRole: "reviewer", instruction: "review again" },
    { terminate: true, finalArtifact: { ok: true, revisions: 1 } },
  ];
  let i = 0;
  const out = await runAutonomousThread({ artifact: { tests: [] } }, {
    workspaceId: null,
    supervisorDecision: async () => decisions[i++],
    runAgent: async ({ role }) => ({ fromRole: role, intent: "handoff", artifact: { role } }),
  });
  assert.equal(out.outcome, "terminate");
  assert.deepEqual(out.artifact, { ok: true, revisions: 1 });
  // 4 runAgent invocations consumed (author, reviewer, author, reviewer)
  // before the terminate decision.
  assert.equal(out.steps, 4);
});

// AUTO-023 B4.2 — built-in `checkQuota` callback short-circuits the
// thread via the new `outcome: "quota_exhausted"` terminal path.
// Pins that the orchestrator HONOURS an injected `checkQuota` arg
// (production wires this to `quotaGuard.evaluateSpendCap`) and that
// the quota check fires BEFORE the supervisor LLM call so a capped
// workspace doesn't burn a supervisor dispatch.
test("injected checkQuota terminates thread with quota_exhausted outcome", async () => {
  let supervisorCalls = 0;
  const out = await runAutonomousThread({ artifact: { seed: true } }, {
    workspaceId: null,
    checkQuota: ({ step }) => (step >= 1 ? { ok: false, reason: "spend_cap_day" } : { ok: true }),
    supervisorDecision: async () => {
      supervisorCalls += 1;
      return { nextRole: "author", instruction: "go" };
    },
    runAgent: async () => ({ fromRole: "author", intent: "handoff", artifact: { ok: true } }),
  });
  assert.equal(out.outcome, "quota_exhausted");
  assert.equal(out.reason, "spend_cap_day");
  // Round 0's supervisor call ran (quota OK); round 1's did NOT (quota
  // gate fired BEFORE supervisor dispatch).
  assert.equal(supervisorCalls, 1);
});

// AUTO-023 B4.2 — caller-injected quota gate short-circuits the thread.
// The orchestrator surface exposes the supervisorDecision callback as
// the gate point (a caller can return `{ terminate: true, rationale:
// "quota_exhausted" }` once their pre-call quota check fails). This
// regression test pins that contract so a future refactor that swaps
// in a dedicated `checkQuota` arg doesn't silently break the
// caller-side enforcement path that ships today.
test("caller-side quota gate terminates thread mid-flight", async () => {
  let agentCalls = 0;
  const out = await runAutonomousThread({ artifact: { seed: true } }, {
    workspaceId: null,
    supervisorDecision: async ({ step }) => {
      if (step >= 2) return { terminate: true, finalArtifact: { reason: "quota_exhausted" }, rationale: "quota_exhausted" };
      return { nextRole: "author", instruction: "go" };
    },
    runAgent: async () => {
      agentCalls += 1;
      return { fromRole: "author", intent: "handoff", artifact: { agentCalls } };
    },
  });
  assert.equal(out.outcome, "terminate");
  assert.equal(agentCalls, 2);
  assert.deepEqual(out.artifact, { reason: "quota_exhausted" });
});

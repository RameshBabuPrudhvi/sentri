/**
 * Bundle-A fix #1 — orchestrator threads `replyToId` across supervisor
 * handoffs. Pins that every envelope emitted by `runAutonomousThread`
 * (supervisor handoff, tool_call, tool_result) carries `replyToId`
 * pointing at the previous orchestrator-emitted envelope, so the UI
 * timeline can reconstruct the multi-step thread as a connected chain.
 *
 * Pre-fix every supervisor handoff persisted `replyToId: null`, leaving
 * the frontend to render each step as an orphan root.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

// `roleEligible(workspaceId, role)` in `agentOrchestrator.js` calls
// `resolveRoute({ workspaceId, agentRole })` whenever workspaceId is
// non-null. With an empty in-memory DB (no `provider_routes` rows and
// no `agent_configs` rows), the resolver falls through to
// `detectProvider()` — which returns `null` when no provider env key
// is set, so the resolved route is `null` and every nextRole gets
// rejected as ineligible. The orchestrator then falls into the
// linear-fallback path WITHOUT emitting any handoff envelopes, which
// is what made the pre-fix run report `expected 3 ..., got 0`.
//
// Seeding a placeholder env key BEFORE importing the registry makes
// `detectProvider()` synthesise a transient route, so `roleEligible`
// returns true for the canonical dispatchable roles and the
// orchestrator emits the envelopes this test is pinning. The
// orchestrator never actually dispatches to the real provider —
// `runAgent` is a fully synchronous stub.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-test-placeholder-for-role-eligibility-only";

const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();

const { runAutonomousThread } = await import("../src/aiProvider/agentOrchestrator.js");
const agentMessageRepo = await import("../src/database/repositories/agentMessageRepo.js");

const WS = "__default__";

function mkRunId() {
  return `RUN-RC-${Math.random().toString(36).slice(2, 10)}`;
}

test("supervisor handoffs thread replyToId across multi-step thread", async () => {
  const runId = mkRunId();
  const threadId = `${runId}-main`;
  const roles = ["explorer", "planner", "author"];
  let i = 0;

  await runAutonomousThread({ artifact: { tests: [] } }, {
    runId,
    threadId,
    workspaceId: WS,
    supervisorDecision: async () => (i >= roles.length
      ? { terminate: true, finalArtifact: { ok: true } }
      : { nextRole: roles[i++], instruction: "go" }),
    runAgent: async ({ role }) => ({ fromRole: role, intent: "handoff", artifact: { role } }),
  });

  // Only the orchestrator-emitted handoff envelopes (one per step) land
  // in the repo — `runAgent` is a stub that doesn't emit.
  const rows = agentMessageRepo.listByRun(runId, WS);
  assert.equal(rows.length, 3, `expected 3 supervisor handoff envelopes, got ${rows.length}`);

  // First handoff has no predecessor — replyToId must be null.
  assert.equal(rows[0].replyToId, null, "first handoff is the chain root");
  // Every subsequent handoff must thread `replyToId` to the prior row's id.
  for (let n = 1; n < rows.length; n += 1) {
    assert.equal(
      rows[n].replyToId,
      rows[n - 1].id,
      `handoff #${n} must replyToId the previous handoff (#${n - 1})`,
    );
  }
});

test("tool_call + tool_result envelopes participate in the replyToId chain", async () => {
  const runId = mkRunId();
  const threadId = `${runId}-main`;

  // Two-step thread: author emits a tool_call, then supervisor terminates.
  // The orchestrator should emit:
  //   1. supervisor → author handoff       (replyToId: null)
  //   2. author tool_call                  (replyToId: handoff #1)
  //   3. author tool_result                (replyToId: tool_call #2)
  const decisions = [
    { nextRole: "author", instruction: "go" },
    { terminate: true, finalArtifact: { ok: true } },
  ];
  let n = 0;

  await runAutonomousThread({ artifact: { tests: [] } }, {
    runId,
    threadId,
    workspaceId: WS,
    supervisorDecision: async () => decisions[n++],
    runAgent: async ({ role }) => ({
      fromRole: role,
      intent: "tool_call",
      artifact: { tool: "db.listExistingTests", args: {} },
    }),
  });

  const rows = agentMessageRepo.listByRun(runId, WS);
  assert.equal(rows.length, 3, `expected handoff + tool_call + tool_result, got ${rows.length}`);
  assert.equal(rows[0].intent, "handoff");
  assert.equal(rows[1].intent, "tool_call");
  assert.equal(rows[2].intent, "tool_result");

  // Chain: each row's replyToId points at the previous row's id.
  assert.equal(rows[0].replyToId, null, "handoff is the chain root");
  assert.equal(rows[1].replyToId, rows[0].id, "tool_call threads to the supervisor handoff");
  assert.equal(rows[2].replyToId, rows[1].id, "tool_result threads to its tool_call");
});

console.log("✅ agent-orchestrator-reply-chain tests passed");

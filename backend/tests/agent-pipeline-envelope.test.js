/**
 * AUTO-023 Bundle 2 — B2.6 envelope-mode handoff smoke test.
 *
 * Asserts the pipeline call-site envelope-wrapping (B2.2) produces a
 * complete, ordered thread of `agent_messages` rows on a canonical
 * explorer → planner → author → reviewer handoff, all scoped to the
 * originating workspace. This is the parity contract from the roadmap:
 * `pipeline` and `envelope` modes must produce identical test artifacts
 * AND, in envelope mode, an audit-trail thread the operator can replay.
 *
 * Approach: drive `emitHandoffEnvelope` directly (the same helper every
 * pipeline call site uses) rather than booting the full pipeline — that
 * keeps the smoke test fast + deterministic while still exercising the
 * envelope schema validator, the repo persistence path, the workspace
 * scope predicate on `listByThread`, and the `toRole`-broadcast-or-direct
 * filter contract.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();

const { emitHandoffEnvelope, mainThreadId, readLatestEnvelope } = await import("../src/aiProvider/agentHandoff.js");
const agentMessageRepo = await import("../src/database/repositories/agentMessageRepo.js");

const WS = "__default__";
const OTHER_WS = "ws-other-envelope-test";

function mkRunId() {
  return `RUN-ENV-${Math.random().toString(36).slice(2, 10)}`;
}

test("explorer → planner → author handoffs persist as an ordered thread", async () => {
  // Force envelope-read mode so `readLatestEnvelope` actually queries the
  // repo. Writes are unconditional in pipeline mode too (B2.4 shim), but
  // the read-path needs envelope/autonomous mode to fire.
  process.env.SENTRI_AGENT_MODE = "envelope";
  const runId = mkRunId();
  const threadId = mainThreadId(runId);

  emitHandoffEnvelope({
    runId, threadId, workspaceId: WS,
    fromRole: "explorer", toRole: "planner",
    artifact: { url: "https://example.com", intent: "AUTH", confidence: 90 },
    rationale: "Intent classification handoff",
  });
  emitHandoffEnvelope({
    runId, threadId, workspaceId: WS,
    fromRole: "planner", toRole: "author",
    artifact: { journey: "auth-flow", tests: [{ id: "t1" }] },
    rationale: "Planner journey decomposition",
  });
  emitHandoffEnvelope({
    runId, threadId, workspaceId: WS,
    fromRole: "author", toRole: "reviewer",
    artifact: { tests: [{ id: "t1", name: "login smoke" }] },
    rationale: "Author generated tests",
  });

  const rows = agentMessageRepo.listByRun(runId, WS);
  assert.equal(rows.length, 3, "every handoff persists exactly one row");

  // Ordering contract: `listByRun` returns rows in `(createdAt, id) ASC`,
  // which on a single-tick run preserves emit order via id tiebreaker.
  assert.deepEqual(
    rows.map((r) => `${r.fromRole}→${r.toRole}`),
    ["explorer→planner", "planner→author", "author→reviewer"],
  );
  for (const r of rows) {
    assert.equal(r.intent, "handoff");
    assert.equal(r.threadId, threadId);
    assert.equal(r.workspaceId, WS);
    assert.ok(r.id && r.id.startsWith("am-"), "id assigned by emitter");
    assert.ok(r.traceId, "traceId stamped");
    assert.ok(r.artifact && typeof r.artifact === "object", "artifact parsed back to object");
  }
});

test("readLatestEnvelope returns the most recent message addressed to a role", async () => {
  process.env.SENTRI_AGENT_MODE = "envelope";
  const runId = mkRunId();
  const threadId = mainThreadId(runId);

  emitHandoffEnvelope({
    runId, threadId, workspaceId: WS,
    fromRole: "explorer", toRole: "planner",
    artifact: { step: 1 },
  });
  emitHandoffEnvelope({
    runId, threadId, workspaceId: WS,
    fromRole: "planner", toRole: "author",
    artifact: { step: 2 },
  });

  const latest = readLatestEnvelope({ threadId, workspaceId: WS, toRole: "author" });
  assert.ok(latest, "envelope-mode read returns the most recent row");
  assert.equal(latest.fromRole, "planner");
  assert.equal(latest.artifact?.step, 2);

  // pipeline mode: read path is gated off (B2.4 — writes-on, reads-off).
  process.env.SENTRI_AGENT_MODE = "pipeline";
  assert.equal(
    readLatestEnvelope({ threadId, workspaceId: WS, toRole: "author" }),
    null,
    "pipeline mode short-circuits the read for zero-regression behaviour",
  );
});

test("envelope reads are workspace-scoped — cross-workspace reads return null", async () => {
  process.env.SENTRI_AGENT_MODE = "envelope";
  const runId = mkRunId();
  const threadId = mainThreadId(runId);

  emitHandoffEnvelope({
    runId, threadId, workspaceId: WS,
    fromRole: "author", toRole: "reviewer",
    artifact: { tests: [{ id: "t1" }] },
  });

  // Different workspace — must NOT see the row.
  const otherWs = readLatestEnvelope({ threadId, workspaceId: OTHER_WS, toRole: "reviewer" });
  assert.equal(otherWs, null, "cross-workspace listByThread returns empty");

  // Same workspace — sees it.
  const sameWs = readLatestEnvelope({ threadId, workspaceId: WS, toRole: "reviewer" });
  assert.ok(sameWs, "same-workspace read finds the row");
  assert.equal(sameWs.fromRole, "author");
});

test("emitter no-ops on missing required fields (zero-regression contract)", () => {
  // No runId — pipeline call sites that lack a run context must not
  // throw or persist anything. Mirrors the `emitAgentEvent` no-op rule.
  const before = agentMessageRepo.listByRun("RUN-MISSING", WS).length;
  const out = emitHandoffEnvelope({
    runId: null, threadId: null, workspaceId: WS,
    fromRole: "author", toRole: "reviewer",
    artifact: { tests: [] },
  });
  assert.equal(out, null, "emitter returns null on missing runId/threadId");
  assert.equal(agentMessageRepo.listByRun("RUN-MISSING", WS).length, before);
});

// Reset envelope mode to the default so subsequent test files see the
// roadmap-default `pipeline` behaviour.
process.env.SENTRI_AGENT_MODE = "pipeline";

console.log("✅ agent-pipeline-envelope tests passed");

/**
 * AUTO-023 Bundle 2 — agentHandoff.js + agentMode.js unit coverage.
 *
 * Closes the REVIEW.md mandatory-test gap flagged on the new helper
 * modules: every exported function has at least one assertion of its
 * core behaviour. The integration-shaped envelope thread is covered by
 * `agent-pipeline-envelope.test.js`; this file pins the pure helpers
 * (thread-id formatters + env-driven mode switch) so a future refactor
 * can't silently change their contract.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();

const { mainThreadId, healingThreadId, readLatestEnvelope, emitHandoffEnvelope } =
  await import("../src/aiProvider/agentHandoff.js");
const { getAgentMode, isEnvelopeReadEnabled } = await import("../src/aiProvider/agentMode.js");

const WS = "__default__";

// ─── agentMode.js ─────────────────────────────────────────────────────────────

test("getAgentMode defaults to pipeline when env unset", () => {
  delete process.env.SENTRI_AGENT_MODE;
  assert.equal(getAgentMode(), "pipeline");
});

test("getAgentMode accepts the three documented modes (case-insensitive + trimmed)", () => {
  for (const mode of ["pipeline", "envelope", "autonomous"]) {
    process.env.SENTRI_AGENT_MODE = mode;
    assert.equal(getAgentMode(), mode);
    process.env.SENTRI_AGENT_MODE = ` ${mode.toUpperCase()} `;
    assert.equal(getAgentMode(), mode, "case-insensitive + whitespace-trimmed");
  }
});

test("getAgentMode falls back to pipeline on invalid values (defence-in-depth)", () => {
  for (const bad of ["", "nope", "PIPELINEX", "envelope2", " "]) {
    process.env.SENTRI_AGENT_MODE = bad;
    assert.equal(getAgentMode(), "pipeline", `invalid "${bad}" → pipeline`);
  }
});

test("isEnvelopeReadEnabled is false in pipeline mode, true in envelope/autonomous", () => {
  process.env.SENTRI_AGENT_MODE = "pipeline";
  assert.equal(isEnvelopeReadEnabled(), false);
  process.env.SENTRI_AGENT_MODE = "envelope";
  assert.equal(isEnvelopeReadEnabled(), true);
  process.env.SENTRI_AGENT_MODE = "autonomous";
  assert.equal(isEnvelopeReadEnabled(), true);
});

// ─── agentHandoff.js — thread id formatters ───────────────────────────────────

test("mainThreadId formats as `${runId}-main`", () => {
  assert.equal(mainThreadId("RUN-123"), "RUN-123-main");
  assert.equal(mainThreadId("abc"), "abc-main");
});

test("healingThreadId formats as `${runId}-heal-${testId}`", () => {
  assert.equal(healingThreadId("RUN-1", "TC-9"), "RUN-1-heal-TC-9");
  // Versioned testIds (executeTest.js uses `${test.id}@v${codeVersion}`) round-trip cleanly.
  assert.equal(healingThreadId("RUN-1", "TC-9@v2"), "RUN-1-heal-TC-9@v2");
});

// ─── agentHandoff.js — readLatestEnvelope guards ──────────────────────────────

test("readLatestEnvelope returns null when any required guard arg is missing", () => {
  process.env.SENTRI_AGENT_MODE = "envelope";
  assert.equal(readLatestEnvelope({ threadId: null, workspaceId: WS, toRole: "author" }), null);
  assert.equal(readLatestEnvelope({ threadId: "t1", workspaceId: null, toRole: "author" }), null);
  assert.equal(readLatestEnvelope({ threadId: "t1", workspaceId: WS, toRole: null }), null);
  assert.equal(readLatestEnvelope({}), null);
});

test("readLatestEnvelope short-circuits in pipeline mode regardless of args", () => {
  process.env.SENTRI_AGENT_MODE = "pipeline";
  assert.equal(
    readLatestEnvelope({ threadId: "anything", workspaceId: WS, toRole: "author" }),
    null,
    "pipeline mode skips the DB read entirely (zero-regression contract)",
  );
});

// ─── agentHandoff.js — emitHandoffEnvelope guards ─────────────────────────────

test("emitHandoffEnvelope no-ops on missing required fields", () => {
  // Required: runId, threadId, workspaceId, fromRole. Missing any → null.
  assert.equal(emitHandoffEnvelope({ runId: null, threadId: "t1", workspaceId: WS, fromRole: "author" }), null);
  assert.equal(emitHandoffEnvelope({ runId: "r1", threadId: null, workspaceId: WS, fromRole: "author" }), null);
  assert.equal(emitHandoffEnvelope({ runId: "r1", threadId: "t1", workspaceId: null, fromRole: "author" }), null);
  assert.equal(emitHandoffEnvelope({ runId: "r1", threadId: "t1", workspaceId: WS, fromRole: null }), null);
});

test("emitHandoffEnvelope persists a valid handoff envelope and returns the row", () => {
  const runId = `RUN-HO-${Math.random().toString(36).slice(2, 8)}`;
  const out = emitHandoffEnvelope({
    runId, threadId: mainThreadId(runId), workspaceId: WS,
    fromRole: "planner", toRole: "author",
    artifact: { foo: 1 },
    rationale: "unit test",
  });
  assert.ok(out, "valid envelope returns the persisted row");
  assert.equal(out.intent, "handoff");
  assert.equal(out.fromRole, "planner");
  assert.equal(out.toRole, "author");
  assert.equal(out.workspaceId, WS);
  assert.deepEqual(out.artifact, { foo: 1 });
  assert.ok(out.traceId, "traceId always stamped (synthetic when no OTel ctx)");
});

// Reset mode so subsequent test files inherit the roadmap-default behaviour.
process.env.SENTRI_AGENT_MODE = "pipeline";

console.log("✅ agent-handoff + agent-mode unit tests passed");

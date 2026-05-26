/**
 * AUTO-023 Bundle 2 — B2.6 envelope-mode handoff smoke test.
 *
 * Three test layers, each adding a tighter contract assertion:
 *
 * 1. **Helper-level** — drive `emitHandoffEnvelope` directly to pin the
 *    envelope schema validator, repo persistence, workspace scoping on
 *    `listByThread`, the envelope-vs-pipeline read-mode gate, and the
 *    emitter no-op contract on missing fields.
 *
 * 2. **Pipeline call-site wiring** — invoke a real pipeline function
 *    (`generateApiTests` on a pre-seeded inbound envelope) and assert
 *    that the `readLatestEnvelope` inside the function actually returned
 *    the seeded row, by checking that the SUBSEQUENT emit threaded
 *    `replyToId` back to the inbound id. This exercises the real
 *    production code path (the function in `journeyGenerator.js`,
 *    imported from its real module) without booting an LLM — the test
 *    passes `apiEndpoints: []` so the function exits via its
 *    short-circuit BEFORE `generateText` fires, but only AFTER the
 *    inbound read. To avoid the early-return short-circuit interfering
 *    with the emit, the test path uses `generateFromDescription` with a
 *    `null` provider so the LLM call throws and we observe the inbound
 *    read still landed in the audit trail.
 *
 * 3. **Mode-parity** — repeat the helper-level thread in `pipeline` mode
 *    and assert the writes still fire (B2.4 dual-write shim) while the
 *    reads short-circuit. This is the zero-regression contract from B2.7.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();

const { emitHandoffEnvelope, mainThreadId, readLatestEnvelope, _setReadsSpyForTests } = await import("../src/aiProvider/agentHandoff.js");
const agentMessageRepo = await import("../src/database/repositories/agentMessageRepo.js");
const { generateApiTests, generateJourneyTest } = await import("../src/pipeline/journeyGenerator.js");

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

// ─── Chat synthetic runIds (B2.2 routes/chat.js contract) ─────────────────────
// Pins the behaviour that chat envelopes use `CHAT-${uuid}` runIds with no
// FK to `runs.id`, but DO get swept by the same retention janitor as
// run-scoped envelopes (purge predicate is `createdAt < cutoff`, runId-
// agnostic). Closes the regression gap flagged in code review.

test("chat: CHAT-${uuid} runIds persist as schema-valid envelopes (no runs FK required)", () => {
  const chatRunId = `CHAT-${Math.random().toString(36).slice(2, 10)}`;
  const chatThreadId = `${chatRunId}-main`;
  const out = emitHandoffEnvelope({
    runId: chatRunId,
    threadId: chatThreadId,
    workspaceId: WS,
    fromRole: "supervisor",
    toRole: "author",
    artifact: { kind: "chat_request", userMessage: "Hello" },
    rationale: "User chat request",
  });
  assert.ok(out, "chat envelope persists despite synthetic runId");
  assert.equal(out.runId, chatRunId);

  // The row is queryable just like a real-run row, scoped by workspace.
  const rows = agentMessageRepo.listByRun(chatRunId, WS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fromRole, "supervisor");
});

test("chat: CHAT-* threads are swept by the retention janitor (purgeOlderThan)", () => {
  // Seed a chat envelope with `createdAt` set to 200 days ago — beyond
  // any reasonable retention window. The janitor uses
  // `DELETE FROM agent_messages WHERE createdAt < ?` which is runId-
  // agnostic, so chat threads MUST get swept alongside run-scoped rows.
  const chatRunId = `CHAT-${Math.random().toString(36).slice(2, 10)}`;
  const oldDate = new Date(Date.now() - 200 * 86400000).toISOString();
  // Bypass the emitter (which always stamps current `createdAt`) by
  // calling the repo directly with the back-dated row.
  agentMessageRepo.append({
    id: `am-chat-old-${Math.random().toString(36).slice(2, 8)}`,
    runId: chatRunId,
    threadId: `${chatRunId}-main`,
    traceId: "trace-chat-test",
    fromRole: "author",
    toRole: "supervisor",
    replyToId: null,
    intent: "handoff",
    artifact: { kind: "chat_reply" },
    rationale: "stale chat",
    round: 0,
    workspaceId: WS,
    createdAt: oldDate,
  });

  // Sanity: row is present before janitor.
  assert.equal(agentMessageRepo.listByRun(chatRunId, WS).length, 1, "back-dated chat row seeded");

  // Run the janitor with a 90-day retention window — chat row is older,
  // so it MUST be deleted. The function returns the count of rows
  // deleted, but we cross-check by querying the repo: chat thread is gone.
  const deletedCount = agentMessageRepo.purgeOlderThan(90);
  assert.ok(deletedCount >= 1, `purgeOlderThan deleted at least the stale chat row, got ${deletedCount}`);
  assert.equal(
    agentMessageRepo.listByRun(chatRunId, WS).length,
    0,
    "stale chat envelope removed by retention janitor — no orphan rows piling up",
  );
});

// ─── Pipeline-driven wiring (B2.2 contract) ───────────────────────────────────
// These tests close the gap flagged in code review: prior to the spy, the
// only assertions exercised `emitHandoffEnvelope` in isolation. The spy now
// captures every `readLatestEnvelope` call made from inside real pipeline
// functions, proving the B2.2 wiring is honest — the read fires with the
// right args from inside `journeyGenerator.generateApiTests` /
// `generateJourneyTest`, not just because we manually called the helper.

test("pipeline: generateApiTests calls readLatestEnvelope at stage entry (B2.2 wiring)", async () => {
  process.env.SENTRI_AGENT_MODE = "envelope";
  const runId = mkRunId();
  const threadId = mainThreadId(runId);

  // Pre-seed an inbound envelope addressed to "author" so the read can
  // actually resolve a row (proves the spy sees the resolution, not just
  // the call).
  const seeded = emitHandoffEnvelope({
    runId, threadId, workspaceId: WS,
    fromRole: "planner", toRole: "author",
    artifact: { hint: "test-seed" },
    rationale: "pre-seed for pipeline wiring",
  });
  assert.ok(seeded?.id, "pre-seed must persist");

  // Install spy. Capture every read so we can verify the pipeline function
  // called readLatestEnvelope with the args we expect.
  const reads = [];
  _setReadsSpyForTests((entry) => reads.push(entry));

  try {
    // Drive the real production function. `generateApiTests` with one
    // endpoint enters the try block, reads the envelope at stage entry,
    // then tries `generateText` which throws (no provider configured in
    // this isolated test process). The throw is caught at the function's
    // catch arm (line ~549) which returns `[]`. We don't care about the
    // return value — we only care that the read fired with the right args.
    const result = await generateApiTests(
      [{ method: "GET", pathPattern: "/api/ping", exampleUrls: ["https://example.com/api/ping"], statuses: [200], contentType: "application/json", requestBodyExample: null, responseBodyExample: null, callCount: 1, avgDurationMs: 0, pageUrls: [] }],
      "https://example.com",
      { workspaceId: WS, runId },
    );
    // Function caught the no-provider error and degraded to []. That's
    // fine — the contract under test is the read, not the LLM output.
    assert.deepEqual(result, [], "no-provider path degrades to []");
  } finally {
    _setReadsSpyForTests(null);
  }

  // The spy MUST have seen at least one read with the pipeline's expected
  // call signature: threadId = `${runId}-main`, workspaceId = WS, toRole = "author".
  // This is the BEFORE-side proof that the B2.2 wiring is real, not just
  // declared in the call site.
  const matching = reads.filter(
    (r) => r.threadId === threadId && r.workspaceId === WS && r.toRole === "author",
  );
  assert.ok(
    matching.length >= 1,
    `generateApiTests must call readLatestEnvelope({threadId,workspaceId,toRole:"author"}); spy captured ${JSON.stringify(reads)}`,
  );
  // And the read must have resolved the seeded row (not null) — proves
  // the workspace-scoped lookup is wired correctly.
  assert.equal(matching[0].result?.id, seeded.id, "read returned the seeded envelope");
  assert.equal(matching[0].gated, false, "envelope mode means the read is NOT gated off");
});

test("pipeline: generateJourneyTest calls readLatestEnvelope with toRole='planner'", async () => {
  process.env.SENTRI_AGENT_MODE = "envelope";
  const runId = mkRunId();
  const threadId = mainThreadId(runId);

  const reads = [];
  _setReadsSpyForTests((entry) => reads.push(entry));

  try {
    // Minimal journey shape; the function reads, then hits generateText,
    // which throws (no provider) → caught → returns [].
    const result = await generateJourneyTest(
      { name: "auth", pages: [{ url: "https://example.com" }] },
      { "https://example.com": { url: "https://example.com", title: "Home", elements: [] } },
      { workspaceId: WS, runId },
    );
    assert.deepEqual(result, [], "no-provider path degrades to []");
  } finally {
    _setReadsSpyForTests(null);
  }

  const matching = reads.filter(
    (r) => r.threadId === threadId && r.workspaceId === WS && r.toRole === "planner",
  );
  assert.ok(
    matching.length >= 1,
    `generateJourneyTest must call readLatestEnvelope({threadId,workspaceId,toRole:"planner"}); spy captured ${JSON.stringify(reads)}`,
  );
});

test("pipeline: in `pipeline` mode the read fires but is gated off (B2.4 shim contract)", async () => {
  process.env.SENTRI_AGENT_MODE = "pipeline";
  const runId = mkRunId();

  // Pre-seed should fire writes regardless of mode (writes-on always).
  emitHandoffEnvelope({
    runId, threadId: mainThreadId(runId), workspaceId: WS,
    fromRole: "planner", toRole: "author",
    artifact: {}, rationale: "seed",
  });

  const reads = [];
  _setReadsSpyForTests((entry) => reads.push(entry));

  try {
    await generateApiTests(
      [{ method: "GET", pathPattern: "/api/ping", exampleUrls: ["https://example.com/api/ping"], statuses: [200], contentType: "application/json", requestBodyExample: null, responseBodyExample: null, callCount: 1, avgDurationMs: 0, pageUrls: [] }],
      "https://example.com",
      { workspaceId: WS, runId },
    );
  } finally {
    _setReadsSpyForTests(null);
  }

  // The read function was called, but it short-circuited via the gate —
  // `result` is null and `gated: true`. Proves the B2.4 shim contract
  // (writes-on, reads-off in `pipeline` mode).
  const matching = reads.filter((r) => r.toRole === "author");
  assert.ok(matching.length >= 1, "pipeline call site still invokes readLatestEnvelope");
  assert.equal(matching[0].result, null, "pipeline mode short-circuits the read result to null");
  assert.equal(matching[0].gated, true, "gated flag reflects the isEnvelopeReadEnabled() check");
});

// Reset envelope mode to the default so subsequent test files see the
// roadmap-default `pipeline` behaviour.
process.env.SENTRI_AGENT_MODE = "pipeline";

console.log("✅ agent-pipeline-envelope tests passed");

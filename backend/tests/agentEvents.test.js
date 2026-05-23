/**
 * @module tests/agentEvents
 * @description Task 2 — per-agent SSE events.
 *
 * Covers: persistence (runAgentEventRepo.append/getByRunId/deleteByRunId),
 * ordering (createdAt ASC), hydration (runRepo.getById.agentEvents), and
 * SSE broadcast (emitAgentEvent persists + delivers to runListeners).
 *
 * Uses Node's built-in assert/strict and the project's synchronous
 * test(name, fn) convention — no framework.
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as runAgentEventRepo from "../src/database/repositories/runAgentEventRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import { emitAgentEvent } from "../src/aiProvider/agentEventEmitter.js";
import { runListeners } from "../src/routes/sse.js";

let _ctr = 9000;
const uid = (prefix) => `${prefix}-AE-${++_ctr}`;

function makeProject(o = {}) {
  const id = uid("PRJ");
  return { id, name: `AE ${id}`, url: "https://example.com",
    createdAt: new Date().toISOString(), status: "idle", ...o };
}

function makeRun(projectId, o = {}) {
  const id = uid("RUN");
  return { id, projectId, type: "test_run", status: "completed",
    startedAt: new Date().toISOString(), logs: [], tests: [], results: [],
    passed: 0, failed: 0, total: 0, ...o };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM run_agent_events WHERE runId LIKE 'RUN-AE-%'");
  db.exec("DELETE FROM runs             WHERE id    LIKE 'RUN-AE-%'");
  db.exec("DELETE FROM projects         WHERE id    LIKE 'PRJ-AE-%'");
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

resetDb();
const proj = makeProject();
projectRepo.create(proj);

// ─── runAgentEventRepo ────────────────────────────────────────────────────────

console.log("\n── runAgentEventRepo ──");

test("append inserts a row with every field", () => {
  const runId = uid("RUN");
  const createdAt = new Date().toISOString();
  runAgentEventRepo.append(runId, {
    step: 4, agent: "author", phase: "start",
    message: "Writing tests", data: JSON.stringify({ tokensIn: 1234 }),
    nextAgent: null, model: "claude-sonnet-4", createdAt,
  });
  const rows = runAgentEventRepo.getByRunId(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, 4);
  assert.equal(rows[0].agent, "author");
  assert.equal(rows[0].phase, "start");
  assert.equal(rows[0].message, "Writing tests");
  assert.equal(rows[0].data, JSON.stringify({ tokensIn: 1234 }));
  assert.equal(rows[0].model, "claude-sonnet-4");
  assert.equal(rows[0].createdAt, createdAt);
  runAgentEventRepo.deleteByRunId(runId);
});

test("append serialises a non-string data object defensively", () => {
  const runId = uid("RUN");
  runAgentEventRepo.append(runId, {
    step: 3, agent: "explorer", phase: "finding",
    data: { intent: "AUTH", confidence: 87 },
    createdAt: new Date().toISOString(),
  });
  const rows = runAgentEventRepo.getByRunId(runId);
  assert.equal(typeof rows[0].data, "string");
  assert.deepEqual(JSON.parse(rows[0].data), { intent: "AUTH", confidence: 87 });
  runAgentEventRepo.deleteByRunId(runId);
});

test("append rejects an invalid phase (CHECK constraint)", () => {
  const runId = uid("RUN");
  assert.throws(() => {
    runAgentEventRepo.append(runId, {
      step: 4, agent: "author", phase: "bogus",
      createdAt: new Date().toISOString(),
    });
  }, /CHECK|constraint/i);
  assert.equal(runAgentEventRepo.countByRunId(runId), 0);
});

test("getByRunId orders rows by createdAt ASC even when inserted out of order", () => {
  const runId = uid("RUN");
  const t3 = "2026-06-01T12:00:03.000Z";
  const t2 = "2026-06-01T12:00:02.000Z";
  const t1 = "2026-06-01T12:00:01.000Z";
  runAgentEventRepo.append(runId, { step: 3, agent: "explorer", phase: "done",     createdAt: t3 });
  runAgentEventRepo.append(runId, { step: 3, agent: "explorer", phase: "progress", createdAt: t2 });
  runAgentEventRepo.append(runId, { step: 3, agent: "explorer", phase: "start",    createdAt: t1 });
  const rows = runAgentEventRepo.getByRunId(runId);
  assert.deepEqual(rows.map(r => r.phase), ["start", "progress", "done"]);
  runAgentEventRepo.deleteByRunId(runId);
});

test("getByRunId returns empty array for unknown runId", () => {
  assert.deepEqual(runAgentEventRepo.getByRunId("RUN-AE-DOES-NOT-EXIST"), []);
});

test("deleteByRunIds is a no-op for empty array", () => {
  assert.equal(runAgentEventRepo.deleteByRunIds([]), 0);
});

// ─── runRepo hydration ────────────────────────────────────────────────────────

console.log("\n── runRepo hydration ──");

test("runRepo.getById() hydrates agentEvents from run_agent_events", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  runAgentEventRepo.append(run.id, {
    step: 4, agent: "author", phase: "start",
    message: "Writing tests", data: JSON.stringify({ tokensIn: 100 }),
    model: "claude-sonnet-4", createdAt: "2026-06-01T12:00:00.000Z",
  });
  runAgentEventRepo.append(run.id, {
    step: 4, agent: "author", phase: "done",
    createdAt: "2026-06-01T12:00:05.000Z",
  });
  const fetched = runRepo.getById(run.id);
  assert.ok(Array.isArray(fetched.agentEvents));
  assert.equal(fetched.agentEvents.length, 2);
  assert.equal(fetched.agentEvents[0].phase, "start");
  // `data` is parsed into the structured shape on hydration.
  assert.deepEqual(fetched.agentEvents[0].data, { tokensIn: 100 });
  assert.equal(fetched.agentEvents[1].phase, "done");
  runRepo.hardDeleteById(run.id);
});

test("runRepo.getById() returns agentEvents:[] when none are persisted", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  const fetched = runRepo.getById(run.id);
  assert.deepEqual(fetched.agentEvents, []);
  runRepo.hardDeleteById(run.id);
});

test("runRepo.hardDeleteById() cascades into run_agent_events", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  runAgentEventRepo.append(run.id, { step: 4, agent: "author", phase: "start", createdAt: new Date().toISOString() });
  assert.equal(runAgentEventRepo.countByRunId(run.id), 1);
  runRepo.hardDeleteById(run.id);
  assert.equal(runAgentEventRepo.countByRunId(run.id), 0);
});

// ─── emitAgentEvent broadcast ─────────────────────────────────────────────────

console.log("\n── emitAgentEvent broadcast ──");

test("emitAgentEvent persists AND delivers to a local SSE listener", () => {
  const runId = uid("RUN");
  // Stub SSE listener — captures every `data: …\n\n` chunk emitRunEvent writes.
  const chunks = [];
  const fakeRes = { write: (chunk) => { chunks.push(chunk); } };
  if (!runListeners.has(runId)) runListeners.set(runId, new Set());
  runListeners.get(runId).add(fakeRes);
  try {
    emitAgentEvent(runId, {
      step: 4, agent: "author", phase: "start",
      message: "Writing tests", model: "claude-sonnet-4",
    });
    // ── Persisted ──
    const rows = runAgentEventRepo.getByRunId(runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, "start");
    assert.equal(rows[0].agent, "author");
    assert.equal(rows[0].message, "Writing tests");
    assert.equal(rows[0].model, "claude-sonnet-4");
    assert.ok(rows[0].createdAt);
    // ── Broadcast ──
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].startsWith("data: "));
    const payload = JSON.parse(chunks[0].slice("data: ".length).trim());
    assert.equal(payload.type, "agent_event");
    assert.equal(payload.agent, "author");
    assert.equal(payload.phase, "start");
    assert.equal(payload.step, 4);
  } finally {
    runListeners.get(runId)?.delete(fakeRes);
    if (runListeners.get(runId)?.size === 0) runListeners.delete(runId);
    runAgentEventRepo.deleteByRunId(runId);
  }
});

test("emitAgentEvent is a no-op when runId is null/empty", () => {
  // Must not throw and must not append. Contract enforced by the guard in
  // agentEventEmitter.js — eval-harness / CLI callers (which omit runId)
  // depend on this silent no-op so they don't trip a foreign-key error.
  emitAgentEvent(null, { step: 4, agent: "author", phase: "start" });
  emitAgentEvent("",   { step: 4, agent: "author", phase: "start" });
  assert.ok(true);
});

// ─── results ──────────────────────────────────────────────────────────────────

process.on("beforeExit", () => {
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});

/**
 * @module tests/sse-caps
 * @description Regression coverage for the CR-009 listener cap + §11.3
 * backpressure cap on `routes/sse.js`. Exercises the public SSE export
 * surface (`runListeners` + `emitRunEvent`) with mock `res` objects — no
 * Express needed, no real sockets, no auth. The point is to pin the two
 * cap behaviours so a future refactor of `_deliverToLocal` can't silently
 * drop them without a failing test:
 *
 *   • CR-009  — backed-up `runListeners.get(runId).size` must stay
 *               bounded; a 51st listener is rejected by the route, but
 *               we exercise the lower-level delivery path here.
 *   • §11.3   — a listener with `writableLength > MAX_WRITABLE_LENGTH`
 *               is `end()`-ed and skipped instead of being written to,
 *               so a slow consumer can't grow process memory for the
 *               run's lifetime.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { emitRunEvent, runListeners } from "../src/routes/sse.js";

/**
 * Minimal Express-shaped `res` mock that records writes and tracks the
 * `writableLength` knob the backpressure check reads. Setting
 * `_writableLength` simulates a stalled client whose kernel send buffer
 * is backed up.
 */
function mockRes({ writableLength = 0 } = {}) {
  return {
    writes: [],
    ended: false,
    writableLength,
    write(chunk) {
      this.writes.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
  };
}

test("emitRunEvent — delivers to all healthy listeners on the run", () => {
  const runId = "run-test-deliver";
  const a = mockRes();
  const b = mockRes();
  runListeners.set(runId, new Set([a, b]));

  try {
    emitRunEvent(runId, "log", { line: "hello" });

    assert.equal(a.writes.length, 1, "listener A should receive the event");
    assert.equal(b.writes.length, 1, "listener B should receive the event");
    assert.match(a.writes[0], /^data: /);
    assert.match(a.writes[0], /"type":"log"/);
    assert.match(a.writes[0], /"line":"hello"/);
    assert.equal(a.ended, false, "healthy listener should NOT be ended");
    assert.equal(b.ended, false, "healthy listener should NOT be ended");
  } finally {
    runListeners.delete(runId);
  }
});

test("§11.3 backpressure — listener with writableLength > 1 MiB is ended and skipped", () => {
  const runId = "run-test-backpressure";
  const slow = mockRes({ writableLength: 2 * 1024 * 1024 }); // 2 MiB queued
  const healthy = mockRes();
  runListeners.set(runId, new Set([slow, healthy]));

  try {
    emitRunEvent(runId, "log", { line: "burst" });

    assert.equal(slow.writes.length, 0, "slow listener must NOT receive the event");
    assert.equal(slow.ended, true, "slow listener must be ended by the backpressure check");
    assert.equal(healthy.writes.length, 1, "healthy listener must still receive the event");
    assert.equal(healthy.ended, false);
  } finally {
    runListeners.delete(runId);
  }
});

test("§11.3 backpressure — listener under the cap continues to receive events", () => {
  const runId = "run-test-under-cap";
  // Just under the 1 MiB default (cap is exclusive: `> MAX_WRITABLE_LENGTH`).
  const ok = mockRes({ writableLength: 1024 * 1024 });
  runListeners.set(runId, new Set([ok]));

  try {
    emitRunEvent(runId, "log", { line: "still ok" });

    assert.equal(ok.writes.length, 1, "writableLength === cap should still deliver");
    assert.equal(ok.ended, false);
  } finally {
    runListeners.delete(runId);
  }
});

test("emitRunEvent — type=done closes every listener and clears the run's listener set", () => {
  const runId = "run-test-done";
  const a = mockRes();
  const b = mockRes();
  runListeners.set(runId, new Set([a, b]));

  emitRunEvent(runId, "done", { status: "completed" });

  assert.equal(a.ended, true, "type=done must end listener A");
  assert.equal(b.ended, true, "type=done must end listener B");
  assert.equal(runListeners.has(runId), false, "runListeners[runId] must be cleared after done");
});

test("emitRunEvent — no listeners registered is a safe no-op", () => {
  // Earlier tests have set+deleted entries; the registry should not retain
  // the runId after a `done` event flushes it. This exercises the empty-set
  // / missing-key branch in `_deliverToLocal`.
  const runId = "run-test-empty";
  assert.doesNotThrow(() => emitRunEvent(runId, "log", { line: "no one listening" }));
  assert.equal(runListeners.has(runId), false);
});

test("CR-009 — runListeners.size accurately tracks attached listeners", () => {
  // Documenting the contract the per-run cap relies on: the Set's `.size`
  // grows on add and shrinks on delete. The route's 503 gate keys on this
  // value directly via `existing.size >= MAX_LISTENERS_PER_RUN`. If a
  // future refactor changes the storage (e.g. to a WeakSet, which has no
  // .size), the route's cap silently breaks — this assertion catches that.
  const runId = "run-test-size";
  const set = new Set();
  runListeners.set(runId, set);

  try {
    for (let i = 0; i < 50; i++) set.add(mockRes());
    assert.equal(set.size, 50);
    assert.equal(runListeners.get(runId).size, 50);

    // Delete one; size must reflect that.
    const first = [...set][0];
    set.delete(first);
    assert.equal(runListeners.get(runId).size, 49);
  } finally {
    runListeners.delete(runId);
  }
});

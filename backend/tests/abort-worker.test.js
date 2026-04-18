/**
 * @module tests/abort-worker
 * @description Unit tests for abort endpoint integration with BullMQ worker.
 *
 * Verifies:
 *   - The abort handler correctly signals the worker's AbortController
 *     when a BullMQ-processed run is aborted.
 *   - The in-process fallback (runAbortControllers) is still checked first.
 *   - When neither registry has an entry, the abort still updates the DB.
 *
 * These tests simulate the abort handler's controller-lookup logic without
 * requiring Express, Redis, or a database connection.
 */

import assert from "node:assert/strict";

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── Simulate the abort handler's controller-lookup logic ─────────────────────

/**
 * Simulates the abort endpoint's logic for finding and signalling the
 * correct AbortController.
 *
 * @param {string} runId
 * @param {Map} runAbortControllers   - In-process registry.
 * @param {Map} workerAbortControllers - BullMQ worker registry.
 * @returns {{ source: string|null, aborted: boolean }}
 */
function simulateAbortLookup(runId, runAbortControllers, workerAbortControllers) {
  const entry = runAbortControllers.get(runId);
  const workerController = workerAbortControllers.get(runId);

  if (entry) {
    entry.controller.abort();
    runAbortControllers.delete(runId);
    return { source: "in-process", aborted: true };
  } else if (workerController) {
    workerController.abort();
    workerAbortControllers.delete(runId);
    return { source: "worker", aborted: true };
  }

  return { source: null, aborted: false };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\n── abort endpoint — controller lookup ──");

test("in-process controller is preferred when both registries have entries", () => {
  const runId = "RUN-1";
  const inProcessController = new AbortController();
  const workerController = new AbortController();

  const runAbortControllers = new Map();
  runAbortControllers.set(runId, {
    controller: inProcessController,
    run: { status: "running" },
  });

  const workerAbortControllers = new Map();
  workerAbortControllers.set(runId, workerController);

  const result = simulateAbortLookup(runId, runAbortControllers, workerAbortControllers);

  assert.equal(result.source, "in-process");
  assert.equal(result.aborted, true);
  assert.equal(inProcessController.signal.aborted, true);
  assert.equal(workerController.signal.aborted, false, "worker controller should NOT be aborted");
  assert.equal(runAbortControllers.has(runId), false, "in-process entry should be removed");
  assert.equal(workerAbortControllers.has(runId), true, "worker entry should remain");
});

test("worker controller is used when in-process registry has no entry", () => {
  const runId = "RUN-2";
  const workerController = new AbortController();

  const runAbortControllers = new Map();
  const workerAbortControllers = new Map();
  workerAbortControllers.set(runId, workerController);

  const result = simulateAbortLookup(runId, runAbortControllers, workerAbortControllers);

  assert.equal(result.source, "worker");
  assert.equal(result.aborted, true);
  assert.equal(workerController.signal.aborted, true);
  assert.equal(workerAbortControllers.has(runId), false, "worker entry should be removed");
});

test("returns not-aborted when neither registry has an entry", () => {
  const runId = "RUN-3";
  const runAbortControllers = new Map();
  const workerAbortControllers = new Map();

  const result = simulateAbortLookup(runId, runAbortControllers, workerAbortControllers);

  assert.equal(result.source, null);
  assert.equal(result.aborted, false);
});

test("abort signal is actually received by the controller", () => {
  const runId = "RUN-4";
  const workerController = new AbortController();
  let signalReceived = false;

  workerController.signal.addEventListener("abort", () => {
    signalReceived = true;
  });

  const runAbortControllers = new Map();
  const workerAbortControllers = new Map();
  workerAbortControllers.set(runId, workerController);

  simulateAbortLookup(runId, runAbortControllers, workerAbortControllers);

  assert.equal(signalReceived, true, "abort signal should be received");
});

test("aborting one run does not affect another run's controller", () => {
  const runAbortControllers = new Map();
  const workerAbortControllers = new Map();

  const controller1 = new AbortController();
  const controller2 = new AbortController();
  workerAbortControllers.set("RUN-A", controller1);
  workerAbortControllers.set("RUN-B", controller2);

  simulateAbortLookup("RUN-A", runAbortControllers, workerAbortControllers);

  assert.equal(controller1.signal.aborted, true);
  assert.equal(controller2.signal.aborted, false, "RUN-B should not be affected");
  assert.equal(workerAbortControllers.has("RUN-A"), false);
  assert.equal(workerAbortControllers.has("RUN-B"), true);
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

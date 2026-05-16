/**
 * @module tests/worker-pool-dashboard
 * @description Unit tests for the AUTO-008 worker-pool payload shape
 * returned from `GET /api/v1/dashboard`.
 *
 * Exercises the pure transform logic without booting Express, BullMQ, or
 * Redis — mirrors the inline block in `routes/dashboard.js`.
 */
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ ${name}`);
      console.error(`     ${err.stack || err.message}`);
      failed++;
    }
  })());
}

/**
 * Pure mirror of the workerPool block in `backend/src/routes/dashboard.js`.
 * Kept in lockstep with the route — if you change one, change the other.
 */
async function computeWorkerPool({ available, queueStats, workers }) {
  let workerPool = {
    mode: "single-process",
    queue: { waiting: 0, active: 0, completed: 0, delayed: 0, failed: 0 },
    activeWorkers: 0,
    idleWorkers: 0,
    totalWorkers: 0,
  };
  if (available) {
    try {
      const queue = await queueStats();
      const ws = workers ? await workers() : [];
      const totalWorkers = Array.isArray(ws) ? ws.length : 0;
      const activeWorkers = Math.min(queue.active || 0, totalWorkers);
      const idleWorkers = Math.max(0, totalWorkers - activeWorkers);
      workerPool = {
        mode: "distributed",
        queue,
        activeWorkers,
        idleWorkers,
        totalWorkers,
      };
    } catch {
      // swallow
    }
  }
  return workerPool;
}

console.log("\n── workerPool dashboard payload ──");

test("returns single-process stub when queue unavailable", async () => {
  const wp = await computeWorkerPool({ available: false });
  assert.equal(wp.mode, "single-process");
  assert.equal(wp.totalWorkers, 0);
  assert.equal(wp.activeWorkers, 0);
  assert.equal(wp.idleWorkers, 0);
  assert.deepEqual(Object.keys(wp.queue).sort(),
    ["active", "completed", "delayed", "failed", "waiting"]);
});

test("returns distributed payload with queue + worker counts", async () => {
  const wp = await computeWorkerPool({
    available: true,
    queueStats: async () => ({ waiting: 3, active: 2, completed: 50, delayed: 0, failed: 1 }),
    workers: async () => [{}, {}, {}, {}], // 4 worker processes
  });
  assert.equal(wp.mode, "distributed");
  assert.equal(wp.totalWorkers, 4);
  assert.equal(wp.activeWorkers, 2);
  assert.equal(wp.idleWorkers, 2);
  assert.equal(wp.queue.completed, 50);
  assert.equal(wp.queue.waiting, 3);
});

test("active workers capped at total worker count", async () => {
  // BullMQ active job count can transiently exceed live worker count if a
  // worker disconnects mid-job; the cap prevents negative idleWorkers.
  const wp = await computeWorkerPool({
    available: true,
    queueStats: async () => ({ waiting: 0, active: 10, completed: 0, delayed: 0, failed: 0 }),
    workers: async () => [{}, {}], // only 2 workers alive
  });
  assert.equal(wp.activeWorkers, 2);
  assert.equal(wp.idleWorkers, 0);
});

test("falls back to single-process stub on queue introspection error", async () => {
  const wp = await computeWorkerPool({
    available: true,
    queueStats: async () => { throw new Error("redis down"); },
    workers: async () => [],
  });
  assert.equal(wp.mode, "single-process");
  assert.equal(wp.totalWorkers, 0);
});

test("zero workers connected → all counters zero, mode still distributed", async () => {
  const wp = await computeWorkerPool({
    available: true,
    queueStats: async () => ({ waiting: 5, active: 0, completed: 0, delayed: 0, failed: 0 }),
    workers: async () => [],
  });
  assert.equal(wp.mode, "distributed");
  assert.equal(wp.totalWorkers, 0);
  assert.equal(wp.activeWorkers, 0);
  assert.equal(wp.idleWorkers, 0);
  assert.equal(wp.queue.waiting, 5);
});

// ─── Results ──────────────────────────────────────────────────────────────────
await Promise.all(pending);
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

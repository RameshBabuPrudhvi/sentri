/**
 * @module tests/load/cache-throughput
 * @description B4.5 — Cache throughput budget test.
 *
 * Hammers `setCached` + `getCached` at high frequency to verify the
 * SQLite cache layer doesn't bottleneck under sustained load.
 *
 * Budget: 10k reads + 1k writes in < 5s total (wall clock).
 *
 * NOT registered in `run-tests.js` — nightly / manual only.
 *
 * Usage:
 *   node backend/tests/load/cache-throughput.js
 */
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");
const { getDatabase } = await import("../../src/database/sqlite.js");
getDatabase();
const { ensureDefaultWorkspaces } = await import("../../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();
const { setCached, getCached, _resetForTests } = await import("../../src/aiProvider/responseCache.js");
const WRITES = 1000;
const READS = 10000;
const BUDGET_SEC = 5;
_resetForTests();
console.log(`\nB4.5 cache-throughput: ${WRITES} writes + ${READS} reads, budget < ${BUDGET_SEC}s\n`);
const routeId = `pr-${randomUUID().slice(0, 8)}`;
const model = "test-model";
// Phase 1: writes
const t0 = performance.now();
for (let i = 0; i < WRITES; i++) {
  setCached(routeId, model, {
    messages: { user: `prompt-${i}` },
    maxTokens: 4096,
    temperature: 0,
    responseFormat: "json_object",
  }, `response-${i}`, { input: 100, output: 50, costUsd: 0.001 }, 3600);
}
const writeMs = performance.now() - t0;
console.log(`  writes: ${WRITES} in ${writeMs.toFixed(1)}ms (${(WRITES / writeMs * 1000).toFixed(0)} writes/sec)`);
// Phase 2: reads (mix of hits and misses)
const t1 = performance.now();
let hits = 0;
for (let i = 0; i < READS; i++) {
  // 70% hit rate — read existing keys; 30% miss rate — read non-existent
  const idx = i < READS * 0.7 ? i % WRITES : WRITES + i;
  const result = getCached(routeId, model, {
    messages: { user: `prompt-${idx}` },
    maxTokens: 4096,
    temperature: 0,
    responseFormat: "json_object",
  });
  if (result) hits++;
}
const readMs = performance.now() - t1;
console.log(`  reads:  ${READS} in ${readMs.toFixed(1)}ms (${(READS / readMs * 1000).toFixed(0)} reads/sec, ${hits} hits)`);
const totalSec = (writeMs + readMs) / 1000;
console.log(`  total:  ${totalSec.toFixed(2)}s`);
if (totalSec > BUDGET_SEC) {
  console.error(`\n❌ FAIL: ${totalSec.toFixed(2)}s exceeds ${BUDGET_SEC}s budget`);
  process.exit(1);
}
console.log(`\n✅ PASS: ${totalSec.toFixed(2)}s within ${BUDGET_SEC}s budget`);
process.exit(0);

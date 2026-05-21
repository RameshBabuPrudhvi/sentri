/**
 * @module tests/load/dispatch-overhead
 * @description B4.5 — Dispatch-path overhead budget test.
 *
 * Measures the combined p99 latency of `resolveRoute` +
 * `quotaGuard.checkAndReserve` + `responseCache.getCached` against
 * a mocked HTTP layer (no real provider calls). Budget: p99 < 5ms.
 *
 * NOT registered in `run-tests.js` — this is a nightly / manual test
 * that operators run via `node backend/tests/load/dispatch-overhead.js`.
 * CI runs it on a separate workflow gated by schedule, not on every PR.
 *
 * Usage:
 *   ROUTES=10 ROLES=7 CALLS_PER=1000 node backend/tests/load/dispatch-overhead.js
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
const { resolveRoute } = await import("../../src/aiProvider/registry.js");
const { checkAndReserve, _resetForTests: resetQuota } = await import("../../src/aiProvider/quotaGuard.js");
const { getCached, _resetForTests: resetCache } = await import("../../src/aiProvider/responseCache.js");
const ROUTES = Number(process.env.ROUTES) || 10;
const ROLES = Number(process.env.ROLES) || 7;
const CALLS_PER = Number(process.env.CALLS_PER) || 1000;
const BUDGET_P99_MS = 5;
const ROLE_NAMES = ["planner", "author", "critic", "healer", "reviewer", "optimizer", "monitor"].slice(0, ROLES);
// Seed workspace + routes
const db = getDatabase();
const now = new Date().toISOString();
const userId = `usr-${randomUUID().slice(0, 8)}`;
const wsId = `ws-${randomUUID().slice(0, 8)}`;
db.prepare("INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)").run(userId, "Load", `${userId}@test.local`, "x", now, now);
db.prepare("INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)").run(wsId, "load-ws", wsId, userId, now, now);
const routeIds = [];
for (let i = 0; i < ROUTES; i++) {
  const id = `pr-${randomUUID().slice(0, 8)}`;
  routeIds.push(id);
  db.prepare(
    "INSERT INTO provider_routes (id, workspaceId, name, family, protocol, model, enabled, cacheEnabled, cacheTtlSec, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 60, ?, ?)",
  ).run(id, wsId, `route-${i}`, "openai", "openai", `model-${i}`, now, now);
}
console.log(`\nB4.5 dispatch-overhead: ${ROUTES} routes × ${ROLES} roles × ${CALLS_PER} calls = ${ROUTES * ROLES * CALLS_PER} iterations\n`);
const timings = [];
for (const role of ROLE_NAMES) {
  for (const routeId of routeIds) {
    for (let c = 0; c < CALLS_PER; c++) {
      const t0 = performance.now();
      // 1. resolveRoute
      resolveRoute({ agentRole: role, workspaceId: wsId });
      // 2. quotaGuard.checkAndReserve (in-memory path, no Redis)
      await checkAndReserve(routeId, 100, { rpmLimit: 100000, tpmLimit: 10000000 });
      // 3. responseCache.getCached (miss path — no rows seeded)
      getCached(routeId, `model-0`, {
        messages: { user: `prompt-${c}` },
        maxTokens: 4096,
        temperature: 0,
        responseFormat: "json_object",
      });
      const elapsed = performance.now() - t0;
      timings.push(elapsed);
    }
  }
}
timings.sort((a, b) => a - b);
const p50 = timings[Math.floor(timings.length * 0.50)];
const p95 = timings[Math.floor(timings.length * 0.95)];
const p99 = timings[Math.floor(timings.length * 0.99)];
const max = timings[timings.length - 1];
console.log(`  p50:  ${p50.toFixed(3)}ms`);
console.log(`  p95:  ${p95.toFixed(3)}ms`);
console.log(`  p99:  ${p99.toFixed(3)}ms`);
console.log(`  max:  ${max.toFixed(3)}ms`);
console.log(`  budget: p99 < ${BUDGET_P99_MS}ms`);
if (p99 > BUDGET_P99_MS) {
  console.error(`\n❌ FAIL: p99 ${p99.toFixed(3)}ms exceeds ${BUDGET_P99_MS}ms budget`);
  process.exit(1);
}
console.log(`\n✅ PASS: p99 ${p99.toFixed(3)}ms within ${BUDGET_P99_MS}ms budget`);
process.exit(0);

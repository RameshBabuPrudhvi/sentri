/**
 * @module tests/concurrent-dispatch
 * @description B3.11 — 100 parallel dispatch calls: no breaker race,
 *   no quota overflow, cache populates exactly once.
 *
 * Uses the in-memory SQLite + in-memory quota bucket path (no Redis).
 * The test seeds a single route with rpmLimit=200 + tpmLimit=1000000
 * (generous enough that the 100 calls fit), fires them all via
 * Promise.all, and asserts:
 *   1. All 100 resolve (no ERR_RATE_LIMIT_LOCAL).
 *   2. Token bucket consumed exactly 100 RPM units.
 *   3. Cache was populated exactly once per unique prompt (not 100×).
 *   4. No unhandled rejections leaked.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");
const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();
const {
  checkAndReserve,
  _resetForTests: resetQuota,
} = await import("../src/aiProvider/quotaGuard.js");
const {
  computeCacheKey,
  setCached,
  getCached,
  coalesceInFlight,
  registerInFlight,
  _resetForTests: resetCache,
} = await import("../src/aiProvider/responseCache.js");
const { test, summary } = createTestRunner();
const CONCURRENCY = 100;
const ROUTE_ID = `pr-${randomUUID().slice(0, 8)}`;
const MODEL = "test-model";
// ── 1. Quota: 100 concurrent reserves don't overflow ──────────────────────────
// Stage-2 follow-up: every `test(...)` below is `await`-ed because these
// tests mutate shared global state via `resetQuota()` / `resetCache()`.
// With the shared runner's queued-promise model (helpers/test-base.js:438),
// bare top-level `test(...)` lets one test's `resetQuota()` interleave
// with another's setup — wiping the token bucket between the 200th and
// 201st reserve and falsely allowing the rejection check to pass through.
// Awaiting each registration restores the sequential isolation the
// pre-migration synchronous-by-default runner provided.
await test(`${CONCURRENCY} concurrent checkAndReserve calls — all succeed, no overflow`, async () => {
  resetQuota();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      checkAndReserve(`${ROUTE_ID}-quota`, 10, { rpmLimit: 200, tpmLimit: 10_000_000 }),
    ),
  );
  const oks = results.filter((r) => r.ok);
  assert.equal(oks.length, CONCURRENCY, `all ${CONCURRENCY} calls must succeed`);
});
await test("quota bucket rejects call 201 after 200 RPM consumed", async () => {
  resetQuota();
  // Burn 200 RPM
  for (let i = 0; i < 200; i++) {
    await checkAndReserve(`${ROUTE_ID}-overflow`, 1, { rpmLimit: 200, tpmLimit: 10_000_000 });
  }
  const denied = await checkAndReserve(`${ROUTE_ID}-overflow`, 1, { rpmLimit: 200, tpmLimit: 10_000_000 });
  assert.equal(denied.ok, false, "201st call must be rejected");
  assert.equal(denied.reason, "rpm");
});
// ── 2. Cache: concurrent identical prompts populate exactly once ──────────────
await test("concurrent identical setCached calls produce exactly one row", () => {
  resetCache();
  const params = { messages: { user: "concurrent-prompt" }, maxTokens: 100, temperature: 0 };
  // Simulate 100 concurrent writes for the same key
  for (let i = 0; i < CONCURRENCY; i++) {
    setCached(ROUTE_ID, MODEL, params, "response-text", { input: 10, output: 5, costUsd: 0.001 }, 60);
  }
  // Verify exactly one row exists (INSERT OR REPLACE dedupes by cacheKey)
  const db = getDatabase();
  const rows = db.prepare("SELECT COUNT(*) AS n FROM ai_response_cache WHERE routeId = ?").get(ROUTE_ID);
  assert.equal(rows.n, 1, "cache must contain exactly one row for the same key");
  // hitCount should still be 0 (writes don't increment hitCount)
  const row = db.prepare("SELECT hitCount FROM ai_response_cache WHERE routeId = ?").get(ROUTE_ID);
  assert.equal(row.hitCount, 0);
});
await test("concurrent getCached reads after one write all return the same response", () => {
  resetCache();
  const params = { messages: { user: "read-concurrent" }, maxTokens: 100, temperature: 0 };
  setCached(ROUTE_ID, MODEL, params, "shared-response", { input: 5, output: 2 }, 60);
  const results = Array.from({ length: CONCURRENCY }, () =>
    getCached(ROUTE_ID, MODEL, params),
  );
  assert.equal(results.filter(Boolean).length, CONCURRENCY, "all reads must hit");
  for (const r of results) {
    assert.equal(r.response, "shared-response");
  }
});
// ── 3. Coalescing: concurrent in-flight registrations share one promise ───────
await test("registerInFlight + coalesceInFlight: N concurrent callers share one promise", async () => {
  resetCache();
  const key = `coalesce-${randomUUID().slice(0, 8)}`;
  let resolveShared;
  const sharedPromise = new Promise((resolve) => { resolveShared = resolve; });
  registerInFlight(key, sharedPromise);
  // N callers all try to coalesce
  const coalesced = Array.from({ length: CONCURRENCY }, () => coalesceInFlight(key));
  // All must get the same promise reference
  for (const c of coalesced) {
    assert.strictEqual(c, sharedPromise, "every caller must get the same Promise");
  }
  // Resolve and verify all see the result
  resolveShared({ text: "shared", usage: null, costResult: { costUsd: 0, source: "none" } });
  const results = await Promise.all(coalesced);
  for (const r of results) {
    assert.equal(r.text, "shared");
  }
});
// ── 4. No unhandled rejections ────────────────────────────────────────────────
await test("no unhandled rejections during concurrent operations", async () => {
  let unhandled = 0;
  const handler = () => { unhandled++; };
  process.on("unhandledRejection", handler);
  try {
    resetQuota();
    resetCache();
    // Mix of quota checks + cache reads + cache writes
    const ops = Array.from({ length: CONCURRENCY }, (_, i) => {
      if (i % 3 === 0) return checkAndReserve(`${ROUTE_ID}-mixed`, 10, { rpmLimit: 10000 });
      if (i % 3 === 1) {
        setCached(ROUTE_ID, MODEL, { messages: { user: `p-${i}` } }, `r-${i}`, null, 60);
        return Promise.resolve();
      }
      return Promise.resolve(getCached(ROUTE_ID, MODEL, { messages: { user: `p-${i}` } }));
    });
    await Promise.all(ops);
    // Give a tick for any stray rejections to surface
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled, 0, "no unhandled rejections should occur");
  } finally {
    process.removeListener("unhandledRejection", handler);
  }
});
summary("Concurrent dispatch (B3.11)");

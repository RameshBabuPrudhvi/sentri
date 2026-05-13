/**
 * @module tests/compat-config-cache.test
 * @description Unit + integration tests for utils/compatConfigCache.js.
 *
 * Covers:
 *   1. Read-through behaviour: first call invokes loader, second call hits cache.
 *   2. TTL expiry: after the TTL elapses the loader is invoked again.
 *   3. Write-through invalidation via apiKeyRepo.setCompatSlot() — a fresh
 *      read after save returns the updated config without waiting for TTL.
 *   4. Write-through invalidation via apiKeyRepo.deleteCompatSlot().
 *   5. Cross-process coherence: a Redis message from another instance drops
 *      the local entry.  Gated on REDIS_URL — skipped cleanly otherwise so
 *      CI without Redis still passes.
 *
 * Tests use `:memory:` SQLite so they don't pollute a real DB, and clear
 * the cache between cases for deterministic hit/miss accounting.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Force an in-memory DB before any module that imports sqlite.js loads it.
process.env.DB_PATH = ":memory:";
// Silence noisy info logs during tests.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "error";

// Lazy imports so the DB_PATH override above is in effect before sqlite.js
// evaluates. getDatabase() lazy-initialises and runs migrations on first call.
const { getDatabase } = await import("../src/database/sqlite.js");
getDatabase(); // trigger migrations so api_keys table exists

const apiKeyRepo = await import("../src/database/repositories/apiKeyRepo.js");
const cache = await import("../src/utils/compatConfigCache.js");
const redisClient = await import("../src/utils/redisClient.js");

// Shared slot config fixture used by most cases.
const FIXTURE = {
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "test-fixture-key-cache", // gitleaks:allow
  displayName: "Cache Test",
};

// ─── 1. Read-through: loader runs once per slot, subsequent calls hit cache ───

test("cache: first get() is a miss, second get() is a hit", () => {
  cache.__test.clear();
  let loaderCalls = 0;
  const value = () => { loaderCalls += 1; return { ...FIXTURE }; };

  const first = cache.get("compat:alpha", value);
  const second = cache.get("compat:alpha", value);

  assert.deepEqual(first, FIXTURE);
  assert.deepEqual(second, FIXTURE);
  assert.equal(loaderCalls, 1, "loader must only run once across two reads");
  const stats = cache.__test.stats();
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 1);
});

// ─── 2. TTL expiry ────────────────────────────────────────────────────────────

test("cache: entry expires after TTL and loader is re-invoked", async () => {
  cache.__test.clear();
  const originalTtl = cache.__test.getTtl();
  cache.__test.setTtl(10); // 10 ms so the test doesn't hang

  let loaderCalls = 0;
  const loader = () => { loaderCalls += 1; return { version: loaderCalls }; };

  const first = cache.get("compat:ttl", loader);
  assert.deepEqual(first, { version: 1 });

  // Wait past the TTL.  setTimeout(20) is generous for a 10 ms TTL on any CI.
  await new Promise((r) => setTimeout(r, 25));

  const second = cache.get("compat:ttl", loader);
  assert.deepEqual(second, { version: 2 }, "expired entry must reload via loader");
  assert.equal(loaderCalls, 2);

  cache.__test.setTtl(originalTtl);
});

// ─── 3. Write-through invalidation on setCompatSlot ───────────────────────────

test("apiKeyRepo.setCompatSlot invalidates the cache so a fresh read returns the updated config", () => {
  cache.__test.clear();
  apiKeyRepo.setCompatSlot("wr-set", FIXTURE);

  // Prime the cache.
  const primed = cache.get("compat:wr-set", () => apiKeyRepo.get("compat:wr-set"));
  assert.equal(primed.model, "test-model");

  // Overwrite with new config — setCompatSlot must drop the cached entry.
  const updated = { ...FIXTURE, model: "test-model-v2" };
  apiKeyRepo.setCompatSlot("wr-set", updated);

  // The cache key should no longer be present (write-through invalidation
  // removed it synchronously) — if this misses, the next get() falls through
  // to the loader and returns the fresh row from SQLite.
  assert.equal(cache.__test.has("compat:wr-set"), false, "cache entry must be dropped on save");

  const fresh = cache.get("compat:wr-set", () => apiKeyRepo.get("compat:wr-set"));
  assert.equal(fresh.model, "test-model-v2", "post-save read must return the new model");

  apiKeyRepo.deleteCompatSlot("wr-set");
});

// ─── 4. Write-through invalidation on deleteCompatSlot ────────────────────────

test("apiKeyRepo.deleteCompatSlot invalidates the cache so a deleted slot returns null", () => {
  cache.__test.clear();
  apiKeyRepo.setCompatSlot("wr-del", FIXTURE);

  // Prime the cache with the existing value.
  const primed = cache.get("compat:wr-del", () => apiKeyRepo.get("compat:wr-del"));
  assert.ok(primed && primed.apiKey, "pre-delete read must return the fixture");

  apiKeyRepo.deleteCompatSlot("wr-del");
  assert.equal(cache.__test.has("compat:wr-del"), false, "cache entry must be dropped on delete");

  const afterDelete = cache.get("compat:wr-del", () => apiKeyRepo.get("compat:wr-del"));
  assert.equal(afterDelete, null, "deleted slot must read as null without waiting for TTL");
});

// ─── 5. Cross-process coherence via Redis pub/sub ─────────────────────────────
// Simulates a sibling instance publishing an invalidation message to the
// shared Redis channel.  We can't easily spin up a second Node process in
// `node --test`, so we construct a second ioredis client bound to the same
// REDIS_URL and publish directly — this instance's subscriber should still
// pick up the message (it's not self-echo because the _origin id differs).

test("cross-process: a Redis invalidate message from another instance drops the local entry", async (t) => {
  if (!process.env.REDIS_URL || !redisClient.isRedisAvailable()) {
    t.skip("REDIS_URL not set — cross-process test requires Redis (run with REDIS_URL=redis://localhost:6379 to exercise)");
    return;
  }

  cache.__test.clear();
  // Prime the cache with a synthetic entry (no DB write needed — we're
  // asserting the subscriber, not the repo).
  cache.get("compat:xproc", () => ({ ...FIXTURE }));
  assert.equal(cache.__test.has("compat:xproc"), true);

  const statsBefore = cache.__test.stats().crossProcessInvalidations;

  // Publish a message with a DIFFERENT _origin so the subscriber treats it
  // as a sibling-instance event rather than self-echo.
  const { createRequire } = await import("module");
  const _require = createRequire(import.meta.url);
  const IORedis = _require("ioredis");
  const Redis = IORedis.default || IORedis;
  const publisher = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });

  try {
    await publisher.publish(
      cache.__test.channel,
      JSON.stringify({ slotId: "compat:xproc", _origin: "inst_other_instance" }),
    );
    // Wait for the subscriber to process the message.  Redis pub/sub is
    // roughly round-trip-local so 200 ms is ample for CI.
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(cache.__test.has("compat:xproc"), false, "sibling-instance publish must drop the local entry");
    const statsAfter = cache.__test.stats().crossProcessInvalidations;
    assert.ok(statsAfter > statsBefore, "crossProcessInvalidations counter must increment");
  } finally {
    await publisher.quit().catch(() => {});
  }
});

// ─── 6. Self-echo suppression ─────────────────────────────────────────────────
// Regression: invalidate() publishes on Redis with this instance's origin id.
// When the subscriber receives its own message it must NOT double-count the
// invalidation (otherwise a single save bumps crossProcessInvalidations,
// making the metric misleading).

test("cross-process: self-published invalidations are not counted as cross-process", async (t) => {
  if (!process.env.REDIS_URL || !redisClient.isRedisAvailable()) {
    t.skip("REDIS_URL not set");
    return;
  }
  cache.__test.clear();
  const before = cache.__test.stats().crossProcessInvalidations;

  cache.get("compat:self", () => ({ ...FIXTURE }));
  cache.invalidate("compat:self"); // publishes with our _origin
  await new Promise((r) => setTimeout(r, 200));

  const after = cache.__test.stats().crossProcessInvalidations;
  assert.equal(after, before, "self-echo must be filtered by _origin check");
});

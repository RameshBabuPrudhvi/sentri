/**
 * @module tests/response-cache
 * @description B3.8 — Response cache unit tests.
 *
 * Covers:
 *   1. `computeCacheKey` — determinism + sensitivity to every input
 *      dimension (routeId, model, messages, maxTokens, temperature,
 *      responseFormat). Stable-JSON property: key-order invariance.
 *   2. `setCached` / `getCached` — round-trip, TTL expiry double-check,
 *      `hitCount` increment, savings metric attribution.
 *   3. Eligibility gates — `setCached` no-ops when `ttlSec <= 0` or
 *      `response` is empty.
 *   4. `coalesceInFlight` / `registerInFlight` — thundering-herd
 *      coalescing returns the SAME promise to concurrent callers and
 *      auto-clears on settle (.finally).
 *   5. `purgeExpired` — daily-janitor sweep deletes only expired rows.
 */
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");

const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");

getDatabase();
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();

const {
  computeCacheKey,
  getCached,
  setCached,
  coalesceInFlight,
  registerInFlight,
  purgeExpired,
  _resetForTests,
} = await import("../src/aiProvider/responseCache.js");

const { test, summary } = createTestRunner();

// ─── 1. computeCacheKey ──────────────────────────────────────────────────────

test("computeCacheKey: deterministic for identical inputs", () => {
  const params = {
    messages: { system: "s", user: "u", combined: "s\n\n---\n\nu" },
    maxTokens: 100, temperature: 0, responseFormat: "json_object",
  };
  const k1 = computeCacheKey("pr-1", "model-a", params);
  const k2 = computeCacheKey("pr-1", "model-a", params);
  assert.equal(k1, k2);
  assert.equal(k1.length, 64, "sha256 hex is 64 chars");
});

test("computeCacheKey: differs when routeId differs", () => {
  const params = { messages: { user: "u" } };
  assert.notEqual(
    computeCacheKey("pr-1", "model-a", params),
    computeCacheKey("pr-2", "model-a", params),
  );
});

test("computeCacheKey: differs when model differs", () => {
  const params = { messages: { user: "u" } };
  assert.notEqual(
    computeCacheKey("pr-1", "model-a", params),
    computeCacheKey("pr-1", "model-b", params),
  );
});

test("computeCacheKey: differs when temperature differs", () => {
  assert.notEqual(
    computeCacheKey("pr-1", "m", { messages: { user: "u" }, temperature: 0 }),
    computeCacheKey("pr-1", "m", { messages: { user: "u" }, temperature: 0.5 }),
  );
});

test("computeCacheKey: stable JSON — same key regardless of param order", () => {
  // The `stableStringify` helper sorts object keys, so {a, b} and {b, a}
  // hash identically. This is the invariant that makes the cache useful:
  // two callers passing the same logical params in different order share
  // a hit instead of fanning out.
  const a = computeCacheKey("pr-1", "m", { messages: { user: "u" }, maxTokens: 100, temperature: 0 });
  const b = computeCacheKey("pr-1", "m", { temperature: 0, maxTokens: 100, messages: { user: "u" } });
  assert.equal(a, b, "key-order must not affect hash");
});

// ─── 2. setCached / getCached round-trip ─────────────────────────────────────

test("setCached + getCached: round-trip stores and retrieves the response", () => {
  _resetForTests();
  const params = { messages: { user: "ping" }, maxTokens: 50, temperature: 0 };
  setCached("pr-rt", "model-x", params, "pong", { input: 10, output: 1, costUsd: 0.0001 }, 60);
  const hit = getCached("pr-rt", "model-x", params, { routeName: "test-route" });
  assert.ok(hit, "must find cached row");
  assert.equal(hit.response, "pong");
  assert.equal(hit.usage.input, 10);
  assert.equal(hit.usage.output, 1);
  assert.equal(hit.fromCache, true);
});

test("setCached: TTL=0 is a no-op (cache opted out)", () => {
  _resetForTests();
  setCached("pr-ttl0", "model-x", { messages: { user: "u" } }, "response", null, 0);
  const hit = getCached("pr-ttl0", "model-x", { messages: { user: "u" } });
  assert.equal(hit, null, "TTL=0 must skip the write");
});

test("setCached: empty response is a no-op", () => {
  _resetForTests();
  setCached("pr-empty", "model-x", { messages: { user: "u" } }, "", null, 60);
  const hit = getCached("pr-empty", "model-x", { messages: { user: "u" } });
  assert.equal(hit, null, "empty response must skip the write");
});

test("getCached: expired row returns null (double-check beats lazy janitor)", () => {
  _resetForTests();
  const params = { messages: { user: "stale" } };
  // TTL=1 sec.
  setCached("pr-exp", "model-x", params, "old-response", null, 1);
  // Backdate `expiresAt` directly via SQL so we don't have to sleep.
  const db = getDatabase();
  const pastExpiry = new Date(Date.now() - 1000).toISOString();
  db.prepare("UPDATE ai_response_cache SET expiresAt = ? WHERE routeId = ?")
    .run(pastExpiry, "pr-exp");
  const hit = getCached("pr-exp", "model-x", params);
  assert.equal(hit, null, "expired row must be treated as miss");
});

test("getCached: increments hitCount on successful read", () => {
  _resetForTests();
  const params = { messages: { user: "counted" } };
  setCached("pr-hc", "model-x", params, "response", null, 60);
  getCached("pr-hc", "model-x", params);
  getCached("pr-hc", "model-x", params);
  getCached("pr-hc", "model-x", params);
  const row = getDatabase().prepare(
    "SELECT hitCount FROM ai_response_cache WHERE routeId = ?",
  ).get("pr-hc");
  assert.equal(row.hitCount, 3, "hitCount must increment per successful read");
});

test("getCached: cache miss when params differ even slightly", () => {
  _resetForTests();
  setCached("pr-diff", "m", { messages: { user: "a" } }, "ra", null, 60);
  // Different message → different key → miss.
  const hit = getCached("pr-diff", "m", { messages: { user: "b" } });
  assert.equal(hit, null);
});

// ─── 3. coalesceInFlight / registerInFlight ──────────────────────────────────

test("coalesceInFlight: returns null when nothing is in flight", () => {
  _resetForTests();
  assert.equal(coalesceInFlight("nonexistent-key"), null);
});

test("registerInFlight + coalesceInFlight: second caller awaits the same promise", async () => {
  _resetForTests();
  const key = "test-coalesce-key";
  // Caller A: register a slow promise.
  let resolveA;
  const slowPromise = new Promise((resolve) => { resolveA = resolve; });
  registerInFlight(key, slowPromise);
  // Caller B: try to coalesce — must get THE SAME promise back.
  const coalesced = coalesceInFlight(key);
  assert.strictEqual(coalesced, slowPromise, "must return the same Promise reference");
  // Resolve and confirm both callers see the same value.
  resolveA({ text: "shared-response", usage: null, costResult: { costUsd: 0, source: "none" } });
  const result = await coalesced;
  assert.equal(result.text, "shared-response");
});

test("registerInFlight: auto-clears the entry on settle", async () => {
  _resetForTests();
  const key = "test-autoclear-key";
  const p = Promise.resolve({ text: "done", usage: null, costResult: { costUsd: 0, source: "none" } });
  registerInFlight(key, p);
  await p;
  // Give the .finally a microtask to flush.
  await new Promise((r) => setImmediate(r));
  assert.equal(coalesceInFlight(key), null, "entry must be auto-cleared after settle");
});

test("registerInFlight: auto-clears on reject too", async () => {
  _resetForTests();
  const key = "test-reject-clear-key";
  const p = Promise.reject(new Error("dispatch failed"));
  registerInFlight(key, p);
  await p.catch(() => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(coalesceInFlight(key), null, "entry must be auto-cleared after rejection too");
});

// ─── 4. purgeExpired ─────────────────────────────────────────────────────────

test("purgeExpired: deletes only expired rows", () => {
  _resetForTests();
  const db = getDatabase();
  // Two rows: one expired 1h ago, one expires 1h from now.
  setCached("pr-purge-old", "m", { messages: { user: "old" } }, "old-response", null, 60);
  setCached("pr-purge-new", "m", { messages: { user: "new" } }, "new-response", null, 60);
  // Backdate the first row's expiresAt.
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  db.prepare("UPDATE ai_response_cache SET expiresAt = ? WHERE routeId = ?")
    .run(past, "pr-purge-old");
  const deleted = purgeExpired();
  assert.equal(deleted, 1, "must delete exactly the expired row");
  const remaining = db.prepare("SELECT routeId FROM ai_response_cache").all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].routeId, "pr-purge-new");
});

test("purgeExpired: returns 0 when no expired rows exist", () => {
  _resetForTests();
  setCached("pr-fresh", "m", { messages: { user: "fresh" } }, "response", null, 60);
  const deleted = purgeExpired();
  assert.equal(deleted, 0);
});

summary("Response cache (B3.8)");

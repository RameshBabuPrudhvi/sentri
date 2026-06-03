/**
 * @module aiProvider/responseCache
 * @description B3.8 — Exact-match LLM response cache, scoped per
 *   `provider_routes` row. Returns a previously-stored response for
 *   identical prompt + params on cache-enabled routes without
 *   dispatching to the provider.
 *
 * ## Cache key
 *
 * `sha256(routeId + model + stableJSON({messages, maxTokens,
 * temperature, responseFormat}))` — every input that meaningfully
 * changes the LLM's output is hashed. Excluded from the key:
 *   • `signal` (AbortSignal — call-time, not deterministic)
 *   • `agentRole` (label only, never reaches the model)
 *   • `workspaceId` / `userId` (telemetry, not LLM input)
 *
 * Stable JSON serialisation (sorted keys) so `{a:1, b:2}` and
 * `{b:2, a:1}` hash identically.
 *
 * ## Thundering-herd protection
 *
 * Identical concurrent misses coalesce: the first caller dispatches,
 * the rest await the same Promise. When that Promise resolves, all
 * callers receive the same response and the cache is populated once.
 * Implemented as an in-flight `Map<cacheKey, Promise>` — keys clear
 * automatically on resolve/reject so a long-running call can't pin
 * memory after completion.
 *
 * ## What we DON'T cache
 *
 *   • Streaming calls (`streamText`) — caller MUST skip the cache,
 *     this module silently no-ops if accidentally invoked from a
 *     streaming path because we have nothing useful to assemble.
 *   • Calls with explicit `skipCache: true` — per-call opt-out.
 *   • Routes with `cacheEnabled = 0` (default) — opt-in only.
 *
 * ## Eviction
 *
 * TTL only — no LRU. Expired rows are swept by the daily janitor in
 * `scheduler.js`. `getCached` ALSO double-checks expiry on every read
 * so a hit on an expired row never returns stale data even if the
 * janitor hasn't run yet.
 */
import crypto from "crypto";
import { getDatabase } from "../database/sqlite.js";
import {
  aiCacheHitsTotal,
  aiCacheMissesTotal,
  aiCacheSavingsUsdTotal,
} from "../utils/metrics.js";

// In-flight coalescing — keyed by cacheKey, value is the Promise the
// first caller is awaiting. Multiple concurrent callers for the same
// key share the dispatch; secondary callers never duplicate the
// vendor call.
const inFlight = new Map();

/**
 * Stable JSON: sort object keys recursively so equivalent objects
 * with different key order serialise to the same bytes. Arrays keep
 * their order (semantically meaningful — message ordering matters).
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Compute the cache key for a single dispatch call. Exported for tests
 * that want to verify hashing determinism without going through the
 * full DB roundtrip.
 *
 * @param {string} routeId
 * @param {string} model
 * @param {Object} params - `{ messages, maxTokens, temperature, responseFormat }`
 * @returns {string} 64-hex-char SHA-256.
 */
export function computeCacheKey(routeId, model, params = {}) {
  const canonical = stableStringify({
    messages: params.messages ?? null,
    maxTokens: params.maxTokens ?? null,
    temperature: params.temperature ?? null,
    responseFormat: params.responseFormat ?? null,
  });
  return crypto
    .createHash("sha256")
    .update(`${routeId}::${model}::${canonical}`)
    .digest("hex");
}

/**
 * Look up a cached response. Returns `null` on miss / disabled / expired.
 *
 * Increments `hitCount` on every successful read so operators can see
 * which entries are actually paying their keep. Double-checks `expiresAt`
 * even though the janitor sweeps expired rows daily — a row that
 * expires between janitor runs MUST NOT be returned as a hit.
 *
 * Token-savings metric: when the cache hit replaces a call that would
 * have cost `costUsd`, we increment `aiCacheSavingsUsdTotal` by the
 * STORED cost so dashboards can show "we saved $X this hour from
 * cache". The stored `usage` carries `costUsd` from the original
 * dispatch.
 *
 * @param {string} routeId
 * @param {string} model
 * @param {Object} params
 * @param {Object} [labels] - For metrics: `{ agentRole?: string, routeName?: string }`.
 * @returns {Object|null} `{ response, usage, fromCache: true }` on hit, `null` on miss.
 */
export function getCached(routeId, model, params, labels = {}) {
  if (!routeId || !model) return null;
  const cacheKey = computeCacheKey(routeId, model, params);
  try {
    const db = getDatabase();
    const row = db.prepare(
      "SELECT response, usage, expiresAt FROM ai_response_cache WHERE cacheKey = ?",
    ).get(cacheKey);
    if (!row) {
      try {
        aiCacheMissesTotal.inc({
          route_name: labels.routeName || "unknown",
          agent_role: labels.agentRole || "default",
        });
      } catch { /* best-effort metric */ }
      return null;
    }
    // Expiry double-check. The janitor runs daily; rows that expire
    // between runs are filtered here so callers never see stale data.
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      try {
        aiCacheMissesTotal.inc({
          route_name: labels.routeName || "unknown",
          agent_role: labels.agentRole || "default",
        });
      } catch { /* best-effort metric */ }
      return null;
    }
    // Increment hitCount in the same query path. Best-effort — a
    // tracking failure must not fail the cache hit.
    try {
      db.prepare("UPDATE ai_response_cache SET hitCount = hitCount + 1 WHERE cacheKey = ?").run(cacheKey);
    } catch { /* best-effort */ }
    let usage = null;
    if (row.usage) {
      try { usage = JSON.parse(row.usage); } catch { /* malformed JSON — ignore */ }
    }
    try {
      aiCacheHitsTotal.inc({
        route_name: labels.routeName || "unknown",
        agent_role: labels.agentRole || "default",
      });
      const savedCost = Number(usage?.costUsd);
      if (Number.isFinite(savedCost) && savedCost > 0) {
        aiCacheSavingsUsdTotal.inc({
          route_name: labels.routeName || "unknown",
          agent_role: labels.agentRole || "default",
        }, savedCost);
      }
    } catch { /* best-effort metric */ }
    return { response: row.response, usage, fromCache: true };
  } catch {
    // DB unavailable — fail OPEN. Cache is best-effort; an outage
    // shouldn't block dispatch.
    return null;
  }
}

/**
 * Persist a response. Skips silently when `ttlSec <= 0` (route opted
 * out of caching) or when `response` is empty (nothing useful to
 * cache). Uses INSERT OR REPLACE so a second writer overwrites cleanly.
 *
 * @param {string} routeId
 * @param {string} model
 * @param {Object} params
 * @param {string} response
 * @param {Object} usage - `{ input, output, costUsd }` — the costUsd
 *   field powers the cache-savings metric on subsequent hits.
 * @param {number} ttlSec - From `provider_routes.cacheTtlSec`. <= 0 disables.
 */
export function setCached(routeId, model, params, response, usage, ttlSec) {
  if (!routeId || !model || !response) return;
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) return;
  const cacheKey = computeCacheKey(routeId, model, params);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSec * 1000).toISOString();
  try {
    // SQLite's `INSERT OR REPLACE` is delete-then-insert semantics: the
    // conflicting row is DELETED before the VALUES clause evaluates, so
    // a `COALESCE((SELECT hitCount FROM ... WHERE cacheKey = ?), 0)`
    // subquery in the values list ALWAYS sees zero — the row we'd be
    // reading from is already gone. The hitCount counter therefore
    // resets to 0 on every cache refresh, defeating the
    // "which entries are actually paying their keep" observability
    // contract. Use `INSERT ... ON CONFLICT(cacheKey) DO UPDATE`
    // (UPSERT) instead — supported on SQLite ≥ 3.24 and PostgreSQL.
    // The UPDATE clause omits `hitCount` so the existing column value
    // survives the upsert. New rows get `hitCount = 0` from the
    // VALUES list; upserts preserve whatever value `getCached`
    // accumulated.
    getDatabase().prepare(
      "INSERT INTO ai_response_cache (cacheKey, routeId, response, usage, createdAt, expiresAt, hitCount) " +
      "VALUES (?, ?, ?, ?, ?, ?, 0) " +
      "ON CONFLICT(cacheKey) DO UPDATE SET " +
      "  routeId = excluded.routeId, " +
      "  response = excluded.response, " +
      "  usage = excluded.usage, " +
      "  createdAt = excluded.createdAt, " +
      "  expiresAt = excluded.expiresAt",
    ).run(
      cacheKey,
      routeId,
      response,
      usage ? JSON.stringify(usage) : null,
      now.toISOString(),
      expiresAt,
    );
  } catch { /* DB unavailable — best-effort */ }
}

/**
 * Thundering-herd protection: returns the existing in-flight Promise
 * for a key when one is active, or registers a new Promise that
 * auto-clears the entry on settle.
 *
 * Caller pattern:
 *   const existing = coalesceInFlight(key);
 *   if (existing) return existing;
 *   const p = dispatchAndCache();
 *   registerInFlight(key, p);
 *   return p;
 *
 * The two-call shape (look first, then register) lets the dispatcher
 * decide whether to actually run the LLM call OR await another caller's
 * in-flight promise. We don't expose a single `getOrCreate` because
 * the dispatcher needs to do work between the lookup and the register
 * (cache lookup, gate checks, building adapter opts, etc.) before
 * starting the dispatch promise.
 */
export function coalesceInFlight(cacheKey) {
  return inFlight.get(cacheKey) || null;
}

export function registerInFlight(cacheKey, promise) {
  inFlight.set(cacheKey, promise);
  // Auto-clear on settle so a long-running call doesn't pin memory
  // after completion. `.finally` is universally supported in
  // Node 16+ (the project's minimum).
  //
  // Bug-fix: the `.finally(...)` chain returns a NEW promise that
  // rebroadcasts the original rejection. If the caller's only
  // consumer of `promise` is `coalesceInFlight()` followed by an
  // `await` (the canonical pattern), the original rejection is
  // handled — but the .finally-returned promise is NOT, and Node
  // 20's strict-by-default unhandledRejection tracker flags it.
  // The chained `.catch(() => {})` is a no-op handler that exists
  // purely to acknowledge the rebroadcast rejection. The cleanup
  // semantics are unchanged because the cleanup ran inside the
  // .finally itself; the chained .catch only swallows the
  // re-thrown error from the .finally rebroadcast.
  promise.finally(() => {
    if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
  }).catch(() => { /* see comment above — swallow rebroadcast */ });
}

/**
 * Janitor — sweep expired rows. Called from the daily scheduler task.
 * Returns the number of rows deleted for log correlation.
 */
export function purgeExpired() {
  try {
    const result = getDatabase().prepare(
      "DELETE FROM ai_response_cache WHERE expiresAt < ?",
    ).run(new Date().toISOString());
    return result.changes || 0;
  } catch {
    return 0;
  }
}

// ── Test seam ─────────────────────────────────────────────────────────────────
/**
 * Test-only — wipe in-memory coalescing state and the cache table.
 * Never call from product code.
 * @internal
 */
export function _resetForTests() {
  inFlight.clear();
  try { getDatabase().prepare("DELETE FROM ai_response_cache").run(); } catch { /* ignore */ }
}
-- B3.8 — Exact-match AI response cache.
--
-- Caches deterministic LLM responses keyed by the SHA-256 of
-- `routeId + model + stableJSON({messages, maxTokens, temperature,
-- responseFormat})`. Identical prompts on cache-enabled routes return
-- the stored body without dispatching to the provider — the single
-- biggest spend reduction available at the dispatch layer for batch
-- workflows that re-run the same generation calls (test re-runs,
-- self-healing retries on the same selector, etc.).
--
-- ## What we DON'T cache
--
--   • Streaming calls — the cache stores the assembled response, not
--     the SSE event stream. `streamText` skips the cache entirely.
--   • Non-deterministic calls — the cache key includes `temperature`,
--     so a route with `temperature: 0.7` produces different cache keys
--     than `temperature: 0.0`. Operators who want maximum hit rate run
--     deterministic (T=0) calls.
--   • Calls with `skipCache: true` — used by self-healing where stale
--     answers are dangerous. Per-call opt-out at the dispatch boundary.
--
-- ## Janitor
--
-- A daily scheduler task (`scheduler.js`) runs
-- `DELETE FROM ai_response_cache WHERE expiresAt < datetime('now')`.
-- The `idx_cache_expires` index keeps the delete O(log n) per row
-- regardless of total cache size.
--
-- ## Schema notes
--
--   • `cacheKey` is the PK so re-inserts trivially upsert (`INSERT OR
--     REPLACE`). 64-hex-char SHA-256 — fixed-size and collision-safe
--     for a workspace's lifetime.
--   • `usage` is JSON-serialised `{input, output}` so a cache hit can
--     still emit token telemetry against the original counts. Without
--     it, every cache hit would show 0 tokens in dashboards and skew
--     unit-economics math.
--   • `hitCount` is incremented on every read so operators can see
--     which entries are actually paying their keep — janitor candidates
--     for eviction policies bigger than TTL (B4 territory).
--   • No `workspaceId` column — the cache is scoped per route, and
--     `routeId` is workspace-scoped via `provider_routes.workspaceId`.
--     Cross-workspace cache hits are impossible because `cacheKey`
--     incorporates `routeId` directly.
--
-- ## Compatibility
--
-- SQLite + PostgreSQL both accept the bare CREATE TABLE syntax. No FK
-- on `routeId` — when a route is deleted, its cache rows are orphaned
-- and the janitor sweeps them naturally on TTL. Adding an FK with ON
-- DELETE CASCADE would force a row-by-row cascade on bulk route
-- deletion that the dispatcher has no reason to wait for.

CREATE TABLE IF NOT EXISTS ai_response_cache (
  cacheKey TEXT PRIMARY KEY,
  routeId TEXT NOT NULL,
  response TEXT NOT NULL,
  usage TEXT,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  hitCount INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cache_expires ON ai_response_cache(expiresAt);
CREATE INDEX IF NOT EXISTS idx_cache_route ON ai_response_cache(routeId);

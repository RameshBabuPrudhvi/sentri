/**
 * @module pipeline/sourceMapResolver
 * @description AUTO-009b — Source-map resolver for browser JS coverage.
 *
 * Fetches `<bundleUrl>.map` (or `<sourcemapBaseUrl>/<filename>.map`),
 * parses with `source-map@^0.7`, and maps bundle (line, column) coordinates
 * back to original source paths/lines so `coverageAggregator`'s
 * `topUncoveredFiles[]` surface `src/foo/bar.ts:42` instead of bundled
 * coordinates.
 *
 * ### Design constraints
 * - **Best-effort only.** Every resolver path is wrapped in try/catch and
 *   returns `null` on any failure. Coverage capture must NEVER fail a run.
 * - **SSRF-guarded.** The fetch URL is validated via `utils/ssrfGuard.js`
 *   so an attacker-controlled `project.sourcemapBaseUrl` can't probe
 *   private networks / cloud metadata.
 * - **LRU cache.** Maps can be 20MB+ so per-test fetches would blow up the
 *   wall-clock budget. The cache is keyed on `bundleUrl + etag` with a 10MB
 *   cap and 1h TTL — entries evict LRU-style once the cap is hit, and TTL
 *   expiry happens lazily on lookup.
 *
 * ### Exports
 * - {@link resolveSourceMap} — fetch + parse a source map for a bundle URL.
 * - {@link mapBundleLine}    — translate a (line, column) into an original
 *                              `{ source, line, column, name }`.
 * - {@link __resetCacheForTest} — test-only cache reset.
 */

import { SourceMapConsumer } from "source-map";
import { validateUrl, safeFetch } from "../utils/ssrfGuard.js";
import { formatLogLine } from "../utils/logFormatter.js";

// ─── LRU cache ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000;          // 1h
const CACHE_MAX_BYTES = 10 * 1024 * 1024;     // 10MB
const FETCH_TIMEOUT_MS = 10_000;

/** @type {Map<string, { consumer: SourceMapConsumer, bytes: number, expiresAt: number, etag: string|null }>} */
const cache = new Map();
let cacheBytes = 0;

function cacheKey(bundleUrl, etag) {
  return `${bundleUrl}::${etag || ""}`;
}

// Cache entries can be referenced under two keys (the etag-keyed canonical
// entry and an alias under the etag-less probe key — see `resolveSourceMap`
// below). `entry.aliasCount` tracks how many keys still point at this
// entry so `bytes` are only deducted from `cacheBytes` once when the LAST
// alias is removed, and `consumer.destroy()` is only invoked at the same
// moment. Without this, an etag-published entry would double-count bytes
// (forcing premature evictions) and a single eviction would destroy the
// consumer while a sibling key still pointed at it.
function disposeEntryRef(entry) {
  entry.aliasCount = (entry.aliasCount || 1) - 1;
  if (entry.aliasCount <= 0) {
    try { entry.consumer.destroy?.(); } catch { /* best-effort */ }
    cacheBytes -= entry.bytes;
  }
}

function evictExpired() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      disposeEntryRef(entry);
      cache.delete(key);
    }
  }
}

function evictToFit(targetBytes) {
  // Map iteration is insertion-ordered → oldest first → LRU eviction
  // (`touch()` re-inserts to move an entry to the tail).
  for (const [key, entry] of cache) {
    if (cacheBytes + targetBytes <= CACHE_MAX_BYTES) break;
    disposeEntryRef(entry);
    cache.delete(key);
  }
}

function touch(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function deriveMapUrl(bundleUrl, sourcemapBaseUrl) {
  try {
    if (sourcemapBaseUrl) {
      const fname = new URL(bundleUrl).pathname.split("/").pop() || "";
      if (!fname) return null;
      const base = sourcemapBaseUrl.endsWith("/") ? sourcemapBaseUrl : sourcemapBaseUrl + "/";
      return new URL(`${fname}.map`, base).toString();
    }
    return `${bundleUrl}.map`;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch and parse the source map for a bundle URL.
 *
 * @param {string}            bundleUrl
 * @param {Object}            [opts]
 * @param {string|null}       [opts.sourcemapBaseUrl] — optional CDN base for `.map` files.
 * @returns {Promise<SourceMapConsumer|null>} consumer, or null on any failure.
 */
export async function resolveSourceMap(bundleUrl, { sourcemapBaseUrl } = {}) {
  try {
    evictExpired();
    const mapUrl = deriveMapUrl(bundleUrl, sourcemapBaseUrl);
    if (!mapUrl) return null;

    // Cache probe runs BEFORE the SSRF validation so cache hits avoid the
    // async DNS resolution cost (`validateUrl` does network DNS lookups
    // on every call — see `utils/ssrfGuard.js`). The resolver is called
    // once per unique bundle URL per test, so cache hits dominate steady
    // state and paying DNS on each one would defeat the LRU cache's
    // stated 1× fetch budget. The probe is a pure Map lookup — safe to
    // run before any validation. The fetch path below still runs SSRF
    // validation before any network I/O, so an attacker-controlled
    // `sourcemapBaseUrl` cannot probe internal addresses through this
    // resolver. DNS rebinding between PATCH and runtime is mitigated by
    // `safeFetch` itself (re-resolves DNS, blocks redirects to internal).
    const probeKey = cacheKey(bundleUrl, null);
    const probe = cache.get(probeKey);
    if (probe && probe.expiresAt > Date.now()) {
      touch(probeKey, probe);
      return probe.consumer;
    }

    // SSRF: validate before fetch. Reject loopback / private / metadata IPs.
    // Only runs on cache miss so steady-state cache hits stay free.
    const ssrfErr = await validateUrl(mapUrl);
    if (ssrfErr) {
      console.warn(formatLogLine("warn", null, `[sourceMapResolver] SSRF rejected ${mapUrl}: ${ssrfErr}`));
      return null;
    }

    const res = await safeFetch(mapUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(formatLogLine("warn", null, `[sourceMapResolver] ${mapUrl} → HTTP ${res.status}`));
      return null;
    }
    const etag = res.headers.get("etag");
    if (etag) {
      const etagKey = cacheKey(bundleUrl, etag);
      const hit = cache.get(etagKey);
      if (hit && hit.expiresAt > Date.now()) {
        touch(etagKey, hit);
        return hit.consumer;
      }
    }
    const body = await res.text();
    const bytes = Buffer.byteLength(body, "utf8");
    let raw;
    try { raw = JSON.parse(body); } catch (parseErr) {
      console.warn(formatLogLine("warn", null, `[sourceMapResolver] ${mapUrl} parse failed: ${parseErr.message}`));
      return null;
    }
    let consumer;
    try {
      consumer = await new SourceMapConsumer(raw);
    } catch (consumerErr) {
      console.warn(formatLogLine("warn", null, `[sourceMapResolver] ${mapUrl} SourceMapConsumer failed: ${consumerErr.message}`));
      return null;
    }

    evictToFit(bytes);
    const entry = {
      consumer, bytes,
      expiresAt: Date.now() + CACHE_TTL_MS,
      etag: etag || null,
      // Refcount — bumped to 2 below when we publish a second alias under
      // the probe key. `disposeEntryRef` decrements per evicted key and
      // only frees `bytes` / destroys the consumer when the last alias
      // goes. See the rationale comment on `disposeEntryRef`.
      aliasCount: 1,
    };
    cacheBytes += bytes;
    cache.set(cacheKey(bundleUrl, etag), entry);
    // Also publish under the etag-less probe key so the next call hits the
    // fast-path lookup above (lines 115-120) without re-fetching. Without
    // this, every CDN-served map (which nearly always carries an ETag)
    // would be re-downloaded per call because the probe key is
    // `bundleUrl::` while the storage key is `bundleUrl::W/"abc"` — the
    // mismatch defeats the LRU cache's stated 1× fetch budget.
    if (etag) {
      entry.aliasCount += 1;
      cache.set(cacheKey(bundleUrl, null), entry);
    }
    return consumer;
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[sourceMapResolver] ${bundleUrl}: ${err?.message || err}`));
    return null;
  }
}

/**
 * Translate a (line, column) bundle coordinate to the original source.
 *
 * @param {SourceMapConsumer} consumer
 * @param {number}            line   - 1-based bundle line.
 * @param {number}            [column=0]
 * @returns {{ source: string, line: number, column: number, name: string|null }|null}
 */
export function mapBundleLine(consumer, line, column = 0) {
  if (!consumer || typeof consumer.originalPositionFor !== "function") return null;
  try {
    const pos = consumer.originalPositionFor({ line, column });
    if (!pos || !pos.source || pos.line == null) return null;
    return { source: pos.source, line: pos.line, column: pos.column ?? 0, name: pos.name || null };
  } catch {
    return null;
  }
}

/** Test-only cache reset. Walks unique entries (de-aliased) so a consumer
 *  shared between the etag-keyed and etag-less probe keys is destroyed only
 *  once. */
export function __resetCacheForTest() {
  const seen = new Set();
  for (const entry of cache.values()) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    try { entry.consumer.destroy?.(); } catch { /* best-effort */ }
  }
  cache.clear();
  cacheBytes = 0;
}

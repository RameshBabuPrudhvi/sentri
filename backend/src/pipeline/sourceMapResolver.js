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

function evictExpired() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      try { entry.consumer.destroy?.(); } catch { /* best-effort */ }
      cacheBytes -= entry.bytes;
      cache.delete(key);
    }
  }
}

function evictToFit(targetBytes) {
  // Map iteration is insertion-ordered → oldest first → LRU eviction
  // (`touch()` re-inserts to move an entry to the tail).
  for (const [key, entry] of cache) {
    if (cacheBytes + targetBytes <= CACHE_MAX_BYTES) break;
    try { entry.consumer.destroy?.(); } catch { /* best-effort */ }
    cacheBytes -= entry.bytes;
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

    // SSRF: validate before fetch. Reject loopback / private / metadata IPs.
    const ssrfErr = await validateUrl(mapUrl);
    if (ssrfErr) {
      console.warn(formatLogLine("warn", null, `[sourceMapResolver] SSRF rejected ${mapUrl}: ${ssrfErr}`));
      return null;
    }

    // Cache lookup uses bundleUrl as the primary key; we don't know the etag
    // until after we've HEAD/GET'd. Try an etag-less hit first for cheap reuse.
    const probeKey = cacheKey(bundleUrl, null);
    const probe = cache.get(probeKey);
    if (probe && probe.expiresAt > Date.now()) {
      touch(probeKey, probe);
      return probe.consumer;
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
    const entry = { consumer, bytes, expiresAt: Date.now() + CACHE_TTL_MS, etag: etag || null };
    cacheBytes += bytes;
    cache.set(cacheKey(bundleUrl, etag), entry);
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

/** Test-only cache reset. */
export function __resetCacheForTest() {
  for (const entry of cache.values()) {
    try { entry.consumer.destroy?.(); } catch { /* best-effort */ }
  }
  cache.clear();
  cacheBytes = 0;
}

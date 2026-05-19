/**
 * @module pipeline/finalizeCoverage
 * @description AUTO-009f — single source of truth for the post-run coverage
 * aggregation tail. Called from BOTH `testRunner.js` (single-process /
 * legacy path) AND `workers/runWorker.js#finalizeShardedRun` (CAP-002 shard
 * coordinator) so multi-shard runs get the same `coverageSummary` shape as
 * single-shard runs. Previous behaviour: only `testRunner.js` ran the
 * aggregator, so every sharded run with `coverageEnabled` persisted
 * `coverageSummary: null` and the Dashboard panel never rendered for them.
 *
 * Also owns AUTO-009g memory-ceiling enforcement: drops raw `jsCoverage`
 * blobs from `run.results` AFTER aggregation so the persisted runs.results
 * column stays lean (raw V8 ranges can be 10s of MB per test on big bundles).
 * Soft cap via `COVERAGE_MEMORY_CEILING_MB` (default 500) — if cumulative raw
 * payload size exceeds the cap, aggregation still runs against the in-memory
 * Set we already built up to that point, but `coverageSummary.truncated = true`
 * marks the result for UI display.
 *
 * ### Inputs
 *
 * `results[]` — full per-test results set with `result.jsCoverage` blobs
 * attached (single-process path) OR a synthesised payload re-hydrated by
 * the finalizer reading from `runs.results` JSON column (shard path).
 *
 * `project.coverageEnabled` gates the whole pipeline. `project.sourcemapBaseUrl`
 * feeds AUTO-009b source-map resolution.
 *
 * ### Contract
 *
 * - Returns the `coverageSummary` object to assign to `run.coverageSummary`,
 *   or `null` when coverage is disabled / aggregation failed.
 * - MUTATES `results[]` to delete `jsCoverage` blobs in place — heavy raw
 *   payloads must not persist to the `runs.results` JSON column. Callers
 *   that care about the deletion happening before they persist should call
 *   this helper BEFORE their final `runRepo.save(run)` / `runRepo.update`.
 * - Best-effort: never throws. A converter / resolver crash logs a warning
 *   and falls back to `null`.
 *
 * @example
 *   // single-process — testRunner.js tail
 *   run.coverageSummary = await finalizeCoverage(project, run.results);
 *
 *   // sharded finalizer — workers/runWorker.js finalizeShardedRun
 *   const fresh = runRepo.getById(runId);
 *   run.coverageSummary = await finalizeCoverage(project, fresh.results);
 *   runRepo.update(runId, { coverageSummary: run.coverageSummary });
 */

import { aggregateRunCoverage } from "./coverageAggregator.js";
import { resolveSourceMap, mapBundleLine } from "./sourceMapResolver.js";
import { formatLogLine } from "../utils/logFormatter.js";

/**
 * Hard memory ceiling for cumulative raw `jsCoverage` payload size, in MB.
 * Beyond this, raw payloads are dropped from `results[]` BEFORE aggregation
 * runs against the tail — the aggregator sees fewer entries but the run
 * doesn't OOM on a 1000-test suite against a 5MB bundle. Default 500MB; tune
 * via `COVERAGE_MEMORY_CEILING_MB` env. AUTO-009g.
 */
const COVERAGE_MEMORY_CEILING_MB = (() => {
  const raw = Number(process.env.COVERAGE_MEMORY_CEILING_MB);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 500;
})();
const COVERAGE_MEMORY_CEILING_BYTES = COVERAGE_MEMORY_CEILING_MB * 1024 * 1024;

/**
 * Approximate the byte cost of one Playwright V8 coverage entry without
 * stringifying — we only need a stable upper bound for the ceiling check,
 * not byte-accurate sizing. `text.length` is the dominant cost (script
 * source can be MBs); `ranges.length * 24` covers the {start,end,count}
 * triples.
 *
 * @param {Object} entry
 * @returns {number}
 */
function approxEntryBytes(entry) {
  if (!entry || typeof entry !== "object") return 0;
  const textBytes = typeof entry.text === "string" ? entry.text.length : 0;
  const rangeBytes = Array.isArray(entry.ranges) ? entry.ranges.length * 24 : 0;
  return textBytes + rangeBytes;
}

/**
 * Single source of truth for the post-run coverage tail.
 *
 * @param {Object|null} project - The (env-scoped) project. `null` is treated
 *   as "coverage disabled" so a deleted project mid-run finalises cleanly.
 * @param {Array<Object>} results - `run.results` mutated in place to strip
 *   raw `jsCoverage` blobs after aggregation.
 * @returns {Promise<Object|null>} `coverageSummary` value to persist, or null.
 */
export async function finalizeCoverage(project, results) {
  if (!project?.coverageEnabled) {
    // Strip any raw payloads regardless — defensive cleanup so a project
    // toggled OFF mid-run doesn't accidentally persist heavy in-memory blobs.
    stripRawCoverage(results);
    return null;
  }

  const sutOrigin = (() => {
    try { return new URL(project.url).origin; } catch { return ""; }
  })();

  // AUTO-009g — memory ceiling. Walk results in order; when cumulative raw
  // bytes exceed the cap, drop subsequent entries' `jsCoverage` (they
  // already landed in memory but the aggregator won't see them) and mark
  // `truncated: true` on the resulting summary. Earlier results' data is
  // preserved verbatim so the partial summary is still useful.
  let cumulativeBytes = 0;
  let truncated = false;
  for (const r of (results || [])) {
    if (!Array.isArray(r?.jsCoverage)) continue;
    let entryBytes = 0;
    for (const e of r.jsCoverage) entryBytes += approxEntryBytes(e);
    if (cumulativeBytes + entryBytes > COVERAGE_MEMORY_CEILING_BYTES) {
      r.jsCoverage = null;
      truncated = true;
    } else {
      cumulativeBytes += entryBytes;
    }
  }
  if (truncated) {
    console.warn(formatLogLine("warn", null,
      `[finalizeCoverage] Memory ceiling (${COVERAGE_MEMORY_CEILING_MB}MB) hit — some per-test coverage payloads dropped before aggregation`));
  }

  // AUTO-009b — per-run source-map resolver with its own LRU cache (10MB /
  // 1h TTL) so bundle URLs reused across tests only hit the network once.
  const sourcemapBaseUrl = project.sourcemapBaseUrl || null;
  const resolver = {
    resolve: (bundleUrl) => resolveSourceMap(bundleUrl, { sourcemapBaseUrl }),
    mapLine: (consumer, line) => mapBundleLine(consumer, line, 0),
  };

  let summary = null;
  try {
    summary = await aggregateRunCoverage(results, { sutOrigin, resolver });
    if (truncated && summary) summary.truncated = true;
  } catch (err) {
    console.warn(formatLogLine("warn", null,
      `[finalizeCoverage] aggregateRunCoverage failed: ${err?.message || err}`));
    summary = null;
  }

  // Strip raw jsCoverage AFTER aggregation so callers can persist
  // `run.results` without bloating the JSON column.
  stripRawCoverage(results);
  return summary;
}

function stripRawCoverage(results) {
  if (!Array.isArray(results)) return;
  for (const r of results) {
    if (r && "jsCoverage" in r) delete r.jsCoverage;
  }
}

/** Test-only — exported so the perf test can assert the configured ceiling. */
export const __COVERAGE_MEMORY_CEILING_BYTES_FOR_TEST = COVERAGE_MEMORY_CEILING_BYTES;

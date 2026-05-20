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
import { computePrCoverage } from "./coveragePrDiff.js"; // AUTO-009d — PR-scoped coverage diff (the Codecov play)
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
export async function finalizeCoverage(project, results, { changedFileRanges = null } = {}) {
  if (!project?.coverageEnabled) {
    // Strip any raw payloads regardless — defensive cleanup so a project
    // toggled OFF mid-run doesn't accidentally persist heavy in-memory blobs.
    stripRawCoverage(results);
    return null;
  }

  const sutOrigin = (() => {
    try { return new URL(project.url).origin; } catch { return ""; }
  })();

  // AUTO-009g — memory ceiling. Walk results in order; when adding an entry
  // would push cumulative bytes past the cap, drop THAT entry's `jsCoverage`
  // (it already landed in memory but the aggregator won't see it) and mark
  // `truncated: true` on the resulting summary. Smaller subsequent entries
  // that individually fit under the remaining budget are still included —
  // this maximises coverage data within the ceiling rather than blanket-
  // dropping everything after the first over-budget entry. Earlier results'
  // data is preserved verbatim so the partial summary is still useful.
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
    // AUTO-009d — when changedFileRanges is supplied (PR/trigger path), pass
    // outRef so the aggregator surfaces per-source covered-line sets. We then
    // hand those to `computePrCoverage` and stash the diff on
    // `summary.prCoverageDiff` so a single caller integration point covers
    // both single-process (testRunner.js) and sharded (runWorker.js) runs.
    const outRef = changedFileRanges ? {} : null;
    summary = await aggregateRunCoverage(results, { sutOrigin, resolver, outRef });
    if (summary && outRef?.coveredLinesByFile && changedFileRanges) {
      try {
        const prDiff = computePrCoverage({
          coveredLinesByFile: outRef.coveredLinesByFile,
          totalLinesByFile: outRef.totalLinesByFile,
          changedFileRanges,
        });
        if (prDiff) summary.prCoverageDiff = prDiff;
      } catch (prErr) {
        console.warn(formatLogLine("warn", null,
          `[finalizeCoverage] computePrCoverage failed: ${prErr?.message || prErr}`));
      }
    }
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

/**
 * AUTO-009k — Build the JSON-serializable per-shard pre-aggregated coverage
 * payload that gets persisted via `runRepo.setShardCoverageSummary`. Each
 * shard runs the full aggregator over its OWN slice of results (resolver
 * disabled — source-map resolution happens once at the finalizer, not N
 * times across shards), then keeps only the `mergeable` side channel
 * (per-bundle id arrays, per-source line arrays, server diffs, per-test
 * deltas). Best-effort: never throws so coverage capture can't fail a shard.
 *
 * The merge consumer (`mergeShardSummaries` below) takes set union across
 * the persisted shard summaries — matching the industry pattern (c8 / nyc
 * / Istanbul `libCoverage.merge()`).
 *
 * @param {Object} project        - Env-scoped project (`coverageEnabled`).
 * @param {Array<Object>} results - This shard's slice of results.
 * @returns {Promise<Object|null>} Per-shard mergeable payload, or null.
 */
export async function aggregateShardCoverage(project, results) {
  if (!project?.coverageEnabled) return null;
  // Empty shards (shardCount > tests.length) must return a valid empty
  // mergeable payload — NOT null. Returning null would cause
  // `allShardsContributed` in the finalizer to be false, forcing the
  // AUTO-009f fallback path which is structurally broken after AUTO-009k
  // strips jsCoverage. An empty payload merges cleanly (contributes zero
  // lines/statements to the union) and keeps the preferred merge path.
  if (!Array.isArray(results) || results.length === 0) {
    return {
      perBundle: {},
      sbfPerBundle: {},
      sbfHasData: false,
      perSource: {},
      serverFiles: {},
      serverLayer: false,
      perTest: [],
    };
  }
  const sutOrigin = (() => {
    try { return new URL(project.url).origin; } catch { return ""; }
  })();
  try {
    // No resolver — keep the shard summary in bundle-coordinate space.
    // Source-map resolution is expensive (network + LRU cache + WASM
    // SourceMapConsumer per bundle) and would be wasted N times if each
    // shard ran it; the finalizer resolves once after merge.
    const outRef = {};
    const summary = await aggregateRunCoverage(results, { sutOrigin, outRef });
    if (!summary || !outRef.mergeable) return null;
    return {
      ...outRef.mergeable,
      // Per-test deltas are disjoint across shards (each test runs on one
      // shard), so the merge consumer concatenates losslessly.
      perTest: Array.isArray(summary.perTest) ? summary.perTest : [],
    };
  } catch (err) {
    console.warn(formatLogLine("warn", null,
      `[aggregateShardCoverage] failed: ${err?.message || err}`));
    return null;
  }
}

/**
 * AUTO-009k — Set-union merge across per-shard pre-aggregated coverage
 * summaries. Returns the final `coverageSummary` shape that
 * `aggregateRunCoverage` would have produced over the union of all shards'
 * raw results — without re-processing megabytes of raw V8 ranges at the
 * finalizer.
 *
 * **Mathematical contract:** set union is associative and commutative, so
 * `merge([shard0, shard1, ...])` ≡ `aggregateRunCoverage(concat(allResults))`
 * for the coverage fields. Per-test deltas concatenate losslessly because
 * each test runs on exactly one shard. Server-side file diffs sum directly
 * per the c8 disjoint-diff contract (a statement can only flip
 * `count===0 → count>0` once across a run).
 *
 * **Naive count-summing is wrong** — proven counter-example: shard 0 covers
 * lines [1,2,3] of file.js, shard 1 covers lines [3,4,5]. Naive sum:
 * `coveredLines = 6`. True union: `coveredLines = 5`. The set-union
 * semantics here is what makes the industry pattern (c8 / nyc / Istanbul /
 * Codecov) correct.
 *
 * Source-map resolution: this merge stage operates on bundle-coordinate
 * data. The shard helper deliberately runs without a resolver so each
 * shard's payload is compact. `topUncoveredFiles[]` entries use bundleUrl
 * labels (not original-source paths) on the merge path; the single-process
 * path resolves to original-source paths via the resolver. Coverage
 * numbers (pct, covered/total) are identical on both paths — only the
 * display labels differ.
 *
 * @param {Array<Object>} shardSummaries - Sparse per-shard payloads.
 * @returns {Object|null} `coverageSummary` shape, or null when no shard
 *   contributed data.
 */
export function mergeShardSummaries(shardSummaries) {
  if (!Array.isArray(shardSummaries)) return null;
  const real = shardSummaries.filter((s) => s && typeof s === "object");
  if (real.length === 0) return null;

  // ── Per-bundle line union ─────────────────────────────────────────────
  const bundleAcc = new Map();
  for (const shard of real) {
    const perBundle = shard.perBundle || {};
    for (const [bundleUrl, slot] of Object.entries(perBundle)) {
      const entry = bundleAcc.get(bundleUrl) || { covered: new Set(), totalLines: 0 };
      for (const ln of (slot.covered || [])) entry.covered.add(ln);
      // Total lines is stable per bundle across shards; `max` defends
      // against a flaky shard that captured a partial payload.
      entry.totalLines = Math.max(entry.totalLines, slot.totalLines || 0);
      bundleAcc.set(bundleUrl, entry);
    }
  }

  // ── Per-bundle S/B/F id union ─────────────────────────────────────────
  // Id encoding (`s:N` / `b:N:arm` / `f:N`) lets one Set hold all three
  // dimensions; post-merge tally splits by prefix.
  const sbfAcc = new Map();
  let sbfHasData = false;
  for (const shard of real) {
    if (shard.sbfHasData) sbfHasData = true;
    const sbf = shard.sbfPerBundle || {};
    for (const [bundleUrl, slot] of Object.entries(sbf)) {
      const entry = sbfAcc.get(bundleUrl) || {
        coveredIds: new Set(),
        totals: { statements: 0, branches: 0, functions: 0 },
      };
      for (const id of (slot.coveredIds || [])) entry.coveredIds.add(id);
      const t = slot.totals || { statements: 0, branches: 0, functions: 0 };
      entry.totals.statements = Math.max(entry.totals.statements, t.statements || 0);
      entry.totals.branches   = Math.max(entry.totals.branches,   t.branches   || 0);
      entry.totals.functions  = Math.max(entry.totals.functions,  t.functions  || 0);
      sbfAcc.set(bundleUrl, entry);
    }
  }

  // ── Per-source-path line union ────────────────────────────────────────
  const sourceAcc = new Map();
  for (const shard of real) {
    const perSource = shard.perSource || {};
    for (const [file, slot] of Object.entries(perSource)) {
      const entry = sourceAcc.get(file) || {
        covered: new Set(),
        totalLines: 0,
        bundleUrl: slot.bundleUrl || null,
      };
      for (const ln of (slot.coveredLines || [])) entry.covered.add(ln);
      entry.totalLines = Math.max(entry.totalLines, slot.totalLines || 0);
      if (!entry.bundleUrl && slot.bundleUrl) entry.bundleUrl = slot.bundleUrl;
      sourceAcc.set(file, entry);
    }
  }

  return _finalizeMergedSummary({ bundleAcc, sbfAcc, sbfHasData, sourceAcc, real });
}

/**
 * AUTO-009k — Internal: take the post-union accumulator state from
 * `mergeShardSummaries` and the per-shard payloads, produce the public
 * `coverageSummary` shape. Split out so the union-accumulation logic and
 * the totals-computation logic stay short and individually testable.
 *
 * Math mirrors `aggregateRunCoverage`'s tail so the merged output is
 * byte-equivalent to the single-pass version modulo `topUncoveredFiles`
 * ordering (re-sorted below by descending uncoveredLines).
 *
 * @param {Object} state
 * @param {Map}    state.bundleAcc  - bundleUrl → { covered:Set, totalLines }
 * @param {Map}    state.sbfAcc     - bundleUrl → { coveredIds:Set, totals }
 * @param {boolean} state.sbfHasData
 * @param {Map}    state.sourceAcc  - file → { covered:Set, totalLines, bundleUrl }
 * @param {Array<Object>} state.real - Original per-shard payloads (for
 *   server merge + perTest concat).
 * @returns {Object} `coverageSummary` shape.
 */
function _finalizeMergedSummary({ bundleAcc, sbfAcc, sbfHasData, sourceAcc, real }) {
  // ── Server-side merge — disjoint sum (c8 contract) ────────────────────
  // A statement id flips `count===0 → count>0` at most once across API
  // tests, AND each test runs on one shard, so union(addedX) = sum(addedX).
  // Totals stable per c8 instrumentation; first-seen wins.
  const serverAcc = new Map();
  let serverLayer = false;
  for (const shard of real) {
    if (shard.serverLayer) serverLayer = true;
    const sf = shard.serverFiles || {};
    for (const [path, m] of Object.entries(sf)) {
      const entry = serverAcc.get(path);
      if (!entry) {
        serverAcc.set(path, {
          addedStatements: m.addedStatements || 0,
          addedBranches:   m.addedBranches   || 0,
          addedFunctions:  m.addedFunctions  || 0,
          totalStatements: m.totalStatements || 0,
          totalBranches:   m.totalBranches   || 0,
          totalFunctions:  m.totalFunctions  || 0,
        });
      } else {
        entry.addedStatements += m.addedStatements || 0;
        entry.addedBranches   += m.addedBranches   || 0;
        entry.addedFunctions  += m.addedFunctions  || 0;
      }
    }
  }

  // ── Per-bundle uncovered S/B/F extras ─────────────────────────────────
  // So each source-grouped entry can attribute uncovered branch/function
  // counts to the bundle it came from. Mirrors `uncoveredExtrasByBundle`
  // in the aggregator.
  const uncoveredExtrasByBundle = new Map();
  for (const [bundleUrl, entry] of sbfAcc.entries()) {
    let cs = 0, cb = 0, cf = 0;
    for (const key of entry.coveredIds) {
      if (key.startsWith("s:")) cs++;
      else if (key.startsWith("b:")) cb++;
      else if (key.startsWith("f:")) cf++;
    }
    uncoveredExtrasByBundle.set(bundleUrl, {
      uncoveredBranches:  Math.max(0, entry.totals.branches  - cb),
      uncoveredFunctions: Math.max(0, entry.totals.functions - cf),
    });
  }

  // ── Build topUncoveredFiles[] from browser + server layers ────────────
  let totalLines = 0;
  let coveredLines = 0;
  const topUncoveredFiles = [];
  for (const [file, entry] of sourceAcc.entries()) {
    const covered = entry.covered.size;
    const total = entry.totalLines;
    totalLines += total;
    coveredLines += covered;
    const extras = entry.bundleUrl ? uncoveredExtrasByBundle.get(entry.bundleUrl) : null;
    topUncoveredFiles.push({
      file,
      layer: "browser",
      uncoveredLines: Math.max(0, total - covered),
      totalLines: total,
      bundleUrl: entry.bundleUrl || null,
      uncoveredBranches:  extras?.uncoveredBranches  ?? 0,
      uncoveredFunctions: extras?.uncoveredFunctions ?? 0,
    });
  }
  for (const [path, m] of serverAcc.entries()) {
    topUncoveredFiles.push({
      file: path,
      layer: "server",
      uncoveredLines: Math.max(0, m.totalStatements - m.addedStatements),
      totalLines: m.totalStatements,
      bundleUrl: null,
      uncoveredBranches:  Math.max(0, m.totalBranches  - m.addedBranches),
      uncoveredFunctions: Math.max(0, m.totalFunctions - m.addedFunctions),
    });
  }
  topUncoveredFiles.sort((a, b) => b.uncoveredLines - a.uncoveredLines);

  const coveragePct = totalLines > 0 ? coveredLines / totalLines : 0;

  // ── Concat per-test deltas, recompute deltaPct against merged totals ──
  const perTest = [];
  for (const shard of real) {
    for (const row of (shard.perTest || [])) perTest.push({ ...row });
  }
  for (const row of perTest) row.deltaPct = totalLines > 0 ? row.deltaLines / totalLines : 0;

  // ── Granularity (S/B/F) — only when at least one shard captured it ────
  let granularity = null;
  if (sbfHasData) {
    let totalStatements = 0, coveredStatements = 0;
    let totalBranches   = 0, coveredBranches   = 0;
    let totalFunctions  = 0, coveredFunctions  = 0;
    for (const entry of sbfAcc.values()) {
      let cs = 0, cb = 0, cf = 0;
      for (const key of entry.coveredIds) {
        if (key.startsWith("s:")) cs++;
        else if (key.startsWith("b:")) cb++;
        else if (key.startsWith("f:")) cf++;
      }
      totalStatements += entry.totals.statements; coveredStatements += cs;
      totalBranches   += entry.totals.branches;   coveredBranches   += cb;
      totalFunctions  += entry.totals.functions;  coveredFunctions  += cf;
    }
    granularity = {
      totalStatements, coveredStatements,
      statementPct: totalStatements > 0 ? coveredStatements / totalStatements : 0,
      totalBranches, coveredBranches,
      branchPct:    totalBranches   > 0 ? coveredBranches   / totalBranches   : 0,
      totalFunctions, coveredFunctions,
      functionPct:  totalFunctions  > 0 ? coveredFunctions  / totalFunctions  : 0,
    };
  }

  // ── sourceMapStatus ──────────────────────────────────────────────────
  // Merge path doesn't run the resolver, so the status defaults to
  // "fallback" — matches the single-pass aggregator's output when no
  // resolver is supplied. topUncoveredFiles[] entries use bundleUrl labels
  // on this path; coverage numbers are identical to the resolved path.
  return {
    totalLines,
    coveredLines,
    coveragePct,
    perTest,
    topUncoveredFiles: topUncoveredFiles.slice(0, 20),
    sourceMapStatus: "fallback",
    ...(serverLayer ? { serverLayer: true } : {}),
    ...(granularity || {}),
  };
}

/** Test-only — exported so the perf test can assert the configured ceiling. */
export const __COVERAGE_MEMORY_CEILING_BYTES_FOR_TEST = COVERAGE_MEMORY_CEILING_BYTES;

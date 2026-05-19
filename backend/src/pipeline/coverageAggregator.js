/**
 * @module pipeline/coverageAggregator
 * @description AUTO-009 browser JS coverage aggregation helpers.
 *
 * AUTO-009b: when a `resolver` is supplied (see
 * {@link module:pipeline/sourceMapResolver}), `topUncoveredFiles[]` entries
 * are resolved back to original source paths via `<bundleUrl>.map` (or
 * `project.sourcemapBaseUrl`). The aggregator then groups by original
 * source file (`src/foo/bar.ts`) rather than the bundle URL and reports
 * `sourceMapStatus` as `"resolved"` (≥80% of bundle lines mapped),
 * `"partial"` (some mapped), or `"fallback"` (none / no resolver). The
 * original bundle URL is retained as `bundleUrl` on each entry so the
 * frontend can still link to trace artifacts.
 *
 * Best-effort: every resolver call is wrapped in try/catch so coverage
 * capture never fails a run.
 */

function normalizeUrl(url) {
  try { return new URL(url).toString(); } catch { return String(url || ""); }
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

function shouldIncludeScript(url, sutOrigin) {
  if (!url) return false;
  if (url.startsWith("extensions::") || url.startsWith("eval://")) return false;
  if (url.includes("__sentri")) return false;
  if (!sutOrigin) return true;
  return originOf(url) === sutOrigin;
}

function lineFromOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function summarizeCoverageForTest(jsCoverage = [], { sutOrigin } = {}) {
  const files = new Map();
  for (const entry of jsCoverage || []) {
    const url = normalizeUrl(entry?.url || "");
    if (!shouldIncludeScript(url, sutOrigin)) continue;
    const text = String(entry?.text || "");
    const ranges = Array.isArray(entry?.ranges) ? entry.ranges : [];
    const touched = new Set();
    for (const r of ranges) {
      if (!r || typeof r.start !== "number" || typeof r.end !== "number") continue;
      const sLine = lineFromOffset(text, r.start);
      const eLine = lineFromOffset(text, Math.max(r.start, r.end - 1));
      for (let ln = sLine; ln <= eLine; ln++) touched.add(ln);
    }
    if (!files.has(url)) files.set(url, { totalLines: Math.max(1, text.split("\n").length), covered: new Set() });
    const f = files.get(url);
    for (const ln of touched) f.covered.add(ln);
  }
  return files;
}

/**
 * Aggregate per-test V8 coverage into a single run summary.
 *
 * @param {Object[]} results
 * @param {Object}   [opts]
 * @param {string}   [opts.sutOrigin]
 * @param {{
 *   resolve: (bundleUrl: string) => Promise<any|null>,
 *   mapLine: (consumer: any, line: number) => ({ source: string, line: number }|null),
 * }} [opts.resolver] — AUTO-009b source-map resolver. Optional; when omitted
 *   the aggregator returns bundle-coordinate file labels and
 *   `sourceMapStatus: "fallback"`.
 * @returns {Promise<Object>} `run.coverageSummary` shape.
 */
export async function aggregateRunCoverage(results = [], { sutOrigin, resolver } = {}) {
  const runCovered = new Map(); // bundleUrl -> Set(lines covered)
  const runTotals = new Map();  // bundleUrl -> total lines
  const perTest = [];

  for (const r of results) {
    const byFile = summarizeCoverageForTest(r?.jsCoverage || [], { sutOrigin });
    let deltaLines = 0;
    for (const [file, meta] of byFile.entries()) {
      if (!runCovered.has(file)) runCovered.set(file, new Set());
      runTotals.set(file, Math.max(runTotals.get(file) || 0, meta.totalLines));
      const existing = runCovered.get(file);
      for (const ln of meta.covered) {
        if (!existing.has(ln)) deltaLines++;
        existing.add(ln);
      }
    }
    perTest.push({ testId: r?.testId, deltaLines, deltaPct: 0 });
  }

  // ── AUTO-009b: optional source-map resolution ──────────────────────────────
  // Best-effort. Any resolver failure (network, parse, missing) silently
  // degrades to bundle coordinates for that file — never throws. We track
  // per-bundle resolution stats so the overall `sourceMapStatus` reflects
  // whether resolution was effective across the run.
  let bundleLinesTotal = 0;
  let bundleLinesResolved = 0;
  // Grouped by original source path (when resolved) — values mirror the
  // bundle-level { covered, total } shape so the existing aggregate math
  // still works.
  /** @type {Map<string, { covered: Set<number>, total: number, bundleUrl: string|null }>} */
  const groupedByOriginal = new Map();

  for (const [bundleUrl, total] of runTotals.entries()) {
    const coveredSet = runCovered.get(bundleUrl) || new Set();
    bundleLinesTotal += total;

    let consumer = null;
    if (resolver?.resolve) {
      try { consumer = await resolver.resolve(bundleUrl); } catch { consumer = null; }
    }

    if (!consumer) {
      // Fallback — keep the bundle URL as the file label.
      const existing = groupedByOriginal.get(bundleUrl) || { covered: new Set(), total: 0, bundleUrl };
      for (const ln of coveredSet) existing.covered.add(ln);
      existing.total = Math.max(existing.total, total);
      groupedByOriginal.set(bundleUrl, existing);
      continue;
    }

    // Per-bundle-line mapping. We attempt every line 1..total so the
    // resolution-rate stat reflects how much of the bundle is mappable, not
    // just the uncovered tail.
    let resolvedForThisBundle = 0;
    for (let ln = 1; ln <= total; ln++) {
      let mapped = null;
      try { mapped = resolver.mapLine ? resolver.mapLine(consumer, ln) : null; } catch { mapped = null; }
      const sourceKey = mapped?.source ? mapped.source : bundleUrl;
      if (mapped?.source) resolvedForThisBundle++;
      const isCovered = coveredSet.has(ln);
      const existing = groupedByOriginal.get(sourceKey) || { covered: new Set(), total: 0, bundleUrl };
      // Use the mapped line when available so per-source uncovered counts
      // reference original-source coordinates.
      const targetLine = mapped?.line ?? ln;
      existing.total = Math.max(existing.total, targetLine);
      if (isCovered) existing.covered.add(targetLine);
      groupedByOriginal.set(sourceKey, existing);
    }
    bundleLinesResolved += resolvedForThisBundle;
  }

  let totalLines = 0;
  let coveredLines = 0;
  const topUncoveredFiles = [];
  for (const [file, meta] of groupedByOriginal.entries()) {
    const covered = meta.covered.size;
    const total = meta.total;
    totalLines += total;
    coveredLines += covered;
    topUncoveredFiles.push({
      file,
      uncoveredLines: Math.max(0, total - covered),
      totalLines: total,
      bundleUrl: meta.bundleUrl || null,
    });
  }
  topUncoveredFiles.sort((a, b) => b.uncoveredLines - a.uncoveredLines);
  const coveragePct = totalLines > 0 ? coveredLines / totalLines : 0;
  for (const row of perTest) row.deltaPct = totalLines > 0 ? row.deltaLines / totalLines : 0;

  let sourceMapStatus = "fallback";
  if (resolver?.resolve && bundleLinesTotal > 0) {
    const ratio = bundleLinesResolved / bundleLinesTotal;
    if (ratio >= 0.8) sourceMapStatus = "resolved";
    else if (ratio > 0) sourceMapStatus = "partial";
  }

  return {
    totalLines,
    coveredLines,
    coveragePct,
    perTest,
    topUncoveredFiles: topUncoveredFiles.slice(0, 20),
    sourceMapStatus,
  };
}


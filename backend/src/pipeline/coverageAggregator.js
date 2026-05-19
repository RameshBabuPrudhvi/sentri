/**
 * @module pipeline/coverageAggregator
 * @description AUTO-009 browser JS coverage aggregation helpers.
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

export function aggregateRunCoverage(results = [], { sutOrigin } = {}) {
  const runCovered = new Map(); // file -> Set(lines)
  const runTotals = new Map(); // file -> total lines
  const perTest = [];
  let sourceMapStatus = "fallback";

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

  let totalLines = 0;
  let coveredLines = 0;
  const topUncoveredFiles = [];
  for (const [file, total] of runTotals.entries()) {
    const covered = runCovered.get(file)?.size || 0;
    totalLines += total;
    coveredLines += covered;
    topUncoveredFiles.push({ file, uncoveredLines: Math.max(0, total - covered), totalLines: total });
  }
  topUncoveredFiles.sort((a, b) => b.uncoveredLines - a.uncoveredLines);
  const coveragePct = totalLines > 0 ? coveredLines / totalLines : 0;
  for (const row of perTest) row.deltaPct = totalLines > 0 ? row.deltaLines / totalLines : 0;

  return {
    totalLines,
    coveredLines,
    coveragePct,
    perTest,
    topUncoveredFiles: topUncoveredFiles.slice(0, 20),
    sourceMapStatus,
  };
}


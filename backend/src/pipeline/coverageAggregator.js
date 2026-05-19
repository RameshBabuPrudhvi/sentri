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
 * AUTO-009c: when `v8-to-istanbul` conversion succeeds (see
 * {@link module:pipeline/v8ToIstanbul}), the aggregator also reports
 * statement / branch / function coverage independently of lines. The
 * persisted `coverageSummary` shape extends with
 *   `totalStatements`, `coveredStatements`, `statementPct`,
 *   `totalBranches`,   `coveredBranches`,   `branchPct`,
 *   `totalFunctions`,  `coveredFunctions`,  `functionPct`
 * plus per-test `deltaStatements / deltaBranches / deltaFunctions` and
 * per-file `uncoveredBranches / uncoveredFunctions`. Missing keys on
 * pre-AUTO-009c rows degrade gracefully — the frontend hides them.
 *
 * AUTO-009h: when API tests carry `result.serverCoverage` (populated by
 * `pipeline/serverCoverageProxy.js` against an opt-in
 * `project.serverCoverageEndpoint`), the aggregator merges those server-
 * side diffs into the same `topUncoveredFiles[]` array, tagging every
 * entry with a `layer: "browser" | "server"` discriminator. Frontend
 * consumers split the rows into Browser / Server / Combined tabs.
 * `serverLayer` is set on the summary root when any server data was
 * present, so a SUT without `serverCoverageEndpoint` configured produces
 * a byte-identical summary shape to a pre-AUTO-009h run.
 *
 * Best-effort: every resolver / converter call is wrapped in try/catch so
 * coverage capture never fails a run.
 */

import { convertV8ToIstanbul as defaultConvertV8ToIstanbul } from "./v8ToIstanbul.js";

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
 * AGENT.md bans TS-style JSDoc (`prop?: type`, fat-arrow type expressions
 * inside `{}`). The resolver shape is documented in prose below rather
 * than inlined as a structural JSDoc type — `jsdoc` chokes on the
 * embedded fat-arrow signatures, fails the `Backend — Docs` CI step, and
 * blocks every PR after AUTO-009.
 *
 * Resolver contract (when supplied):
 *   - `resolve(bundleUrl)` — async, returns a `SourceMapConsumer`-shaped
 *     object or `null`. Failures must not throw.
 *   - `mapLine(consumer, line)` — sync, returns
 *     `{ source: string, line: number }` for a mapped line, or `null` for
 *     an unmappable one.
 *
 * @param {Object[]} results
 * @param {Object}   [opts]
 * @param {string}   [opts.sutOrigin]
 * @param {Object}   [opts.resolver] AUTO-009b source-map resolver — see prose
 *   above. Optional; when omitted the aggregator returns bundle-coordinate
 *   file labels and `sourceMapStatus: "fallback"`.
 * @returns {Promise<Object>} `run.coverageSummary` shape.
 */
export async function aggregateRunCoverage(results = [], { sutOrigin, resolver, convertV8ToIstanbul = defaultConvertV8ToIstanbul, outRef = null } = {}) {
  const runCovered = new Map(); // bundleUrl -> Set(lines covered)
  const runTotals = new Map();  // bundleUrl -> total lines
  const perTest = [];

  // ── AUTO-009c — statement / branch / function bookkeeping ─────────────────
  // Run-level sets of "ever-covered" identifiers, keyed on
  // `${bundleUrl}::s:${id}` / `b:${id}:${armIdx}` / `f:${id}` so per-test
  // deltas can detect "this test first hit this statement/branch/function in
  // the run." Totals are max-over-tests of the per-test count (V8 always
  // reports the same map per script per page lifetime; max guards a flaky
  // dispatch where one test happened to capture an empty payload).
  /** @type {Map<string, Set<string>>} */
  const sbfCoveredByBundle = new Map();
  /** @type {Map<string, { statements: number, branches: number, functions: number }>} */
  const sbfTotalsByBundle = new Map();
  // Per-file "uncovered" id sets used to populate `topUncoveredFiles[]`'s
  // `uncoveredBranches` / `uncoveredFunctions` counts after the main loop.
  /** @type {Map<string, { uncoveredBranches: number, uncoveredFunctions: number }>} */
  const uncoveredExtrasByBundle = new Map();
  // Track whether the converter ever produced a real Istanbul report so the
  // returned shape only includes S/B/F totals when there's actual data. A
  // SUT without source maps (or with v8-to-istanbul disabled) keeps the old
  // line-only summary verbatim.
  let sbfHasData = false;

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

    // AUTO-009c — convert each first-party entry into Istanbul format and
    // accumulate S/B/F id-set deltas. Conversion is best-effort: a single
    // failed entry only loses its own granularity, not the whole run.
    let deltaStatements = 0;
    let deltaBranches = 0;
    let deltaFunctions = 0;
    for (const entry of (r?.jsCoverage || [])) {
      const url = normalizeUrl(entry?.url || "");
      if (!shouldIncludeScript(url, sutOrigin)) continue;
      let istanbul = null;
      try { istanbul = await convertV8ToIstanbul(entry); } catch { istanbul = null; }
      if (!istanbul) continue;
      sbfHasData = true;

      if (!sbfCoveredByBundle.has(url)) sbfCoveredByBundle.set(url, new Set());
      const coveredIds = sbfCoveredByBundle.get(url);

      // Per-script totals — capture the max id count we've ever seen so
      // budget math is stable across multiple test passes.
      const sIds = istanbul.s ? Object.keys(istanbul.s) : [];
      const fIds = istanbul.f ? Object.keys(istanbul.f) : [];
      const bIds = istanbul.b ? Object.keys(istanbul.b) : [];
      let armCount = 0;
      for (const id of bIds) {
        const arms = Array.isArray(istanbul.b[id]) ? istanbul.b[id] : [];
        armCount += arms.length;
      }
      const prevTotals = sbfTotalsByBundle.get(url) || { statements: 0, branches: 0, functions: 0 };
      sbfTotalsByBundle.set(url, {
        statements: Math.max(prevTotals.statements, sIds.length),
        branches:   Math.max(prevTotals.branches,   armCount),
        functions:  Math.max(prevTotals.functions,  fIds.length),
      });

      // Statements
      for (const id of sIds) {
        if ((istanbul.s[id] || 0) > 0) {
          const key = `s:${id}`;
          if (!coveredIds.has(key)) { coveredIds.add(key); deltaStatements++; }
        }
      }
      // Functions
      for (const id of fIds) {
        if ((istanbul.f[id] || 0) > 0) {
          const key = `f:${id}`;
          if (!coveredIds.has(key)) { coveredIds.add(key); deltaFunctions++; }
        }
      }
      // Branches — each arm contributes its own (id, armIdx) pair so a
      // 2-arm `if` with only one arm taken reports 1/2 branches.
      for (const id of bIds) {
        const arms = Array.isArray(istanbul.b[id]) ? istanbul.b[id] : [];
        for (let arm = 0; arm < arms.length; arm++) {
          if ((arms[arm] || 0) > 0) {
            const key = `b:${id}:${arm}`;
            if (!coveredIds.has(key)) { coveredIds.add(key); deltaBranches++; }
          }
        }
      }
    }

    perTest.push({
      testId: r?.testId,
      deltaLines,
      deltaPct: 0,
      // AUTO-009c — extend with granularity deltas. Zero when v8-to-istanbul
      // didn't produce a report for this test (the values are still numbers
      // so consumers don't need to null-check).
      deltaStatements,
      deltaBranches,
      deltaFunctions,
    });
  }

  // AUTO-009c — compute per-bundle uncovered S/B/F so they can be attached
  // to `topUncoveredFiles[]` entries below.
  for (const [bundleUrl, totals] of sbfTotalsByBundle.entries()) {
    const covered = sbfCoveredByBundle.get(bundleUrl) || new Set();
    let coveredStatements = 0;
    let coveredBranches = 0;
    let coveredFunctions = 0;
    for (const key of covered) {
      if (key.startsWith("s:")) coveredStatements++;
      else if (key.startsWith("b:")) coveredBranches++;
      else if (key.startsWith("f:")) coveredFunctions++;
    }
    uncoveredExtrasByBundle.set(bundleUrl, {
      uncoveredBranches: Math.max(0, totals.branches - coveredBranches),
      uncoveredFunctions: Math.max(0, totals.functions - coveredFunctions),
    });
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
    // AUTO-009c — when the converter produced a per-bundle S/B/F summary,
    // attach the per-file uncovered counts so the dashboard / RunDetail can
    // surface "47L · 12B · 3F uncovered" alongside line counts. Lookups go
    // through `meta.bundleUrl` because grouping by original source path may
    // have merged multiple bundles into one file; we attribute extras to
    // the bundle that originally contributed this group.
    const extras = meta.bundleUrl ? uncoveredExtrasByBundle.get(meta.bundleUrl) : null;
    topUncoveredFiles.push({
      file,
      // AUTO-009h — every row carries a `layer` discriminator. Browser
      // rows (from V8 `page.coverage`) get `"browser"`; server rows
      // (from `result.serverCoverage`) get `"server"` below. The
      // Dashboard CoveragePanel splits on this field for its Browser /
      // Server / Combined tabs.
      layer: "browser",
      uncoveredLines: Math.max(0, total - covered),
      totalLines: total,
      bundleUrl: meta.bundleUrl || null,
      uncoveredBranches:  extras?.uncoveredBranches  ?? 0,
      uncoveredFunctions: extras?.uncoveredFunctions ?? 0,
    });
  }

  // ── AUTO-009h — merge server-side coverage diffs ──────────────────────────
  // Walk every API-test result for `serverCoverage` (populated by
  // `serverCoverageProxy.js`). The diff shape is
  //   `{ [path]: { addedStatements, addedBranches, addedFunctions,
  //                totalStatements, totalBranches, totalFunctions } }`
  // and represents the SUT files this test newly exercised (statements /
  // branches / functions present in `after` but not in `before`).
  //
  // ### Aggregation contract
  //
  // - **Per-test diffs are disjoint by construction.** A statement id
  //   can move from `count === 0` to `count > 0` exactly once across a
  //   run's API tests — the second test that exercises the same line
  //   sees `prevS = already-covered` and never adds it to its delta.
  //   So `sum(addedStatements)` is the union, no dedup needed.
  // - **Totals are stable per file across a run.** c8 emits file IDs
  //   from a one-time instrumentation pass at SUT start-up; the
  //   `statementMap` / `fnMap` / `branchMap` are fixed for the lifetime
  //   of the SUT process, so every diff's `totalStatements` for a given
  //   file is identical. We take the first-seen value rather than the
  //   `Math.max` of all diffs — equivalent under the c8 contract, and
  //   reads as "this is the file's total" rather than "we're defending
  //   against an impossible mutation."
  // - **No `Math.min` cap on covered counts.** The disjoint-diff guarantee
  //   above means `addedStatements` sums up to at most `totalStatements`
  //   (you can't add what's already there). A SUT that violates the c8
  //   contract (e.g. restarts mid-run, re-emitting fresh IDs) would
  //   produce a corrupted summary, but that's a SUT bug not ours.
  /** @type {Map<string, { addedStatements: number, addedBranches: number, addedFunctions: number, totalStatements: number, totalBranches: number, totalFunctions: number }>} */
  const serverFiles = new Map();
  let serverLayer = false;
  for (const r of results) {
    const sc = r?.serverCoverage;
    if (!sc || typeof sc !== "object") continue;
    serverLayer = true;
    for (const [path, delta] of Object.entries(sc)) {
      if (!delta || typeof delta !== "object") continue;
      const existing = serverFiles.get(path);
      if (!existing) {
        // First diff for this file — take totals as-is.
        serverFiles.set(path, {
          addedStatements: delta.addedStatements || 0,
          addedBranches:   delta.addedBranches   || 0,
          addedFunctions:  delta.addedFunctions  || 0,
          totalStatements: delta.totalStatements || 0,
          totalBranches:   delta.totalBranches   || 0,
          totalFunctions:  delta.totalFunctions  || 0,
        });
      } else {
        // Subsequent diffs — sum the disjoint adds. Totals are stable
        // per c8 contract, so we don't touch them.
        existing.addedStatements += delta.addedStatements || 0;
        existing.addedBranches   += delta.addedBranches   || 0;
        existing.addedFunctions  += delta.addedFunctions  || 0;
      }
    }
  }
  // AUTO-009h — server-side source-map resolution. When the operator has
  // configured `project.sourcemapBaseUrl` AND c8 was started WITHOUT its
  // `--source-map` flag, the paths c8 emits look like `/app/dist/server.js`.
  // We reuse the same resolver the browser path uses (`sourceMapResolver.js`)
  // to fetch `<sourcemapBaseUrl>/<filename>.map` and rewrite the path to
  // the original source (`src/server.ts`). When c8 already source-mapped
  // the paths (the recommended config), the `.map` lookup will 404 and
  // the resolver returns null — the path stays as c8 emitted it, which
  // is already correct. Best-effort: any resolver failure leaves the
  // path untouched, never throws.
  for (const [path, m] of serverFiles.entries()) {
    let file = path;
    // Only attempt resolution for paths that look like .js/.mjs/.cjs
    // outputs (the typical c8-without-source-map shape). `.ts` / `.tsx`
    // paths are already-resolved sources — leave them alone.
    if (resolver?.resolve && /\.(m|c)?js$/.test(path)) {
      try {
        const consumer = await resolver.resolve(path);
        if (consumer && resolver.mapLine) {
          // The Istanbul diff doesn't carry line numbers per file, just
          // statement/branch/function counts. We probe line 1 col 0 to
          // pull the original `source` field — any covered line in the
          // file is in the same compilation unit so the source name is
          // stable. Mirrors the browser-path probe at line ~262.
          const mapped = resolver.mapLine(consumer, 1, 0);
          if (mapped?.source) file = mapped.source;
        }
      } catch { /* resolver failure → keep original path */ }
    }
    topUncoveredFiles.push({
      file,
      layer: "server",
      // "uncoveredLines" semantics on the server side: we don't have line
      // numbers in the Istanbul diff, but `totalStatements - covered` is
      // the closest stable proxy — the Dashboard renders it under the
      // same column as browser line counts so the operator sees an
      // apples-to-apples uncovered count.
      uncoveredLines: Math.max(0, m.totalStatements - m.addedStatements),
      totalLines: m.totalStatements,
      // `bundleUrl` carries the c8-emitted path so the frontend can show
      // it as a tooltip ("originally /app/dist/server.js") when the
      // primary `file` was rewritten by source-map resolution. Null
      // when resolution didn't fire so the legacy display path stays
      // bit-for-bit identical.
      bundleUrl: file !== path ? path : null,
      uncoveredBranches:  Math.max(0, m.totalBranches  - m.addedBranches),
      uncoveredFunctions: Math.max(0, m.totalFunctions - m.addedFunctions),
    });
  }
  topUncoveredFiles.sort((a, b) => b.uncoveredLines - a.uncoveredLines);
  // AUTO-009d — surface per-source covered-line sets via the optional
  // `outRef` side channel so `coveragePrDiff.computePrCoverage` can filter
  // covered lines by the PR's changed file ranges. We do NOT persist these
  // sets on `coverageSummary` (Sets do not JSON-serialize, and the data
  // would bloat the row by ~10x); the caller is expected to consume the
  // sets in-process and discard them.
  if (outRef && typeof outRef === "object") {
    outRef.coveredLinesByFile = {};
    outRef.totalLinesByFile = {};
    for (const [file, meta] of groupedByOriginal.entries()) {
      outRef.coveredLinesByFile[file] = meta.covered;
      outRef.totalLinesByFile[file] = meta.total;
    }
  }
  const coveragePct = totalLines > 0 ? coveredLines / totalLines : 0;
  for (const row of perTest) row.deltaPct = totalLines > 0 ? row.deltaLines / totalLines : 0;

  let sourceMapStatus = "fallback";
  if (resolver?.resolve && bundleLinesTotal > 0) {
    const ratio = bundleLinesResolved / bundleLinesTotal;
    if (ratio >= 0.8) sourceMapStatus = "resolved";
    else if (ratio > 0) sourceMapStatus = "partial";
  }

  // AUTO-009c — only surface S/B/F totals when the converter actually
  // produced data. Otherwise omit the keys entirely so the persisted shape
  // is byte-identical to AUTO-009b runs and frontend consumers fall back
  // to line-only rendering via their `?? 0` / nullish guards.
  let granularity = null;
  if (sbfHasData) {
    let totalStatements = 0, coveredStatements = 0;
    let totalBranches   = 0, coveredBranches   = 0;
    let totalFunctions  = 0, coveredFunctions  = 0;
    for (const [bundleUrl, totals] of sbfTotalsByBundle.entries()) {
      const covered = sbfCoveredByBundle.get(bundleUrl) || new Set();
      let cs = 0, cb = 0, cf = 0;
      for (const key of covered) {
        if (key.startsWith("s:")) cs++;
        else if (key.startsWith("b:")) cb++;
        else if (key.startsWith("f:")) cf++;
      }
      totalStatements += totals.statements; coveredStatements += cs;
      totalBranches   += totals.branches;   coveredBranches   += cb;
      totalFunctions  += totals.functions;  coveredFunctions  += cf;
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

  return {
    totalLines,
    coveredLines,
    coveragePct,
    perTest,
    topUncoveredFiles: topUncoveredFiles.slice(0, 20),
    sourceMapStatus,
    // AUTO-009h — `serverLayer: true` signals to the Dashboard
    // CoveragePanel that it should render the Browser / Server / Combined
    // tabs. Omitted entirely when no API test produced `serverCoverage`,
    // so pre-AUTO-009h runs serialize byte-identically.
    ...(serverLayer ? { serverLayer: true } : {}),
    ...(granularity || {}),
  };
}


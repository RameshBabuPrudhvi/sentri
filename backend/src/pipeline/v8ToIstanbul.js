/**
 * @module pipeline/v8ToIstanbul
 * @description AUTO-009c — Convert Playwright's V8 JS coverage output into
 * the structured Istanbul format so the aggregator can report statement,
 * branch, and function coverage independently of line coverage.
 *
 * Playwright's `page.coverage.stopJSCoverage()` returns entries shaped as
 * `{ url, scriptId, source/text, functions: [{ ranges, isBlockCoverage }] }`
 * (V8 format). `v8-to-istanbul@^9` ingests that shape and produces an
 * Istanbul `FileCoverage` per script:
 *
 *   {
 *     path: <url>,
 *     statementMap: { 0: { start: {...}, end: {...} }, ... },
 *     s:            { 0: <hitCount>, ... },         // statements
 *     fnMap:        { 0: { name, decl, loc }, ... },
 *     f:            { 0: <hitCount>, ... },         // functions
 *     branchMap:    { 0: { type, locations: [...] }, ... },
 *     b:            { 0: [<arm1Hits>, <arm2Hits>], ... }   // branches
 *   }
 *
 * The aggregator counts a statement / function as "covered" iff its hit
 * count is > 0, and a branch arm as "covered" iff its slot in `b[id][arm]`
 * is > 0. `totalBranches` counts each arm independently so a 2-arm `if`
 * with one arm never taken yields `coveredBranches/totalBranches = 1/2`.
 *
 * ### Best-effort
 * Every conversion path is wrapped in try/catch and returns `null` on any
 * failure (missing payload, malformed source, v8-to-istanbul throw). The
 * caller must tolerate `null` and degrade to line-only coverage.
 *
 * ### Lazy import
 * `v8-to-istanbul` is loaded via dynamic `import()` so a missing/broken
 * install does not crash module load for coverage-disabled runs.
 *
 * ### Exports
 * - {@link convertV8ToIstanbul} — single Playwright entry → Istanbul file
 *   coverage object (or null).
 */

import { formatLogLine } from "../utils/logFormatter.js";

let _v8ToIstanbul = null;
let _v8ToIstanbulLoaded = false;

async function loadV8ToIstanbul() {
  if (_v8ToIstanbulLoaded) return _v8ToIstanbul;
  _v8ToIstanbulLoaded = true;
  try {
    const mod = await import("v8-to-istanbul");
    _v8ToIstanbul = mod.default || mod;
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[v8ToIstanbul] dependency unavailable: ${err.message}`));
    _v8ToIstanbul = null;
  }
  return _v8ToIstanbul;
}

/**
 * Convert one Playwright V8 coverage entry into an Istanbul `FileCoverage`
 * object.
 *
 * Playwright's entries carry the script body in `entry.text` plus a flat
 * `ranges` array of `{ start, end, count }` triples (where `count` is
 * optional and defaults to 1 when omitted), rather than V8's native
 * `{ functions: [{ ranges, isBlockCoverage }] }`. We synthesize a single
 * top-level function whose ranges mirror Playwright's `ranges[]` so
 * `v8-to-istanbul.applyCoverage()` sees a complete-ish V8 payload.
 *
 * AGENTS.md bans TS-style optional-property JSDoc (`count?: number`).
 * The `entry` shape is documented in prose above rather than as a
 * structural type literal — `jsdoc` chokes on `?:` inside `{}` and the
 * `Backend — Docs` CI step fails. Use `@typedef` + `@property [name]`
 * if a structural definition becomes necessary.
 *
 * @param {Object} entry Playwright V8 coverage entry. Required fields:
 *   `url` (string), `text` (string), `ranges` (array of
 *   `{ start, end, count? }` triples; `count` defaults to 1).
 * @returns {Promise<Object|null>} Istanbul FileCoverage or null on failure.
 */
export async function convertV8ToIstanbul(entry) {
  try {
    if (!entry || typeof entry.url !== "string" || typeof entry.text !== "string") return null;
    const V8ToIstanbul = await loadV8ToIstanbul();
    if (!V8ToIstanbul) return null;

    const text = entry.text;
    const ranges = Array.isArray(entry.ranges) ? entry.ranges : [];

    // Synthesise V8's `functions[]` shape from Playwright's flat `ranges[]`.
    // `v8-to-istanbul` wants at least one function entry covering the full
    // source, plus optional sub-ranges (block coverage). We map every
    // Playwright range to a block-coverage entry with count 1 (covered)
    // and prepend a whole-file count=0 sentinel so blocks not listed in
    // `ranges[]` are reported as uncovered.
    const v8FunctionPayload = [{
      functionName: "",
      isBlockCoverage: true,
      ranges: [
        // Whole file as "not covered" baseline. Playwright ranges with
        // count > 0 override this for their offsets.
        { startOffset: 0, endOffset: text.length, count: 0 },
        ...ranges
          .filter((r) => r && typeof r.start === "number" && typeof r.end === "number" && r.end > r.start)
          .map((r) => ({ startOffset: r.start, endOffset: r.end, count: typeof r.count === "number" ? r.count : 1 })),
      ],
    }];

    // v8-to-istanbul wants a URL-shaped path. Pass `text` directly via the
    // `source` field so it doesn't try to read from disk. `sourcemap`
    // resolution is handled separately by sourceMapResolver; we let
    // v8-to-istanbul use the bundle's own sourceMappingURL only when the
    // source contains one inline — the third arg `excludePath` defaults
    // to a no-op.
    const converter = new V8ToIstanbul(entry.url, 0, { source: text });
    try {
      await converter.load();
    } catch (loadErr) {
      console.warn(formatLogLine("warn", null, `[v8ToIstanbul] load failed for ${entry.url}: ${loadErr.message}`));
      try { converter.destroy?.(); } catch { /* best-effort */ }
      return null;
    }

    try {
      converter.applyCoverage(v8FunctionPayload);
    } catch (applyErr) {
      console.warn(formatLogLine("warn", null, `[v8ToIstanbul] applyCoverage failed for ${entry.url}: ${applyErr.message}`));
      try { converter.destroy?.(); } catch { /* best-effort */ }
      return null;
    }

    let report;
    try {
      // toIstanbul() returns `{ [path]: FileCoverage }`; we ingest one file
      // per call so return the first (and usually only) value.
      const obj = converter.toIstanbul();
      report = obj && typeof obj === "object" ? Object.values(obj)[0] || null : null;
    } catch (toErr) {
      console.warn(formatLogLine("warn", null, `[v8ToIstanbul] toIstanbul() failed for ${entry.url}: ${toErr.message}`));
      report = null;
    }

    try { converter.destroy?.(); } catch { /* best-effort */ }
    return report;
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[v8ToIstanbul] ${entry?.url || "<unknown>"}: ${err?.message || err}`));
    return null;
  }
}

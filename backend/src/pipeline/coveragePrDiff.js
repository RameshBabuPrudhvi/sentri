/**
 * @module pipeline/coveragePrDiff
 * @description AUTO-009d — PR-scoped coverage diff helper (the Codecov play).
 *
 * Coverage percent is a vanity metric. What developers actually want from a
 * PR check is: of the lines I changed in THIS PR, which are NOT covered?
 * That is what Codecov / Coveralls own. This module computes the answer.
 *
 * ### Inputs
 *
 * - `coveredLinesByFile` — Map `sourcePath -> Set<number>` of head-side line
 *   numbers exercised by the run. MUST be in original-source coordinates
 *   (post-AUTO-009b source-map resolution), not bundle coordinates —
 *   otherwise the diff filter has nothing to match against the PR's
 *   `src/Cart.tsx:42-58` ranges. Populated by the aggregator's `outRef`
 *   side channel; the persisted `coverageSummary` shape stays unchanged.
 *
 * - `totalLinesByFile` — Parallel `sourcePath -> number` map of the highest
 *   line number ever seen per source file. Used to clamp PR ranges to
 *   in-file lines — a PR adding lines 100-110 to a 50-line file would
 *   otherwise demand coverage for non-existent code (the bundle's
 *   whitespace tail past source-map mapping).
 *
 * - `changedFileRanges` — Object mapping `filename -> Array<[start, end]>`
 *   from `getChangedFileRangesForPr()` (AUTO-009d hunk parser). Head-side
 *   inclusive line numbers. Files NOT present in this map (binary, renamed
 *   without content change, past pagination cap) contribute nothing —
 *   PR-coverage is undefined for them, NOT zero.
 *
 * ### Output shape
 *
 *     {
 *       prTotalLines:    47,
 *       prCoveredLines:  34,
 *       prCoveragePct:   0.72,
 *       uncoveredChangedLines: [{ file, line }],  // sorted, capped at 200
 *       filesAnalyzed:   3,
 *       filesSkipped:    1,
 *       perFile: [{ file, changedLines, coveredLines, coveragePct, uncoveredLines }],
 *     }
 *
 * When `changedFileRanges` is empty (no PR context — e.g. crawl-only run)
 * the helper returns `null` so consumers fall through their nullish guards.
 *
 * Pure function — no I/O, no DB. Bad inputs degrade to `null`.
 */

const UNCOVERED_LINE_CAP = 200;
const PER_FILE_UNCOVERED_CAP = 25;
const TABLE_FILE_CAP = 12;

/**
 * Compute PR-scoped coverage from per-source covered-line sets and the
 * PR's changed line ranges.
 *
 * @param {Object} args
 * @param {Object} args.coveredLinesByFile
 * @param {Object} [args.totalLinesByFile]
 * @param {Object} args.changedFileRanges
 * @returns {Object|null}
 */
export function computePrCoverage({
  coveredLinesByFile,
  totalLinesByFile = {},
  changedFileRanges,
} = {}) {
  if (!changedFileRanges || typeof changedFileRanges !== "object") return null;
  const fileNames = Object.keys(changedFileRanges);
  if (fileNames.length === 0) return null;

  let prTotalLines = 0;
  let prCoveredLines = 0;
  const uncoveredChangedLines = [];
  let filesAnalyzed = 0;
  let filesSkipped = 0;
  const perFileMap = new Map();

  for (const file of fileNames) {
    const ranges = changedFileRanges[file];
    if (!Array.isArray(ranges) || ranges.length === 0) {
      filesSkipped++;
      continue;
    }
    const coveredSet = coveredLinesByFile?.[file];
    // No coverage data for this file — it was either not exercised by the
    // run, or post-source-map resolution didn't land any lines on it.
    // Both cases are "unknown coverage", NOT "0% coverage" — skip the file
    // so the gate evaluator doesn't demand impossible coverage on files
    // the run physically couldn't see (e.g. server-only source paths on a
    // browser-only test suite).
    if (!coveredSet || !(coveredSet instanceof Set)) {
      filesSkipped++;
      continue;
    }
    const fileTotalLines = Number(totalLinesByFile?.[file]);
    const maxLine = Number.isFinite(fileTotalLines) && fileTotalLines > 0
      ? fileTotalLines : Infinity;
    let fileChanged = 0;
    let fileCovered = 0;
    const fileUncovered = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length < 2) continue;
      const [start, end] = range;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      for (let line = start; line <= end; line++) {
        // Clamp to the file's known line count — a PR-claimed line past
        // the executed file's range is either a build artifact or a
        // source-map gap. Treating it as uncovered would permanently
        // fail the gate on every diff adding trailing whitespace.
        if (line > maxLine) continue;
        fileChanged++;
        prTotalLines++;
        if (coveredSet.has(line)) {
          fileCovered++;
          prCoveredLines++;
        } else {
          if (fileUncovered.length < PER_FILE_UNCOVERED_CAP) fileUncovered.push(line);
          if (uncoveredChangedLines.length < UNCOVERED_LINE_CAP) {
            uncoveredChangedLines.push({ file, line });
          }
        }
      }
    }
    if (fileChanged > 0) {
      filesAnalyzed++;
      perFileMap.set(file, { changed: fileChanged, covered: fileCovered, uncovered: fileUncovered });
    } else {
      filesSkipped++;
    }
  }

  // Empty intersection — PR touched lines but none lived in any executed
  // file. Return a structured zero (not null) so the gate evaluator + UI
  // render deterministic "0 / 0" rather than fall through to an
  // undefined-shape error.
  if (prTotalLines === 0 && filesAnalyzed === 0) {
    return {
      prTotalLines: 0,
      prCoveredLines: 0,
      prCoveragePct: 0,
      uncoveredChangedLines: [],
      filesAnalyzed: 0,
      filesSkipped,
      perFile: [],
    };
  }

  // Deterministic sort (file ASC, line ASC) so snapshot tests are stable.
  uncoveredChangedLines.sort((a, b) => {
    if (a.file < b.file) return -1;
    if (a.file > b.file) return 1;
    return a.line - b.line;
  });

  // Worst-offender-first for the markdown table.
  const perFile = Array.from(perFileMap.entries())
    .map(([file, agg]) => ({
      file,
      changedLines: agg.changed,
      coveredLines: agg.covered,
      coveragePct: agg.changed > 0 ? agg.covered / agg.changed : 0,
      uncoveredLines: agg.uncovered,
    }))
    .sort((a, b) => {
      const ua = a.changedLines - a.coveredLines;
      const ub = b.changedLines - b.coveredLines;
      if (ua !== ub) return ub - ua;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    });

  return {
    prTotalLines,
    prCoveredLines,
    prCoveragePct: prTotalLines > 0 ? prCoveredLines / prTotalLines : 0,
    uncoveredChangedLines,
    filesAnalyzed,
    filesSkipped,
    perFile,
  };
}

/**
 * Render the GitHub PR Check summary markdown for the "Coverage of changed
 * lines" section. Slots cleanly into `runResultFormatters.js` —
 * regressed-tests / gate / vitals sections are unaffected.
 *
 * Files past TABLE_FILE_CAP collapse into "+ N more file(s)" so the
 * summary stays inside GitHub's 65k-char check-output cap on big PRs.
 *
 * @param {Object|null} prDiff
 * @returns {string} Markdown body. Empty string when prDiff is null.
 */
export function renderPrCoverageMd(prDiff) {
  if (!prDiff || typeof prDiff !== "object") return "";
  if (!prDiff.filesAnalyzed && !prDiff.prTotalLines) return "";

  const pct = Math.round((prDiff.prCoveragePct || 0) * 100);
  const out = [
    "### Coverage of changed lines",
    "",
    `**${pct}% (${prDiff.prCoveredLines} / ${prDiff.prTotalLines})** of PR-touched lines exercised across ${prDiff.filesAnalyzed} file(s).`,
  ];

  const files = Array.isArray(prDiff.perFile) ? prDiff.perFile : [];
  if (files.length > 0) {
    out.push("", "| File | Coverage | Uncovered lines |", "|---|---|---|");
    for (const f of files.slice(0, TABLE_FILE_CAP)) {
      const filePct = Math.round((f.coveragePct || 0) * 100);
      const uncovered = Array.isArray(f.uncoveredLines) ? f.uncoveredLines : [];
      const visibleLines = uncovered.slice(0, 8);
      const remaining = uncovered.length - visibleLines.length;
      let lineList;
      if (visibleLines.length === 0) {
        lineList = "—";
      } else {
        lineList = `❌ ${visibleLines.join(", ")}`;
        if (remaining > 0) lineList += `, +${remaining} more`;
      }
      out.push(`| \`${f.file}\` | ${filePct}% (${f.coveredLines}/${f.changedLines}) | ${lineList} |`);
    }
    if (files.length > TABLE_FILE_CAP) {
      out.push("", `_+ ${files.length - TABLE_FILE_CAP} more file(s) — see RunDetail for the full breakdown._`);
    }
  }
  return out.join("\n");
}

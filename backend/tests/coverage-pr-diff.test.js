/**
 * AUTO-009d — pure-function unit tests for coveragePrDiff.
 *
 * Follows REVIEW.md house style: direct `node:assert/strict`, async main,
 * no `node:test` framework import.
 */
import assert from "node:assert/strict";
import { computePrCoverage, renderPrCoverageMd } from "../src/pipeline/coveragePrDiff.js";

async function main() {
  // ── null when no changedFileRanges ──────────────────────────────────────
  assert.equal(computePrCoverage({}), null, "empty args → null");
  assert.equal(computePrCoverage({ changedFileRanges: {} }), null, "empty ranges → null");
  assert.equal(computePrCoverage({ changedFileRanges: null }), null, "null ranges → null");

  // ── basic happy path ───────────────────────────────────────────────────
  {
    const coveredLinesByFile = {
      "src/Cart.tsx": new Set([42, 43, 44, 45, 46, 47, 48, 50, 52, 53, 54]),
    };
    const totalLinesByFile = { "src/Cart.tsx": 200 };
    const changedFileRanges = {
      "src/Cart.tsx": [[42, 58]],
    };
    const result = computePrCoverage({ coveredLinesByFile, totalLinesByFile, changedFileRanges });
    assert.ok(result, "non-null for matching file");
    assert.equal(result.prTotalLines, 17, "42..58 = 17 lines");
    assert.equal(result.prCoveredLines, 11, "11 lines in the covered set");
    assert.equal(result.filesAnalyzed, 1);
    assert.ok(result.prCoveragePct > 0.6 && result.prCoveragePct < 0.7,
      `prCoveragePct ~64%: got ${result.prCoveragePct}`);
    // Uncovered lines: 49, 51, 55, 56, 57, 58
    assert.ok(result.uncoveredChangedLines.length === 6, "6 uncovered lines");
    assert.equal(result.uncoveredChangedLines[0].file, "src/Cart.tsx");
    assert.equal(result.uncoveredChangedLines[0].line, 49);
  }

  // ── file with no coverage data → skipped, not zero ─────────────────────
  {
    const result = computePrCoverage({
      coveredLinesByFile: {},
      changedFileRanges: { "unknown.ts": [[1, 10]] },
    });
    assert.ok(result, "non-null (structured zero)");
    assert.equal(result.prTotalLines, 0, "no lines counted");
    assert.equal(result.filesSkipped, 1, "file skipped");
    assert.equal(result.filesAnalyzed, 0);
  }

  // ── line clamping past file total ──────────────────────────────────────
  {
    const result = computePrCoverage({
      coveredLinesByFile: { "small.js": new Set([1, 2]) },
      totalLinesByFile: { "small.js": 5 },
      changedFileRanges: { "small.js": [[1, 100]] },
    });
    assert.equal(result.prTotalLines, 5, "clamped to file total (5)");
  }

  // ── renderPrCoverageMd ─────────────────────────────────────────────────
  assert.equal(renderPrCoverageMd(null), "", "null → empty");
  assert.equal(renderPrCoverageMd({}), "", "empty obj → empty");
  {
    const md = renderPrCoverageMd({
      prTotalLines: 15,
      prCoveredLines: 11,
      prCoveragePct: 0.733,
      filesAnalyzed: 1,
      filesSkipped: 0,
      perFile: [
        { file: "src/Cart.tsx", changedLines: 15, coveredLines: 11, coveragePct: 0.733, uncoveredLines: [49, 51, 55, 57] },
      ],
      uncoveredChangedLines: [],
    });
    assert.ok(md.includes("### Coverage of changed lines"), "header present");
    assert.ok(md.includes("73%"), "rounded pct");
    assert.ok(md.includes("src/Cart.tsx"), "file in table");
    assert.ok(md.includes("49"), "uncovered line in table");
  }

  // ── deterministic sort ─────────────────────────────────────────────────
  {
    const result = computePrCoverage({
      coveredLinesByFile: {
        "b.ts": new Set([1]),
        "a.ts": new Set([1]),
      },
      totalLinesByFile: { "a.ts": 10, "b.ts": 10 },
      changedFileRanges: {
        "b.ts": [[2, 3]],
        "a.ts": [[2, 3]],
      },
    });
    // Uncovered list must be sorted file ASC, line ASC.
    assert.equal(result.uncoveredChangedLines[0].file, "a.ts");
    assert.equal(result.uncoveredChangedLines[1].file, "a.ts");
    assert.equal(result.uncoveredChangedLines[2].file, "b.ts");
  }

  console.log("coverage-pr-diff.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

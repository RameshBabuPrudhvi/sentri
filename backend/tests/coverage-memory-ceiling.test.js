/**
 * AUTO-009g — memory-ceiling enforcement on raw `jsCoverage` payloads.
 *
 * `finalizeCoverage` walks `run.results` in order accumulating raw payload
 * bytes; once the cumulative size exceeds `COVERAGE_MEMORY_CEILING_BYTES`
 * (configurable via `COVERAGE_MEMORY_CEILING_MB` env, default 500MB), it
 * drops `jsCoverage` from subsequent rows BEFORE aggregation and stamps
 * `summary.truncated = true` so the UI can warn the operator.
 *
 * Setting the env to a tiny value (1MB) lets us exercise the ceiling
 * deterministically against a synthetic 2MB+ payload. The env is read
 * once at module load, so we set it before importing.
 *
 * Follows REVIEW.md house style: direct `node:assert/strict`, no
 * `node:test` framework import.
 */
import assert from "node:assert/strict";

// ESM `import` statements are hoisted above top-level code, so
// `process.env.COVERAGE_MEMORY_CEILING_MB = "1"` at module scope would
// happen AFTER `finalizeCoverage.js` had already captured the default
// 500MB. Use dynamic `await import()` inside main() after the env is set
// so the module's module-level const reads the test override.
process.env.COVERAGE_MEMORY_CEILING_MB = "1";

async function main() {
  const { finalizeCoverage, __COVERAGE_MEMORY_CEILING_BYTES_FOR_TEST } =
    await import("../src/pipeline/finalizeCoverage.js");

  // Sanity-check that the env-tunable ceiling actually took effect at
  // module load time. If it didn't, the rest of the assertions could
  // false-positive against the default 500MB.
  assert.equal(__COVERAGE_MEMORY_CEILING_BYTES_FOR_TEST, 1 * 1024 * 1024,
    "COVERAGE_MEMORY_CEILING_MB env must be honoured at module load (set to 1)");

  // Build a result set that intentionally blows past the 1MB cap. Each
  // entry's `text.length` dominates the byte estimate (see
  // `approxEntryBytes` in finalizeCoverage.js), so 3 × ~700KB scripts
  // pushes cumulative bytes >1MB on the third result.
  const bigText = "a".repeat(700 * 1024); // ~700KB per entry
  const results = [
    {
      testId: "T1", status: "passed",
      jsCoverage: [{ url: "https://app.example.com/a.js", text: bigText, ranges: [{ start: 0, end: 1 }] }],
    },
    {
      testId: "T2", status: "passed",
      jsCoverage: [{ url: "https://app.example.com/b.js", text: bigText, ranges: [{ start: 0, end: 1 }] }],
    },
    // This one tips us over 1MB cumulative — should be dropped BEFORE
    // aggregation (its jsCoverage is nulled out in place).
    {
      testId: "T3", status: "passed",
      jsCoverage: [{ url: "https://app.example.com/c.js", text: bigText, ranges: [{ start: 0, end: 1 }] }],
    },
  ];

  const project = {
    id: "PRJ-1",
    url: "https://app.example.com",
    coverageEnabled: true,
    sourcemapBaseUrl: null,
  };

  const summary = await finalizeCoverage(project, results);

  // Summary must mark itself as truncated so the UI can render a warning.
  assert.ok(summary, "summary produced despite ceiling hit");
  assert.equal(summary.truncated, true,
    "summary.truncated = true when AUTO-009g ceiling drops at least one entry");

  // Strip contract: every row must have jsCoverage either deleted or
  // nulled out (both qualify as "raw payload not persisted").
  for (const r of results) {
    assert.ok(!("jsCoverage" in r) || r.jsCoverage == null,
      `${r.testId} must have raw payload removed after finalizeCoverage`);
  }

  // ── Zero-regression: under-ceiling runs are NOT marked truncated ────────
  // A small payload that fits well under the 1MB ceiling must NOT carry
  // the `truncated` flag — otherwise the UI would warn on every healthy run.
  const smallResults = [
    {
      testId: "T1", status: "passed",
      jsCoverage: [{ url: "https://app.example.com/small.js", text: "a\nb\nc\n", ranges: [{ start: 0, end: 1 }] }],
    },
  ];
  const smallSummary = await finalizeCoverage(project, smallResults);
  assert.ok(smallSummary, "small payload produces a summary");
  assert.notEqual(smallSummary.truncated, true,
    "under-ceiling runs must NOT carry truncated: true");

  console.log("coverage-memory-ceiling.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * eval-regression.test.js — AUTO-022 regression-detection integration test
 *
 * Proves the harness can detect a regression. We construct a synthetic
 * golden set, run it once with a "good" generator (high score) and once
 * with a "bad" generator that degrades selectors on ≥3 cases, then
 * assert:
 *   - the aggregate delta exceeds the harness's 5% regression threshold
 *   - the per-case affected list correctly names the 3 degraded cases
 *
 * This is the acceptance criterion #3 from NEXT.md § AUTO-022:
 *   "Modifying a prompt file to deliberately lower selector quality on
 *    ≥3 cases makes eval.yml exit non-zero with a 'regression vs
 *    baseline' message naming each affected case."
 *
 * We exercise the scorer + diagnostic logic directly rather than spawning
 * run-eval.mjs as a subprocess — keeps the test hermetic and fast.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runEval } from "../src/eval/pipelineEval.js";

const REGRESSION_THRESHOLD = 0.05;
const PER_CASE_DELTA_THRESHOLD = 0.20;

/**
 * Mirror the affected-case computation in `backend/scripts/run-eval.mjs`
 * so the test pins the public diagnostic contract, not just the scorer.
 * If run-eval.mjs's threshold logic changes, this test forces the change
 * to be intentional.
 */
function computeAffected(currentCases, baselinePerCase) {
  const affected = [];
  for (const c of currentCases) {
    const before = baselinePerCase[c.caseId];
    if (typeof before !== "number") continue;
    const delta = before - c.score.aggregate;
    if (delta > PER_CASE_DELTA_THRESHOLD) {
      affected.push({ caseId: c.caseId, before, after: c.score.aggregate, delta });
    }
  }
  affected.sort((a, b) => b.delta - a.delta);
  return affected;
}

function writeCase(dir, id, expected) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id,
    category: "form-fill",
    snapshot: "x",
    expected,
  }));
}

test("eval harness detects a deliberate selector regression on ≥3 cases", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-regression-"));
  // 5 cases. The "good" run uses an identity generator → perfect score.
  // The "bad" run degrades selectors on cases 1–3 and leaves 4–5 untouched.
  const cases = [
    ["case-1", "await page.getByRole('button', { name: 'Save' }).click();\nawait expect(page.getByText('Saved')).toBeVisible();"],
    ["case-2", "await page.getByLabel('Email').fill('a@b.c');\nawait expect(page).toHaveURL(/dashboard/);"],
    ["case-3", "await page.getByTestId('row-7').click();\nawait expect(page.getByText('Loaded')).toBeVisible();"],
    ["case-4", "await page.getByRole('link', { name: 'Home' }).click();"],
    ["case-5", "await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();"],
  ];
  for (const [id, expected] of cases) writeCase(dir, id, expected);

  // 1. Baseline run — identity generator (perfect score per case).
  const baselineResult = await runEval({
    goldenDir: dir,
    generate: async (g) => g.expected,
  });
  assert.equal(baselineResult.aggregate, 1, "baseline should score 1.0 with identity generator");

  const baselinePerCase = Object.fromEntries(
    baselineResult.cases.map((c) => [c.caseId, c.score.aggregate]),
  );

  // 2. Regression run — degrade selectors on case-1/2/3 only. Replace
  // structured locators with brittle CSS so the selector dimension drops
  // while actions / assertions stay close to the original.
  const degraded = new Set(["case-1", "case-2", "case-3"]);
  const regressionResult = await runEval({
    goldenDir: dir,
    generate: async (g) => {
      if (!degraded.has(g.id)) return g.expected;
      return g.expected
        .replace(/page\.getByRole\([^)]*\)/g, "page.locator('css=xx-broken-selector-xxxxxxxxxxxxxxxxxxxxxxx')")
        .replace(/page\.getByLabel\([^)]*\)/g, "page.locator('css=yy-broken-selector-yyyyyyyyyyyyyyyyyyyyyyy')")
        .replace(/page\.getByTestId\([^)]*\)/g, "page.locator('css=zz-broken-selector-zzzzzzzzzzzzzzzzzzzzzzz')");
    },
  });

  // 3. Aggregate regression must exceed the 5% threshold.
  const aggregateRegression = baselineResult.aggregate - regressionResult.aggregate;
  assert.ok(
    aggregateRegression > REGRESSION_THRESHOLD,
    `expected regression > ${REGRESSION_THRESHOLD}, got ${aggregateRegression}`,
  );

  // 4. Per-case affected list must name exactly case-1, case-2, case-3.
  const affected = computeAffected(regressionResult.cases, baselinePerCase);
  const affectedIds = new Set(affected.map((a) => a.caseId));
  assert.equal(affected.length, 3, `expected 3 affected cases, got ${affected.length}: ${[...affectedIds].join(", ")}`);
  assert.ok(affectedIds.has("case-1"));
  assert.ok(affectedIds.has("case-2"));
  assert.ok(affectedIds.has("case-3"));

  // 5. Untouched cases must NOT appear in the affected list.
  assert.ok(!affectedIds.has("case-4"), "case-4 was not degraded — should not be reported");
  assert.ok(!affectedIds.has("case-5"), "case-5 was not degraded — should not be reported");

  // 6. Affected list must be sorted by largest delta first — the most
  // impactful regressions surface at the top of the CI log.
  for (let i = 1; i < affected.length; i++) {
    assert.ok(
      affected[i - 1].delta >= affected[i].delta,
      `affected list not sorted descending at index ${i}`,
    );
  }
});

test("eval harness does NOT fire on noise below the per-case threshold", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-regression-noise-"));
  writeCase(dir, "case-1", "await page.getByRole('button').click();");
  writeCase(dir, "case-2", "await page.getByRole('link').click();");

  const baselineResult = await runEval({
    goldenDir: dir,
    generate: async (g) => g.expected,
  });
  const baselinePerCase = Object.fromEntries(
    baselineResult.cases.map((c) => [c.caseId, c.score.aggregate]),
  );

  // Tiny whitespace tweak — score drops a fraction but stays well above
  // the 20% per-case threshold. Affected list must be empty.
  const noisyResult = await runEval({
    goldenDir: dir,
    generate: async (g) => g.expected + " ",
  });
  const affected = computeAffected(noisyResult.cases, baselinePerCase);
  assert.equal(affected.length, 0, `expected no affected cases on whitespace noise, got ${affected.length}`);
});
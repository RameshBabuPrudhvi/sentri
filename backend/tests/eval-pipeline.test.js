/**
 * eval-pipeline.test.js — AUTO-022 scorer unit tests
 *
 * Covers all six exports from `pipelineEval.js`. The scorer is pure, so
 * tests stay deterministic without mocking the LLM. Integration of the
 * full record/replay loop is exercised separately by run-eval.mjs in CI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  levenshtein,
  scoreText,
  parseTuples,
  scoreCase,
  loadGoldens,
  runEval,
  MAX_DIMENSION_BYTES,
  DEFAULT_WEIGHTS,
} from "../src/eval/pipelineEval.js";

test("levenshtein — classic kitten/sitting case", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
});

test("levenshtein — empty strings", () => {
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("abc", ""), 3);
  assert.equal(levenshtein("", "abc"), 3);
});

test("levenshtein — truncates above MAX_DIMENSION_BYTES instead of crashing", () => {
  const huge = "a".repeat(MAX_DIMENSION_BYTES * 2);
  // Both inputs are truncated to the same prefix → distance is 0.
  assert.equal(levenshtein(huge, huge), 0);
});

test("scoreText — identical strings score 1.0", () => {
  assert.equal(scoreText("hello world", "hello world"), 1);
});

test("scoreText — completely disjoint strings score near 0", () => {
  const score = scoreText("aaaa", "bbbb");
  assert.ok(score >= 0 && score <= 0.1, `expected near 0, got ${score}`);
});

test("scoreText — handles null / undefined gracefully", () => {
  // Both empty → maxLen=1, dist=0 → score 1 (vacuously equal).
  assert.equal(scoreText(null, null), 1);
  assert.equal(scoreText(undefined, "x"), 0);
});

test("parseTuples — classifies selectors / actions / assertions", () => {
  const code = [
    "const btn = page.getByRole('button', { name: 'Save' });",
    "await btn.click();",
    "await expect(page.getByText('Saved')).toBeVisible();",
  ].join("\n");
  const { selectors, actions, assertions } = parseTuples(code);
  assert.match(selectors, /getByRole/);
  assert.match(actions, /\.click\(/);
  assert.match(assertions, /toBeVisible/);
  // Assertion line contains getByText — must NOT also appear under selectors.
  assert.doesNotMatch(selectors, /getByText/);
});

test("parseTuples — empty input → empty buckets", () => {
  const { selectors, actions, assertions } = parseTuples("");
  assert.equal(selectors, "");
  assert.equal(actions, "");
  assert.equal(assertions, "");
});

test("parseTuples — selector lines sort for stability (declaration-order swap doesn't lower score)", () => {
  const a = parseTuples("page.getByRole('a');\npage.getByRole('b');");
  const b = parseTuples("page.getByRole('b');\npage.getByRole('a');");
  assert.equal(a.selectors, b.selectors);
});

test("scoreCase — identical code scores perfect aggregate", () => {
  const code = "await page.getByRole('button').click();\nawait expect(page.getByText('Done')).toBeVisible();";
  const score = scoreCase(code, code);
  assert.equal(score.aggregate, 1);
  assert.equal(score.selectors, 1);
  assert.equal(score.actions, 1);
  assert.equal(score.assertions, 1);
});

test("scoreCase — DEFAULT_WEIGHTS sum to 1.0", () => {
  const sum = DEFAULT_WEIGHTS.selectors + DEFAULT_WEIGHTS.actions + DEFAULT_WEIGHTS.assertions;
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}, expected 1`);
});

test("scoreCase — selector-bearing action lines drop the action dimension, not selectors", () => {
  // Both lines contain selectors (`.getByRole(` / `.locator(`) AND an action
  // (`.click(`). Per parseTuples' priority cascade (assertion > action >
  // selector at pipelineEval.js:121-128), they land in the `actions` bucket,
  // so changing the selector portion changes the actions string. The pure
  // selector bucket stays empty in both expected and actual → scoreText("","")
  // is 1.0 (vacuously equal). This pins the documented bucketing behaviour.
  const expected = "await page.getByRole('button').click();\nawait expect(page.getByText('Done')).toBeVisible();";
  const actual = "await page.locator('css=button#xyz123abcdef').click();\nawait expect(page.getByText('Done')).toBeVisible();";
  const score = scoreCase(actual, expected);
  assert.equal(score.selectors, 1, "no pure-selector lines → selectors stay 1.0");
  assert.ok(score.actions < 0.9, `actions should drop (selector embedded in action line), got ${score.actions}`);
  assert.equal(score.assertions, 1);
});

test("scoreCase — pure-selector declaration changes drop the selector dimension", () => {
  // A bare `const x = page.getBy...()` line has no action or assertion verb,
  // so parseTuples files it under selectors. Changing the selector across
  // the two inputs should drop only the selector score.
  const expected = "const btn = page.getByRole('button', { name: 'Save' });\nawait btn.click();";
  const actual = "const btn = page.locator('css=button#xyz123abcdef');\nawait btn.click();";
  const score = scoreCase(actual, expected);
  assert.ok(score.selectors < 0.9, `selectors should drop, got ${score.selectors}`);
  assert.equal(score.actions, 1);
  assert.equal(score.assertions, 1);
});

test("loadGoldens — reads JSON files, applies defaults, skips non-JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goldens-"));
  fs.writeFileSync(path.join(dir, "case-a.json"), JSON.stringify({
    snapshot: "<button>x</button>",
    expected: "await page.click()",
  }));
  fs.writeFileSync(path.join(dir, "case-b.json"), JSON.stringify({
    id: "explicit-id",
    category: "form-fill",
    snapshot: "<input/>",
    expected: "await page.fill('input', 'x')",
  }));
  fs.writeFileSync(path.join(dir, "README.md"), "ignored");

  const goldens = loadGoldens(dir);
  assert.equal(goldens.length, 2);
  assert.equal(goldens[0].id, "case-a");
  assert.equal(goldens[0].category, "uncategorised");
  assert.equal(goldens[1].id, "explicit-id");
  assert.equal(goldens[1].category, "form-fill");
});

test("loadGoldens — resolves @file: snapshot references", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goldens-"));
  fs.mkdirSync(path.join(dir, "snapshots"));
  fs.writeFileSync(path.join(dir, "snapshots", "big.html"), "<html>big</html>");
  fs.writeFileSync(path.join(dir, "case-a.json"), JSON.stringify({
    snapshot: "@file:snapshots/big.html",
    expected: "noop",
  }));
  const [golden] = loadGoldens(dir);
  assert.equal(golden.snapshot, "<html>big</html>");
});

test("runEval — aggregates per-case scores and groups by category", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goldens-"));
  fs.writeFileSync(path.join(dir, "case-1.json"), JSON.stringify({
    category: "form-fill",
    snapshot: "x",
    expected: "await page.fill('input', 'x');",
  }));
  fs.writeFileSync(path.join(dir, "case-2.json"), JSON.stringify({
    category: "form-fill",
    snapshot: "x",
    expected: "await page.click('button');",
  }));
  fs.writeFileSync(path.join(dir, "case-3.json"), JSON.stringify({
    category: "modal",
    snapshot: "x",
    expected: "await expect(page.getByText('hi')).toBeVisible();",
  }));

  // Identity generator → every case scores 1.0.
  const perfect = await runEval({ goldenDir: dir, generate: async (g) => g.expected });
  assert.equal(perfect.aggregate, 1);
  assert.equal(perfect.cases.length, 3);
  assert.equal(perfect.byCategory["form-fill"].count, 2);
  assert.equal(perfect.byCategory["modal"].count, 1);
  assert.equal(perfect.byCategory["form-fill"].aggregate, 1);

  // Constant-empty generator → every case scores 0.
  const empty = await runEval({ goldenDir: dir, generate: async () => "" });
  assert.equal(empty.aggregate, 0);
});

test("runEval — deterministic across repeated invocations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goldens-"));
  fs.writeFileSync(path.join(dir, "case-1.json"), JSON.stringify({
    snapshot: "x",
    expected: "await page.getByRole('button').click();",
  }));
  // Generator returns a deliberately-different-but-fixed string so the
  // score is non-trivial AND reproducible.
  const generate = async () => "await page.locator('button').click();";
  const a = await runEval({ goldenDir: dir, generate });
  const b = await runEval({ goldenDir: dir, generate });
  assert.equal(a.aggregate, b.aggregate);
  assert.deepEqual(
    a.cases.map((c) => c.score),
    b.cases.map((c) => c.score),
  );
});

/**
 * pipelineEval.js — AUTO-022 deterministic scorer
 *
 * Pure functions: given an `actual` and `expected` Playwright code string,
 * extract selectors / actions / assertions tuples and score each dimension
 * via length-normalised Levenshtein distance. The harness (run-eval.mjs)
 * supplies the `generate` adapter that turns a golden snapshot into the
 * `actual` string — the scorer never calls the LLM directly, which keeps
 * it deterministic and unit-testable in isolation.
 *
 * Inputs are bounded to MAX_DIMENSION_BYTES per dimension to keep the
 * Levenshtein O(n*m) table from blowing up on multi-KB generated code.
 */
import fs from "node:fs";
import path from "node:path";
// Per-dimension input cap. 8 KB is well above any realistic generated
// selector / action / assertion block but small enough that the DP table
// stays bounded. Inputs are truncated, not rejected, so a runaway
// generation degrades the score gracefully instead of crashing the eval.
export const MAX_DIMENSION_BYTES = 8 * 1024;
export function levenshtein(a = "", b = "") {
  const aStr = String(a).slice(0, MAX_DIMENSION_BYTES);
  const bStr = String(b).slice(0, MAX_DIMENSION_BYTES);
  const m = aStr.length;
  const n = bStr.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Two-row rolling buffer — O(min(m,n)) memory instead of O(m*n).
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const c = aStr[i - 1] === bStr[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + c);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
export function scoreText(actual, expected) {
  const a = String(actual ?? "").slice(0, MAX_DIMENSION_BYTES);
  const b = String(expected ?? "").slice(0, MAX_DIMENSION_BYTES);
  const maxLen = Math.max(a.length, b.length, 1);
  return 1 - levenshtein(a, b) / maxLen;
}
// Pattern catalogue — extend here when prompts emit new locator / action /
// assertion forms. Kept as constants so they can be audited from a single
// place and reused in tests.
const SELECTOR_PATTERNS = [
  /\.locator\(/,
  /\.getByRole\(/,
  /\.getByText\(/,
  /\.getByLabel\(/,
  /\.getByPlaceholder\(/,
  /\.getByTestId\(/,
  /\.getByTitle\(/,
  /\.getByAltText\(/,
  /\.frameLocator\(/,
];
const ACTION_PATTERNS = [
  /\.click\(/,
  /\.dblclick\(/,
  /\.fill\(/,
  /\.type\(/,
  /\.press\(/,
  /\.check\(/,
  /\.uncheck\(/,
  /\.selectOption\(/,
  /\.hover\(/,
  /\.focus\(/,
  /\.setInputFiles\(/,
  /\.goto\(/,
  /\.waitForURL\(/,
  /\.waitForSelector\(/,
];
const ASSERTION_PATTERNS = [
  /\bexpect\(/,
  /\.toBeVisible\(/,
  /\.toBeHidden\(/,
  /\.toBeEnabled\(/,
  /\.toBeDisabled\(/,
  /\.toBeChecked\(/,
  /\.toHaveText\(/,
  /\.toContainText\(/,
  /\.toHaveValue\(/,
  /\.toHaveURL\(/,
  /\.toHaveTitle\(/,
  /\.toHaveAttribute\(/,
  /\.toHaveCount\(/,
  /\.toHaveClass\(/,
];
function matchesAny(line, patterns) {
  for (const re of patterns) {
    if (re.test(line)) return true;
  }
  return false;
}
/**
 * Split Playwright code into selector / action / assertion buckets.
 *
 * Assertions are matched first because a line like
 *   `await expect(page.getByRole('button')).toBeVisible();`
 * contains both a selector and an assertion — counting it as a selector
 * would under-weight the assertion dimension. Pure-selector lines (e.g.
 * `const btn = page.getByRole('button');`) still land in `selectors`.
 *
 * Action and assertion order is preserved (clicking "Submit" before
 * filling the form is semantically different from the reverse). Selectors
 * are sorted for stability since a declaration-order swap is irrelevant.
 */
export function parseTuples(code = "") {
  const lines = String(code ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const selectors = [];
  const actions = [];
  const assertions = [];
  for (const line of lines) {
    if (matchesAny(line, ASSERTION_PATTERNS)) {
      assertions.push(line);
    } else if (matchesAny(line, ACTION_PATTERNS)) {
      actions.push(line);
    } else if (matchesAny(line, SELECTOR_PATTERNS)) {
      selectors.push(line);
    }
  }
  selectors.sort();
  return {
    selectors: selectors.join("\n"),
    actions: actions.join("\n"),
    assertions: assertions.join("\n"),
  };
}
export const DEFAULT_WEIGHTS = Object.freeze({ selectors: 0.4, actions: 0.3, assertions: 0.3 });
export function scoreCase(actualCode, expectedCode, weights = DEFAULT_WEIGHTS) {
  const actual = parseTuples(actualCode);
  const expected = parseTuples(expectedCode);
  const selectors = scoreText(actual.selectors, expected.selectors);
  const actions = scoreText(actual.actions, expected.actions);
  const assertions = scoreText(actual.assertions, expected.assertions);
  const aggregate =
    selectors * weights.selectors +
    actions * weights.actions +
    assertions * weights.assertions;
  return { selectors, actions, assertions, aggregate };
}
/**
 * Resolve `@file:relative/path` snapshot references against `goldenDir`.
 * Large DOM snapshots live under `snapshots/` to keep the JSON goldens
 * scannable; the loader inlines them transparently.
 */
function resolveSnapshot(snapshot, goldenDir) {
  if (typeof snapshot !== "string") return snapshot;
  if (!snapshot.startsWith("@file:")) return snapshot;
  const rel = snapshot.slice("@file:".length);
  const abs = path.join(goldenDir, rel);
  return fs.readFileSync(abs, "utf8");
}
export function loadGoldens(goldenDir) {
  return fs.readdirSync(goldenDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = JSON.parse(fs.readFileSync(path.join(goldenDir, name), "utf8"));
      return {
        name,
        id: raw.id || name.replace(/\.json$/, ""),
        category: raw.category || "uncategorised",
        description: raw.description || "",
        url: raw.url || "",
        snapshot: resolveSnapshot(raw.snapshot, goldenDir),
        expected: raw.expected,
      };
    });
}
/**
 * runEval — orchestrate the scorer over every golden.
 *
 * `generate` is async — both the live and replay adapters return promises.
 * Cases are scored sequentially to keep the LLM call rate predictable in
 * record mode; replay mode is fast enough that serial scoring is a non-issue.
 *
 * @param {object}   opts
 * @param {string}   opts.goldenDir   Directory holding `case-*.json`
 * @param {function} opts.generate    async (golden) → actualCode string
 * @param {object}   [opts.weights]   Per-dimension weights (default 40/30/30)
 * @returns {Promise<{ aggregate: number, cases: Array, byCategory: object }>}
 */
export async function runEval({ goldenDir, generate, weights = DEFAULT_WEIGHTS }) {
  const goldens = loadGoldens(goldenDir);
  const cases = [];
  for (const golden of goldens) {
    const actual = await generate(golden);
    const score = scoreCase(actual, golden.expected, weights);
    cases.push({
      caseId: golden.id,
      category: golden.category,
      score,
      expected: golden.expected,
      actual,
    });
  }
  const aggregate = cases.length === 0
    ? 0
    : cases.reduce((sum, c) => sum + c.score.aggregate, 0) / cases.length;
  // Per-category breakdown so a regression localised to one category
  // (e.g. only `modal` cases get worse) surfaces in the CI log.
  const byCategory = {};
  for (const c of cases) {
    if (!byCategory[c.category]) byCategory[c.category] = { count: 0, sum: 0 };
    byCategory[c.category].count += 1;
    byCategory[c.category].sum += c.score.aggregate;
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].aggregate = byCategory[cat].sum / byCategory[cat].count;
  }
  return { aggregate, cases, byCategory };
}

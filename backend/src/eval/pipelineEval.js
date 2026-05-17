import fs from "node:fs";
import path from "node:path";

export function levenshtein(a = "", b = "") {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
    }
  }
  return dp[m][n];
}

export function scoreText(actual, expected) {
  const maxLen = Math.max(actual.length, expected.length, 1);
  return 1 - levenshtein(actual, expected) / maxLen;
}

export function parseTuples(code = "") {
  const lines = code.split("\n").map((line) => line.trim()).filter(Boolean);
  const selectors = lines.filter((line) => line.includes("locator(") || line.includes("getBy"));
  const actions = lines.filter((line) => /\.(click|fill|check|selectOption|press)\(/.test(line));
  const assertions = lines.filter((line) => line.includes("expect(") || line.includes("toHave"));
  return { selectors: selectors.join("\n"), actions: actions.join("\n"), assertions: assertions.join("\n") };
}

export function scoreCase(actualCode, expectedCode, weights = { selectors: 0.4, actions: 0.3, assertions: 0.3 }) {
  const actual = parseTuples(actualCode);
  const expected = parseTuples(expectedCode);
  const selectors = scoreText(actual.selectors, expected.selectors);
  const actions = scoreText(actual.actions, expected.actions);
  const assertions = scoreText(actual.assertions, expected.assertions);
  const aggregate = selectors * weights.selectors + actions * weights.actions + assertions * weights.assertions;
  return { selectors, actions, assertions, aggregate };
}

export function loadGoldens(goldenDir) {
  return fs.readdirSync(goldenDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(goldenDir, name), 'utf8')) }));
}

export function runEval({ goldenDir, generate }) {
  const goldens = loadGoldens(goldenDir);
  const cases = goldens.map((golden) => {
    const actual = generate(golden.snapshot, golden.expected);
    const score = scoreCase(actual, golden.expected);
    return { caseId: golden.name.replace('.json', ''), score, expected: golden.expected, actual };
  });
  const aggregate = cases.reduce((sum, c) => sum + c.score.aggregate, 0) / Math.max(cases.length, 1);
  return { aggregate, cases };
}

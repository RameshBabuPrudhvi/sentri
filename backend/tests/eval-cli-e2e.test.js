/**
 * @module tests/eval-cli-e2e
 * @description AUTO-022 end-to-end subprocess coverage.
 *
 * Unit tests already cover the scorer (`eval-pipeline.test.js`), the
 * regression-detection diagnostic logic (`eval-regression.test.js`), and
 * the `metric_samples` persistence layer (`eval-persistence.test.js`).
 * What was missing is proof that `backend/scripts/run-eval.mjs` — the
 * actual binary CI invokes — wires those layers together correctly. These
 * tests spawn the script as a subprocess against a fully synthetic golden
 * directory + baseline + cache so the binary's exit code, stdout, and
 * stderr contracts are pinned independently of CI's own goldens.
 *
 * Acceptance criteria pinned by this file (from NEXT.md § AUTO-022):
 *   AC #1 — `node backend/scripts/run-eval.mjs` exits 0 on a healthy tree
 *           and the `--report=` artifact carries one row per golden case.
 *   AC #2 — A deliberate selector-quality regression on >=3 cases makes
 *           the script exit non-zero with a "regression vs baseline"
 *           message naming each affected case in stderr.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const realScript = path.join(repoRoot, "backend", "scripts", "run-eval.mjs");
const TEST_EVAL_MODEL = "test-model";
function cacheKeyFor(golden) {
  const h = crypto.createHash("sha256");
  h.update("1");
  h.update("\0");
  h.update(TEST_EVAL_MODEL);
  h.update("\0");
  h.update(String(golden.id ?? ""));
  h.update("\0");
  h.update(String(golden.snapshot ?? ""));
  h.update("\0");
  h.update(String(golden.url ?? ""));
  return h.digest("hex").slice(0, 32);
}
function stageHarness({ goldens, baseline, cacheEntries }) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cli-e2e-"));
  const fakeScripts = path.join(tmpRoot, "backend", "scripts");
  const fakeGoldenDir = path.join(tmpRoot, "backend", "tests", "fixtures", "eval-goldens");
  const fakeCacheDir = path.join(fakeGoldenDir, ".cache");
  const fakeEvalSrc = path.join(tmpRoot, "backend", "src", "eval");
  fs.mkdirSync(fakeScripts, { recursive: true });
  fs.mkdirSync(fakeCacheDir, { recursive: true });
  fs.mkdirSync(fakeEvalSrc, { recursive: true });
  fs.copyFileSync(realScript, path.join(fakeScripts, "run-eval.mjs"));
  for (const name of ["pipelineEval.js", "pipelineAdapter.js", "evalPersistence.js"]) {
    fs.copyFileSync(
      path.join(repoRoot, "backend", "src", "eval", name),
      path.join(fakeEvalSrc, name),
    );
  }
  for (const g of goldens) {
    fs.writeFileSync(path.join(fakeGoldenDir, `${g.id}.json`), JSON.stringify(g, null, 2));
  }
  for (const [id, body] of Object.entries(cacheEntries)) {
    const golden = goldens.find((g) => g.id === id);
    const hash = cacheKeyFor(golden);
    fs.writeFileSync(path.join(fakeCacheDir, `${id}.${hash}.txt`), body, "utf8");
  }
  const baselinePath = path.join(tmpRoot, "eval-baseline.json");
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  return { scriptPath: path.join(fakeScripts, "run-eval.mjs"), tmpRoot };
}
function runScript(scriptPath, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    env: { ...process.env, EVAL_RECORD: "", EVAL_MODEL: TEST_EVAL_MODEL },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function buildGoldens() {
  return [
    { id: "case-001", category: "form-fill", url: "https://eval.local/save",
      snapshot: "<form><button>Save</button></form>",
      expected: "await page.getByRole('button', { name: 'Save' }).click();\nawait expect(page.getByText('Saved')).toBeVisible();" },
    { id: "case-002", category: "list-click", url: "https://eval.local/items",
      snapshot: "<ul><li><button>Item</button></li></ul>",
      expected: "await page.getByRole('button', { name: 'Item' }).click();\nawait expect(page.getByTestId('detail')).toContainText('Item');" },
    { id: "case-003", category: "modal", url: "https://eval.local/confirm",
      snapshot: "<button>Delete</button><div role='dialog'><button>Confirm</button></div>",
      expected: "await page.getByRole('button', { name: 'Delete' }).click();\nawait page.getByRole('button', { name: 'Confirm' }).click();\nawait expect(page.getByRole('dialog')).toBeHidden();" },
    { id: "case-004", category: "multi-page-nav", url: "https://eval.local/nav",
      snapshot: "<a href='/next'>Next</a>",
      expected: "await page.getByRole('link', { name: 'Next' }).click();\nawait expect(page).toHaveURL(/\\/next$/);" },
    { id: "case-005", category: "assertion-heavy", url: "https://eval.local/done",
      snapshot: "<h1>Done</h1>",
      expected: "await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();\nawait expect(page.getByText('Done')).toBeVisible();" },
  ];
}
function buildPerfectBaseline(goldens) {
  return {
    aggregate: 1,
    byDimension: { selectors: 1, actions: 1, assertions: 1 },
    byCategory: Object.fromEntries(goldens.map((g) => [g.category, 1])),
    perCase: Object.fromEntries(goldens.map((g) => [g.id, 1])),
    recordedAt: new Date().toISOString(),
  };
}
// ── AC #1 — Healthy tree exits 0 + report artifact is intact ─────────────
test("AC #1 — run-eval.mjs exits 0 on healthy tree and emits one report row per golden", () => {
  const goldens = buildGoldens();
  const cacheEntries = Object.fromEntries(goldens.map((g) => [g.id, g.expected]));
  const { scriptPath, tmpRoot } = stageHarness({
    goldens, baseline: buildPerfectBaseline(goldens), cacheEntries,
  });
  const reportPath = path.join(tmpRoot, "report.json");
  const { status, stdout } = runScript(scriptPath, [`--report=${reportPath}`]);
  assert.equal(status, 0, `expected exit 0, got ${status}`);
  assert.match(stdout, /PASS/, "stdout must contain PASS line");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.cases.length, 5, "one report row per golden");
  assert.equal(report.aggregate, 1, "aggregate must be 1.0 on identity cache");
  for (const c of report.cases) {
    assert.ok(c.caseId, "each report row needs a caseId");
    assert.equal(c.score.aggregate, 1);
  }
});
// ── AC #2 — Regression on 3+ cases fails with named affected cases ────────
test("AC #2 — selector regression on 3 cases makes the script exit non-zero with named cases", () => {
  const goldens = buildGoldens();
  const JUNK = "x".repeat(200);
  const degraded = new Set(["case-001", "case-002", "case-003"]);
  const cacheEntries = Object.fromEntries(goldens.map((g) => {
    if (!degraded.has(g.id)) return [g.id, g.expected];
    const broken = g.expected
      .replace(/page\.getByRole\([^)]*\)/g, `page.locator('css=broken-${JUNK}')`)
      .replace(/page\.getByText\([^)]*\)/g, `page.locator('css=broken-text-${JUNK}')`);
    return [g.id, broken];
  }));
  const { scriptPath } = stageHarness({
    goldens, baseline: buildPerfectBaseline(goldens), cacheEntries,
  });
  const { status, stderr } = runScript(scriptPath);
  assert.notEqual(status, 0, `expected non-zero exit on regression, got ${status}`);
  assert.match(stderr, /regression vs baseline/i, "stderr must say 'regression vs baseline'");
  assert.match(stderr, /case-001/, "stderr must name case-001");
  assert.match(stderr, /case-002/, "stderr must name case-002");
  assert.match(stderr, /case-003/, "stderr must name case-003");
  assert.doesNotMatch(stderr, /case-004:/, "case-004 was untouched");
  assert.doesNotMatch(stderr, /case-005:/, "case-005 was untouched");
});

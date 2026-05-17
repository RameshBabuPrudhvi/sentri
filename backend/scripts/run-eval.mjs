/**
 * run-eval.mjs — AUTO-022 CI entrypoint
 *
 * Usage:
 *   node backend/scripts/run-eval.mjs                    # replay mode (CI default)
 *   EVAL_RECORD=1 node backend/scripts/run-eval.mjs      # record mode (dev)
 *   node backend/scripts/run-eval.mjs --write-baseline   # regenerate eval-baseline.json
 *   node backend/scripts/run-eval.mjs --report=path.json # write per-case report artifact
 *
 * Exits non-zero when aggregate regression vs baseline exceeds REGRESSION_THRESHOLD.
 * Prints affected cases (delta < -PER_CASE_DELTA_THRESHOLD on aggregate) so reviewers
 * can localise the regression without re-running CI.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEval } from "../src/eval/pipelineEval.js";
import {
  createReplayAdapter,
  createLiveAdapter,
  createDefaultPipeline,
} from "../src/eval/pipelineAdapter.js";
const REGRESSION_THRESHOLD = 0.05;       // >5% aggregate drop fails CI
const PER_CASE_DELTA_THRESHOLD = 0.20;   // per-case aggregate delta worth naming
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const goldenDir = path.join(repoRoot, "backend", "tests", "fixtures", "eval-goldens");
const cacheDir = path.join(goldenDir, ".cache");
const baselinePath = path.join(repoRoot, "eval-baseline.json");
const args = new Set(process.argv.slice(2));
const writeBaseline = args.has("--write-baseline");
const reportArg = process.argv.slice(2).find((a) => a.startsWith("--report="));
const reportPath = reportArg ? reportArg.slice("--report=".length) : null;
const recordMode = process.env.EVAL_RECORD === "1";
async function buildAdapter() {
  if (recordMode) {
    const pipeline = await createDefaultPipeline();
    return createLiveAdapter({ cacheDir, pipeline });
  }
  return createReplayAdapter({ cacheDir });
}
function loadBaseline() {
  if (!fs.existsSync(baselinePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (err) {
    console.error(`failed to parse ${baselinePath}: ${err.message}`);
    return null;
  }
}
function formatPct(n) {
  return `${(n * 100).toFixed(2)}%`;
}
async function main() {
  const generate = await buildAdapter();
  const results = await runEval({ goldenDir, generate });
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  }
  if (writeBaseline) {
    const payload = {
      aggregate: results.aggregate,
      byCategory: Object.fromEntries(
        Object.entries(results.byCategory).map(([k, v]) => [k, v.aggregate]),
      ),
      perCase: Object.fromEntries(
        results.cases.map((c) => [c.caseId, c.score.aggregate]),
      ),
      recordedAt: new Date().toISOString(),
    };
    fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`wrote baseline → ${baselinePath} (aggregate=${formatPct(results.aggregate)})`);
    return 0;
  }
  const baseline = loadBaseline();
  console.log(`aggregate: ${formatPct(results.aggregate)} (${results.cases.length} cases)`);
  for (const [cat, v] of Object.entries(results.byCategory)) {
    console.log(`  ${cat.padEnd(20)} ${formatPct(v.aggregate)}  (${v.count} cases)`);
  }
  if (!baseline) {
    console.log("no baseline found — first run. Re-run with --write-baseline to capture.");
    return 0;
  }
  const regression = baseline.aggregate - results.aggregate;
  if (regression <= REGRESSION_THRESHOLD) {
    console.log(`PASS — aggregate ${formatPct(results.aggregate)} vs baseline ${formatPct(baseline.aggregate)} (delta ${formatPct(-regression)})`);
    return 0;
  }
  console.error(`FAIL — regression vs baseline: ${formatPct(regression)} (threshold ${formatPct(REGRESSION_THRESHOLD)})`);
  console.error("affected cases (per-case aggregate drop > " + formatPct(PER_CASE_DELTA_THRESHOLD) + "):");
  const perCaseBaseline = baseline.perCase || {};
  const affected = [];
  for (const c of results.cases) {
    const before = perCaseBaseline[c.caseId];
    if (typeof before !== "number") continue;
    const delta = before - c.score.aggregate;
    if (delta > PER_CASE_DELTA_THRESHOLD) {
      affected.push({ caseId: c.caseId, before, after: c.score.aggregate, delta });
    }
  }
  affected.sort((a, b) => b.delta - a.delta);
  for (const a of affected) {
    console.error(`  - ${a.caseId}: ${formatPct(a.before)} → ${formatPct(a.after)} (-${formatPct(a.delta)})`);
  }
  if (affected.length === 0) {
    console.error("  (no individual case crossed the per-case threshold — regression is broad)");
  }
  return 1;
}
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`eval harness crashed: ${err.stack || err.message}`);
    process.exit(2);
  });

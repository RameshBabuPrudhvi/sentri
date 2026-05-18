/**
 * run-eval.mjs — AUTO-022 CI entrypoint
 *
 * Usage:
 *   node backend/scripts/run-eval.mjs                    # replay mode (CI default)
 *   EVAL_RECORD=1 node backend/scripts/run-eval.mjs      # record mode (dev)
 *   node backend/scripts/run-eval.mjs --write-baseline   # regenerate eval-baseline.json
 *   node backend/scripts/run-eval.mjs --report=path.json # write per-case report artifact
 *   node backend/scripts/run-eval.mjs --persist          # write metric_samples rows (Dashboard EvalPanel)
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
import { persistEvalRun } from "../src/eval/evalPersistence.js";
const REGRESSION_THRESHOLD = 0.05;            // >5% aggregate drop fails CI
const PER_DIMENSION_REGRESSION_THRESHOLD = 0.10; // >10% drop on any single dimension fails CI
const PER_CASE_DELTA_THRESHOLD = 0.20;        // per-case aggregate delta worth naming
const DIMENSIONS = ["selectors", "actions", "assertions"];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const goldenDir = path.join(repoRoot, "backend", "tests", "fixtures", "eval-goldens");
const cacheDir = path.join(goldenDir, ".cache");
const baselinePath = path.join(repoRoot, "eval-baseline.json");
const args = new Set(process.argv.slice(2));
const writeBaseline = args.has("--write-baseline");
const persistMetrics = args.has("--persist");
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

/**
 * Compute per-dimension means across every case. Surfaces drift that the
 * aggregate metric can mask — e.g. if selector quality drops 12% but
 * assertions improve 8%, the aggregate may stay inside the 5% gate while
 * selectors quietly regress. The per-dimension gate at PER_DIMENSION_REGRESSION_THRESHOLD
 * catches that.
 */
function computeDimensionMeans(cases) {
  if (cases.length === 0) {
    return Object.fromEntries(DIMENSIONS.map((d) => [d, 0]));
  }
  const out = {};
  for (const d of DIMENSIONS) {
    out[d] = cases.reduce((sum, c) => sum + c.score[d], 0) / cases.length;
  }
  return out;
}
/**
 * Cold-start short-circuit. The harness ships before any cache entries have
 * been recorded against the live LLM (recording requires an API key — only
 * a maintainer with provider access can do it). Without this guard, the
 * very first PR after this lands would crash CI on `eval cache miss`,
 * blocking the merge that would have unblocked recording in the first place.
 *
 * Single signal: the replay cache directory is empty (or absent). If there
 * are no `.cache/*.txt` files, the replay adapter physically cannot succeed
 * — every case will throw `eval cache miss`. The shape of `eval-baseline.json`
 * is irrelevant in that state: a fancy baseline with `perCase` / `byDimension`
 * keys can't be honoured against an empty cache.
 *
 * When the cache is empty, we emit a warning and exit 0 so CI is green and
 * the merge can proceed. Once a maintainer runs `EVAL_RECORD=1 ... --write-baseline`
 * and commits the recordings to `.cache/`, the cache is no longer empty →
 * this guard turns off automatically and the harness reverts to strict
 * replay-or-fail behaviour.
 *
 * Record mode (`EVAL_RECORD=1`) skips this guard — that path is the one we
 * actually want to populate the cache.
 */
function isBootstrapState() {
  if (recordMode) return false;
  // Empty / missing cache dir → no recordings exist yet → replay cannot work.
  let cacheEmpty = true;
  try {
    const entries = fs.readdirSync(cacheDir);
    cacheEmpty = entries.filter((e) => e.endsWith(".txt")).length === 0;
  } catch {
    // Dir doesn't exist — same outcome as empty.
  }
  return cacheEmpty;
}

async function main() {
  // Check bootstrap state BEFORE building the replay adapter so we don't
  // even touch the cache miss path on a cold start.
  if (isBootstrapState()) {
    console.log("⚠️  AUTO-022 cold start — no cache entries recorded yet and baseline is the placeholder.");
    console.log("    Skipping replay. CI is green so the merge can proceed.");
    console.log("    To activate the gate: run `EVAL_RECORD=1 node backend/scripts/run-eval.mjs --write-baseline`");
    console.log("    against a maintainer machine with an LLM API key, then commit the resulting");
    console.log("    `backend/tests/fixtures/eval-goldens/.cache/*.txt` files + the new `eval-baseline.json`.");
    if (reportPath) {
      // Still emit an empty report so the artifact upload step doesn't warn.
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({ bootstrap: true, aggregate: null, cases: [] }, null, 2));
    }
    return 0;
  }

  const generate = await buildAdapter();
  const results = await runEval({ goldenDir, generate });
  if (persistMetrics) {
    // Lazy-init the DB only when --persist is requested. Replay-mode CI runs
    // never touch better-sqlite3, so the default offline path stays clean.
    // `getDatabase()` is the singleton entry point — it runs pending migrations
    // (incl. 016_metric_samples.sql) on first call.
    const { getDatabase } = await import("../src/database/sqlite.js");
    getDatabase();
    const { runId, rowsWritten } = persistEvalRun({ cases: results.cases });
    console.log(`persisted ${rowsWritten} metric_samples rows (runId=${runId})`);
  }
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  }
  // Compute per-dimension means once — used by both --write-baseline and the
  // per-dimension regression gate below.
  const dimensionMeans = computeDimensionMeans(results.cases);

  if (writeBaseline) {
    const payload = {
      aggregate: results.aggregate,
      byDimension: dimensionMeans,
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
  // Per-dimension gate — catch regressions the aggregate metric can mask.
  // `byDimension` may be absent on legacy baselines written before this gate
  // was added; in that case skip the per-dimension check and fall through to
  // the aggregate-only gate. The next `--write-baseline` will populate it.
  const dimensionRegressions = [];
  if (baseline.byDimension) {
    for (const d of DIMENSIONS) {
      const before = baseline.byDimension[d];
      if (typeof before !== "number") continue;
      const after = dimensionMeans[d];
      const delta = before - after;
      if (delta > PER_DIMENSION_REGRESSION_THRESHOLD) {
        dimensionRegressions.push({ dimension: d, before, after, delta });
      }
    }
  }

  const aggregateRegression = baseline.aggregate - results.aggregate;
  const aggregateFailed = aggregateRegression > REGRESSION_THRESHOLD;
  const dimensionFailed = dimensionRegressions.length > 0;

  if (!aggregateFailed && !dimensionFailed) {
    console.log(`PASS — aggregate ${formatPct(results.aggregate)} vs baseline ${formatPct(baseline.aggregate)} (delta ${formatPct(-aggregateRegression)})`);
    for (const d of DIMENSIONS) {
      const before = baseline.byDimension?.[d];
      const after = dimensionMeans[d];
      if (typeof before === "number") {
        console.log(`  ${d.padEnd(12)} ${formatPct(after)} vs ${formatPct(before)} (delta ${formatPct(after - before)})`);
      }
    }
    return 0;
  }

  if (aggregateFailed) {
    console.error(`FAIL — aggregate regression vs baseline: ${formatPct(aggregateRegression)} (threshold ${formatPct(REGRESSION_THRESHOLD)})`);
  }
  if (dimensionFailed) {
    console.error(`FAIL — per-dimension regression vs baseline (threshold ${formatPct(PER_DIMENSION_REGRESSION_THRESHOLD)}):`);
    for (const r of dimensionRegressions) {
      console.error(`  - ${r.dimension}: ${formatPct(r.before)} → ${formatPct(r.after)} (-${formatPct(r.delta)})`);
    }
  }
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

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
 * Incremental recording flags (for rate-limited providers — e.g. Gemini's
 * 20-requests-per-day free tier — where recording all 50 goldens in one
 * sitting is impossible):
 *
 *   --cases=<csv>      Only run cases whose id matches one of the comma-
 *                       separated globs. Examples:
 *                         --cases=case-001,case-002,case-003
 *                         --cases=case-00*           (case-001..009)
 *                         --cases=case-0[0-1]*       (case-001..019)
 *   --skip-cached      Skip any case that already has a `.cache/<id>.<hash>.txt`
 *                       file. Combined with `EVAL_RECORD=1`, this lets you
 *                       re-run the harness daily and only spend API calls on
 *                       cases that haven't been recorded yet.
 *   --limit=N          Hard cap on number of cases actually processed in this
 *                       invocation (after `--cases` filter + `--skip-cached`).
 *                       Defaults to no cap. Pair with `EVAL_RECORD=1` to stay
 *                       inside a daily provider quota — e.g. `--limit=18`
 *                       leaves headroom against Gemini's 20/day free tier.
 *
 * Typical incremental record workflow for a rate-limited maintainer:
 *   Day 1: EVAL_RECORD=1 node backend/scripts/run-eval.mjs --skip-cached --limit=18
 *   Day 2: EVAL_RECORD=1 node backend/scripts/run-eval.mjs --skip-cached --limit=18
 *   Day 3: EVAL_RECORD=1 node backend/scripts/run-eval.mjs --skip-cached --limit=18
 *   …     (each day records the next ~18 missing cases until all 50 are done)
 *   Final: node backend/scripts/run-eval.mjs --write-baseline   # rebaseline from full cache
 *
 * Exits non-zero when aggregate regression vs baseline exceeds REGRESSION_THRESHOLD.
 * Prints affected cases (delta < -PER_CASE_DELTA_THRESHOLD on aggregate) so reviewers
 * can localise the regression without re-running CI.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { runEval, loadGoldens, scoreCase } from "../src/eval/pipelineEval.js";
import {
  createReplayAdapter,
  createLiveAdapter,
  createDefaultPipeline,
  PROMPT_VERSION,
  EVAL_MODEL,
} from "../src/eval/pipelineAdapter.js";
import { persistEvalRun } from "../src/eval/evalPersistence.js";
const REGRESSION_THRESHOLD = 0.05;            // >5% aggregate drop fails CI
const PER_DIMENSION_REGRESSION_THRESHOLD = 0.10; // >10% drop on any single dimension fails CI
const PER_CASE_DELTA_THRESHOLD = 0.20;        // per-case aggregate delta worth naming
const DIMENSIONS = ["selectors", "actions", "assertions"];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
// Env-var overrides exist so the CLI E2E test (`tests/eval-cli-e2e.test.js`)
// can stage a synthetic golden dir + baseline in a tmpdir without having to
// copy the entire `backend/src/` tree alongside this script. CI never sets
// these; the defaults remain the canonical repo paths.
const goldenDir = process.env.EVAL_GOLDEN_DIR
  || path.join(repoRoot, "backend", "tests", "fixtures", "eval-goldens");
const cacheDir = process.env.EVAL_CACHE_DIR
  || path.join(goldenDir, ".cache");
const baselinePath = process.env.EVAL_BASELINE_PATH
  || path.join(repoRoot, "eval-baseline.json");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const writeBaseline = args.has("--write-baseline");
const persistMetrics = args.has("--persist");
const skipCached = args.has("--skip-cached");
const reportArg = rawArgs.find((a) => a.startsWith("--report="));
const reportPath = reportArg ? reportArg.slice("--report=".length) : null;
const casesArg = rawArgs.find((a) => a.startsWith("--cases="));
const casesPatterns = casesArg
  ? casesArg.slice("--cases=".length).split(",").map((s) => s.trim()).filter(Boolean)
  : null;
const limitArg = rawArgs.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.slice("--limit=".length), 10) : null;
if (limitArg && (!Number.isInteger(limit) || limit < 1)) {
  console.error(`invalid --limit value: ${limitArg.slice("--limit=".length)} (expected positive integer)`);
  process.exit(2);
}
const recordMode = process.env.EVAL_RECORD === "1";

/**
 * Convert a glob (`*`, `?`, `[abc]`) into an anchored RegExp. Anchoring is
 * deliberate — partial matches would let `--cases=case-1` accept `case-100`
 * too, which is almost never what an operator wants when staging an
 * incremental record session against a tight daily quota.
 */
function globToRegExp(glob) {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[") re += "[";
    else if (ch === "]") re += "]";
    else if (/[.+(){}|^$\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(re + "$");
}

/**
 * Compute the cache filename for a golden — must match `pipelineAdapter.js`'s
 * cacheKey() exactly (PROMPT_VERSION + EVAL_MODEL + id + snapshot + url),
 * otherwise `--skip-cached` would think a recording is missing when it isn't.
 * We import PROMPT_VERSION + EVAL_MODEL from the adapter to keep them in sync.
 */
function cachedRecordExists(golden) {
  const h = crypto.createHash("sha256");
  h.update(PROMPT_VERSION);
  h.update("\0");
  h.update(EVAL_MODEL);
  h.update("\0");
  h.update(String(golden.id ?? ""));
  h.update("\0");
  h.update(String(golden.snapshot ?? ""));
  h.update("\0");
  h.update(String(golden.url ?? ""));
  const key = h.digest("hex").slice(0, 32);
  return fs.existsSync(path.join(cacheDir, `${golden.id}.${key}.txt`));
}

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
  let results;
  // Fast path: no incremental flags → use the canonical runEval() entrypoint
  // unchanged. Keeps test coverage of the library function honest and avoids
  // duplicating its aggregation logic when CI (which never passes these
  // flags) is the caller.
  const hasIncrementalFlags = casesPatterns || skipCached || limit != null;
  if (!hasIncrementalFlags) {
    results = await runEval({ goldenDir, generate });
  } else {
    // Incremental path: filter the golden list before generating so a
    // rate-limited maintainer can stage one batch per day. Filter order
    // matters: `--cases` narrows first (operator intent), then `--skip-cached`
    // removes already-recorded entries, then `--limit` caps the result.
    let goldens = loadGoldens(goldenDir);
    const initialCount = goldens.length;
    if (casesPatterns) {
      const regexes = casesPatterns.map(globToRegExp);
      goldens = goldens.filter((g) => regexes.some((re) => re.test(g.id)));
      console.log(`--cases filter: ${goldens.length}/${initialCount} cases match patterns [${casesPatterns.join(", ")}]`);
    }
    if (skipCached) {
      const before = goldens.length;
      goldens = goldens.filter((g) => !cachedRecordExists(g));
      console.log(`--skip-cached: ${goldens.length}/${before} cases have no existing recording`);
    }
    if (limit != null && goldens.length > limit) {
      console.log(`--limit=${limit}: processing first ${limit} of ${goldens.length} remaining cases`);
      goldens = goldens.slice(0, limit);
    }
    if (goldens.length === 0) {
      console.log("No cases to process after filters. Nothing to do.");
      // Exit 0 — an empty incremental run is success, not failure (operator
      // ran `--skip-cached` after everything is already cached). Skip the
      // baseline-comparison block below by short-circuiting here.
      return 0;
    }
    // Walk the filtered list manually so we mirror runEval()'s output shape
    // (including byCategory aggregation) without re-importing internals.
    const cases = [];
    for (const golden of goldens) {
      const actual = await generate(golden);
      const score = scoreCase(actual, golden.expected);
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
    const byCategory = {};
    for (const c of cases) {
      if (!byCategory[c.category]) byCategory[c.category] = { count: 0, sum: 0 };
      byCategory[c.category].count += 1;
      byCategory[c.category].sum += c.score.aggregate;
    }
    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].aggregate = byCategory[cat].sum / byCategory[cat].count;
    }
    results = { aggregate, cases, byCategory };
    // Loud reminder that an incremental run is NOT a full evaluation —
    // operator should not trust the aggregate as a gate signal when only
    // a subset of cases ran. The baseline-comparison block below also
    // short-circuits with a warning so CI on `--cases=X` never falsely
    // fails just because the partial subset diverged.
    console.log(`\n⚠️  Incremental run — ${cases.length} of ${initialCount} cases processed. Aggregate is a subset average, NOT a baseline comparison.\n`);
  }
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
    // Guard rail: `--write-baseline` against an incremental subset would
    // overwrite the canonical baseline with a misleading partial-aggregate.
    // Refuse the combination — operator must re-run without filters to
    // rebaseline once recording is complete.
    if (hasIncrementalFlags) {
      console.error("--write-baseline cannot be combined with --cases / --skip-cached / --limit.");
      console.error("Rebaseline against the FULL cache instead:");
      console.error("  node backend/scripts/run-eval.mjs --write-baseline");
      return 2;
    }
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
  // Incremental runs never gate against the baseline — a 5-case subset
  // pass-rate is not comparable to a 50-case baseline. Print per-case
  // detail so the operator can spot-check recordings, then exit 0.
  if (hasIncrementalFlags) {
    console.log(`incremental aggregate: ${formatPct(results.aggregate)} (${results.cases.length} cases)`);
    for (const c of results.cases) {
      console.log(`  ${c.caseId.padEnd(20)} ${formatPct(c.score.aggregate)}  (${c.category})`);
    }
    console.log("\nNext step: re-run with `--skip-cached --limit=N` tomorrow to record the remaining cases,");
    console.log("then `--write-baseline` (no filters) once the full cache is populated.");
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

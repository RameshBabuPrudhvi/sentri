/**
 * @module utils/runResultFormatters
 * @description Markdown renderers and regression diff helpers for run results.
 */

import { isNonExecutedSkip } from "./skipReasons.js";

const GREEN_STATUSES = new Set(["passed", "warning"]);
const FAIL_STATUSES = new Set(["failed", "error"]);
export const BASE_LOOKBACK_RUNS = 25;

function testKey(result) {
  return result?.testId || result?.id || result?.testName || result?.name || "unknown";
}

function testName(result) {
  return result?.testName || result?.name || result?.testId || result?.id || "Unnamed test";
}

function isFailing(result) {
  return FAIL_STATUSES.has(String(result?.status || "").toLowerCase());
}

function isGreen(result) {
  return GREEN_STATUSES.has(String(result?.status || "").toLowerCase());
}

/**
 * Find the latest green run for a base SHA within a bounded lookback.
 * The lookback is intentionally capped at 25 project runs to keep completion
 * formatting cheap even for projects with long histories.
 *
 * @param {Object[]} projectRuns
 * @param {string|null} baseSha
 * @param {string|null} repo
 * @returns {Object|null}
 */
export function findGreenBaseRun(projectRuns, baseSha, repo) {
  if (!baseSha) return null;
  return (projectRuns || [])
    .filter((run) => run?.type === "test_run" && run?.status === "completed")
    .filter((run) => !repo || run.githubCheck?.repo === repo)
    .filter((run) => run.githubCheck?.sha === baseSha)
    .slice(0, BASE_LOOKBACK_RUNS)
    .find((run) => Number(run.failed || 0) === 0 && Array.isArray(run.results)) || null;
}

/**
 * Return currently failing tests that were green on the base SHA's latest green run.
 * Falls back to all current failures when no green base run is available.
 *
 * @param {Object} run
 * @param {Object|null} baseRun
 * @returns {{ tests: Object[], fallback: boolean }}
 */
export function getRegressedFailures(run, baseRun) {
  const failing = (run?.results || []).filter(isFailing);
  if (!baseRun) return { tests: failing, fallback: true };
  const greenBase = new Set((baseRun.results || []).filter(isGreen).map(testKey));
  return { tests: failing.filter((result) => greenBase.has(testKey(result))), fallback: false };
}

// Format a violation object emitted by `evaluateQualityGates` /
// `evaluateWebVitalsBudgets` in `backend/src/testRunner.js`. Both produce
// `{ rule, threshold, actual, ... }` shapes — neither carries `message` or
// `label`, so the previous `v.message || v.label || String(v)` fallback
// rendered `[object Object]` for every real violation. Strings pass through
// unchanged so any defensive callers (or legacy run rows) keep working.
function formatGateViolation(v) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return String(v);
  if (v.message) return String(v.message);
  if (v.label) return String(v.label);
  if (v.rule != null) {
    return `${v.rule}: actual ${v.actual} vs threshold ${v.threshold}`;
  }
  return String(v);
}

function formatVitalsViolation(v) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return String(v);
  if (v.message) return String(v.message);
  if (v.label) return String(v.label);
  if (v.rule != null) {
    const scope = v.testName || v.testId;
    const prefix = scope ? `${String(v.rule).toUpperCase()} on ${scope}` : String(v.rule).toUpperCase();
    return `${prefix}: actual ${v.actual} vs threshold ${v.threshold}`;
  }
  return String(v);
}

function collectGateViolations(run) {
  const violations = [];
  if (Array.isArray(run?.gateResult?.violations)) {
    violations.push(...run.gateResult.violations.map(formatGateViolation));
  } else if (run?.gateResult && run.gateResult.passed === false) {
    violations.push("Quality gate failed.");
  }
  return violations;
}

function collectVitalsViolations(run) {
  const result = run?.webVitalsResult;
  if (!result) return [];
  if (Array.isArray(result.violations)) return result.violations.map(formatVitalsViolation);
  if (Array.isArray(result.metrics)) {
    return result.metrics.filter((m) => m.passed === false).map((m) => `${String(m.name || m.key).toUpperCase()} exceeded budget`);
  }
  return result.passed === false ? ["Web Vitals budget failed."] : [];
}

/**
 * Determine the GitHub Check Run conclusion for a Sentri run.
 *
 * @param {Object} run
 * @returns {"success"|"failure"|"neutral"}
 */
export function conclusionForRun(run) {
  if (["aborted", "interrupted", "skipped"].includes(run?.status)) return "neutral";
  if (run?.status === "failed" || Number(run?.failed || 0) > 0) return "failure";
  if (run?.gateResult?.passed === false || run?.webVitalsResult?.passed === false) return "failure";
  return "success";
}

/**
 * Render GitHub-flavored summary markdown for a completed Sentri run.
 *
 * @param {Object} run
 * @param {Object} [options]
 * @param {Object|null} [options.baseRun]
 * @param {string} [options.runUrl]
 * @returns {string}
 */
export function renderGithubCheckSummary(run, { baseRun = null, runUrl = "" } = {}) {
  const { tests: regressed, fallback } = getRegressedFailures(run, baseRun);
  const gateViolations = collectGateViolations(run);
  const vitalsViolations = collectVitalsViolations(run);
  // AUTO-001 / AUTO-004: the GitHub Check summary must report the *executed*
  // total, not the approved-test total — otherwise a run with 10 approved /
  // 5 impact-skipped / 5 passed shows "5 passed, 0 failed, 10 total" on the
  // PR check (half the tests look like they vanished). Mirror the
  // `evaluateQualityGates()` denominator in `backend/src/testRunner.js` and
  // the `passRateDenominator` in `frontend/src/pages/RunDetail.jsx` so the
  // three surfaces (UI badge, gate verdict, PR check summary) agree on the
  // same run. Surface the skipped count separately when present so the
  // approved-test slice is still auditable from the PR check.
  const rawTotal = Number(run?.total || 0);
  const skippedNonExecuted = Array.isArray(run?.results)
    ? run.results.filter(isNonExecutedSkip).length
    : 0;
  const executedTotal = Math.max(0, rawTotal - skippedNonExecuted);
  const headerSkippedSuffix = skippedNonExecuted > 0
    ? `, **${skippedNonExecuted} skipped** (of ${rawTotal} approved)`
    : "";
  const lines = [
    `**Sentri QA** completed with **${run?.passed || 0} passed**, **${run?.failed || 0} failed**, **${executedTotal} total**${headerSkippedSuffix}.`,
  ];
  if (runUrl) lines.push(``, `[Open Run Detail](${runUrl})`);
  lines.push("", "### Regressed tests");
  if (regressed.length) {
    if (fallback) lines.push("_No green base run was found in the 25-run lookback; listing all current failures._");
    for (const result of regressed.slice(0, 20)) lines.push(`- ${testName(result)}`);
    if (regressed.length > 20) lines.push(`- …and ${regressed.length - 20} more`);
  } else {
    lines.push(baseRun ? "No test regressions detected against the base SHA." : "No failing tests.");
  }
  if (gateViolations.length) {
    lines.push("", "### Quality gate violations", ...gateViolations.map((v) => `- ${v}`));
  }
  if (vitalsViolations.length) {
    lines.push("", "### Web Vitals budget violations", ...vitalsViolations.map((v) => `- ${v}`));
  }
  return lines.join("\n");
}

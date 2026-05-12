/**
 * @module pipeline/riskScorer
 * @description Pure functions for AUTO-001 risk-based ordering and budget truncation.
 * No DB access — callers pass in `runHistory`, `changedPages`, etc.
 *
 * Returned arrays preserve the *input* test objects untouched; only a `riskScore`
 * (and `skipReason` from `applyBudgetToQueue`) is added. Callers that need the
 * original approved-test order for audit/persistence should keep their input
 * array around — these helpers do not mutate it.
 */

/** Server-side cap on the `budgetMinutes` request param to bound worker pool exposure. */
export const MAX_BUDGET_MINUTES = 240;

function toTs(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

/**
 * Coerce a user-supplied `budgetMinutes` into a safe finite number ≤ MAX_BUDGET_MINUTES,
 * or `null` if absent / non-positive / non-finite. Prevents a malformed value
 * (`"abc"`, `Infinity`, `1e9`) from being passed straight through to the runner.
 */
export function normalizeBudgetMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_BUDGET_MINUTES);
}

export function isSmokeTest(test) {
  const tags = Array.isArray(test?.tags) ? test.tags : [];
  if (tags.some((t) => String(t).toLowerCase() === "smoke")) return true;
  return String(test?.name || "").toLowerCase().includes("smoke");
}

/**
 * `runHistory` contract: rows are ordered **newest-first**. Both callers
 * (`routes/runs.js` + `routes/trigger.js`) build history by flat-mapping the
 * results of runs returned by `runRepo.getRecentCompletedWithResults()`,
 * which queries `ORDER BY startedAt DESC` — so position 0 is the most recent
 * execution. The scorer takes the first 10 entries as the "recent" window
 * and reads index 0 for the most-recent-failure bonus. Reversing the array
 * at the callers (or sorting inside the scorer) would work too but costs an
 * O(n) per test; honouring the source order here is free.
 */
export function scoreTestRisk(test, runHistory = [], { now = Date.now(), changedPages = [] } = {}) {
  let score = 0;
  // Exclude budget-skipped rows from the history: they reflect a dispatch
  // decision (the test never ran), not an execution outcome. Counting them
  // as failures would give a previously budget-skipped test a near-maximum
  // risk score on the next run and corrupt the ranking across runs.
  const rows = runHistory.filter(
    (r) => r?.testId === test.id && !(r.status === "skipped" && r.skipReason === "over_budget"),
  );
  // Newest-first window: take the head, not the tail. The previous
  // `slice(-10)` + `at(-1)` shape silently inverted the bonus — a test that
  // had just been fixed still scored the +20 most-recent-failure boost
  // because the *oldest* row in the window was the failure.
  const recent = rows.slice(0, 10);
  const failed = recent.filter((r) => r.status !== "passed").length;
  const passRate = recent.length ? (recent.length - failed) / recent.length : 1;
  score += (1 - passRate) * 60;
  if (recent[0]?.status && recent[0].status !== "passed") score += 20;

  const updatedAt = toTs(test?.updatedAt);
  if (updatedAt) {
    const ageDays = (now - updatedAt) / (24 * 60 * 60 * 1000);
    score += clamp((14 - ageDays) / 14, 0, 1) * 20;
  }

  const heals = Number(test?.healingCount || 0);
  if (Number.isFinite(heals) && heals > 0) score += clamp(heals, 0, 5) * 2;

  const sourceUrl = String(test?.sourceUrl || "");
  if (sourceUrl && changedPages.some((p) => sourceUrl.startsWith(String(p)))) score += 15;

  return Number(score.toFixed(2));
}

export function orderTestsByRisk(tests, runHistory = [], options = {}) {
  const scored = tests.map((t, idx) => ({
    ...t,
    riskScore: scoreTestRisk(t, runHistory, options),
    _idx: idx,
    _smoke: isSmokeTest(t),
  }));
  scored.sort((a, b) => {
    if (a._smoke !== b._smoke) return a._smoke ? -1 : 1;
    if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
    return a._idx - b._idx;
  });
  return scored.map(({ _idx, _smoke, ...rest }) => rest);
}

/**
 * Truncate the queue to fit a wall-clock budget. Smoke tests are always kept
 * (pinned regardless of remaining budget). Returns `{ kept, skipped }` so the
 * caller can persist "skipped (over budget)" status markers for observability
 * — silently dropping tests violates AGENT.md issue-handling rules.
 */
export function applyBudgetToQueue(tests, budgetMinutes) {
  const minutes = normalizeBudgetMinutes(budgetMinutes);
  if (minutes == null) return { kept: tests, skipped: [] };
  const budgetMs = minutes * 60_000;
  let elapsed = 0;
  const kept = [];
  const skipped = [];
  for (const t of tests) {
    const est = Number(t.estimatedDurationMs || t.avgDurationMs || 60_000);
    const smoke = isSmokeTest(t);
    if (smoke || elapsed + est <= budgetMs) {
      kept.push(t);
      elapsed += est;
    } else {
      skipped.push({ ...t, skipReason: "over_budget" });
    }
  }
  return { kept, skipped };
}

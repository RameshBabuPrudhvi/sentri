/**
 * @module pipeline/riskScorer
 */

function toTs(value) {
  const n = Date.parse(value || "");
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

export function isSmokeTest(test) {
  const tags = Array.isArray(test?.tags) ? test.tags : [];
  if (tags.some((t) => String(t).toLowerCase() === "smoke")) return true;
  return String(test?.name || "").toLowerCase().includes("smoke");
}

export function scoreTestRisk(test, runHistory = [], { now = Date.now(), changedPages = [] } = {}) {
  let score = 0;
  const rows = runHistory.filter((r) => r?.testId === test.id);
  const recent = rows.slice(-10);
  const failed = recent.filter((r) => r.status !== "passed").length;
  const passRate = recent.length ? (recent.length - failed) / recent.length : 1;
  score += (1 - passRate) * 60;
  if (recent.at(-1)?.status && recent.at(-1).status !== "passed") score += 20;

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

export function applyBudgetToQueue(tests, budgetMinutes) {
  const budgetMs = Number(budgetMinutes) * 60_000;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return tests;
  let elapsed = 0;
  const kept = [];
  for (const t of tests) {
    const est = Number(t.estimatedDurationMs || t.avgDurationMs || 60_000);
    const smoke = isSmokeTest(t);
    if (smoke || elapsed + est <= budgetMs) {
      kept.push(t);
      elapsed += est;
    }
  }
  return kept;
}

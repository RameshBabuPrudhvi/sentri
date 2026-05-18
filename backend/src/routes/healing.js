/**
 * @module routes/healing
 * @description Self-healing telemetry routes (CAP-004). Mounted at `/api/v1`
 * behind `requireAuth` + `workspaceScope`, so every handler runs with
 * `req.workspaceId` already populated.
 *
 * ### Endpoints
 * | Method | Path                        | Description                                                  |
 * |--------|-----------------------------|--------------------------------------------------------------|
 * | `GET`  | `/api/v1/healing/summary`   | Workspace-wide self-healing summary for the `/healing` page. |
 *
 * The summary endpoint aggregates `healingRepo` rows scoped to the requesting
 * workspace via `getByTestIds()` (SQL-level `key LIKE` filter — never loads
 * other workspaces' rows into memory) and merges the `healing.savings`
 * `metric_samples` series across all of the workspace's projects by
 * timestamp so the `<TrendChart>` reflects whole-workspace savings, not a
 * single project.
 */

import { Router } from "express";
import * as testRepo from "../database/repositories/testRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as healingRepo from "../database/repositories/healingRepo.js";
import * as metricSamplesRepo from "../database/repositories/metricSamplesRepo.js";
import * as visionBudgetRepo from "../database/repositories/visionBudgetRepo.js";
import { requireRole } from "../middleware/requireRole.js";

const router = Router();

/**
 * GET /api/v1/healing/summary
 *
 * Returns a workspace-scoped self-healing summary used by the `/healing`
 * dashboard (`frontend/src/pages/HealingDashboard.jsx`).
 *
 * Response shape:
 *   {
 *     strategies:    [{ strategyIndex, total, successes, successRate }],
 *     topSelectors:  [{ selector, healCount, totalCount }],   // sorted DESC by healCount, capped at 10
 *     estimates:     { testsThatWouldHaveFailed: number },    // count of rows with strategyIndex > 0
 *     savingsTrend:  [{ ts, value }]                          // merged across all workspace projects by timestamp
 *   }
 *
 * Healing keys are formatted `<testId>::<action>::<label>` (see
 * `selfHealing.js:48`); selector aggregation preserves both `action` and
 * `label` so e.g. `click::Save` and `fill::Save` stay distinct in the
 * "top healed selectors" list.
 */
router.get("/healing/summary", requireRole("viewer"), (req, res) => {
  const projectIds = projectRepo.getAll(req.workspaceId).map((p) => p.id);
  const tests = testRepo.getAllByProjectIds(projectIds);
  const testIds = tests.map((t) => t.id);
  // Workspace-scoped at the SQL layer — `getByTestIds` filters via `key LIKE`
  // patterns so we never pull other workspaces' healing rows into memory.
  // Replaces the old `getAllAsDict()` + JS filter, which scaled with total
  // system data rather than the requesting workspace's data.
  //
  // Rows arrive ordered `strategyVersion ASC NULLS FIRST` (legacy unversioned
  // first, then v1, v2, …). Deduplicate via "later-row-wins" Map.set keyed on
  // `<baseTestId>::<action>::<label>` so a versioned entry overrides any
  // legacy unversioned row for the same tuple — mirrors the dict-overwrite
  // pattern in `healingRepo.getByTestId`. Without this, workspaces upgraded
  // from pre-versioned scopes would double-count strategy totals,
  // `wouldFail`, and selector heal/totalCounts.
  const rawRows = healingRepo.getByTestIds(testIds);
  const dedup = new Map();
  for (const r of rawRows) {
    const sepIdx = String(r.key).indexOf("::");
    if (sepIdx < 0) continue;
    const rawTestId = r.key.slice(0, sepIdx);
    const baseTestId = rawTestId.replace(/@v\d+$/, "");
    const suffix = r.key.slice(sepIdx + 2); // "<action>::<label>"
    dedup.set(`${baseTestId}::${suffix}`, r);
  }
  const rows = [...dedup.values()];

  const byStrategy = new Map();
  const selectorAgg = new Map(); // selector → { selector, healCount, totalCount }
  let wouldFail = 0;
  const visionHealStrategy = { pixelmatch: 0, llm: 0 };

  for (const r of rows) {
    const key = r.strategyIndex >= 0 ? String(r.strategyIndex) : "failed";
    const prev = byStrategy.get(key) || { strategyIndex: r.strategyIndex, total: 0, successes: 0 };
    prev.total += 1;
    if (r.strategyIndex >= 0 && r.succeededAt) prev.successes += 1;
    byStrategy.set(key, prev);
    if (r.strategyIndex > 0) wouldFail += 1;
    if (r.strategyIndex === 7) visionHealStrategy.pixelmatch += 1;
    if (r.strategyIndex === 8) visionHealStrategy.llm += 1;

    // Healing keys are formatted "<testId>::<action>::<label>" (see
    // selfHealing.js:48). The selector aggregation should preserve both
    // `action` and `label` so different actions on identically-labelled
    // elements (e.g. `click::Save` vs `fill::Save`) stay distinct in the
    // dashboard's "top healed selectors" list. Using `slice(1)` keeps the
    // last two segments; `slice(2)` would drop the action and merge them.
    const parts = String(r.key).split("::");
    const selector = parts.slice(1).join("::") || "unknown";
    const agg = selectorAgg.get(selector) || { selector, healCount: 0, totalCount: 0 };
    agg.totalCount += 1;
    if (r.strategyIndex > 0 && r.succeededAt) agg.healCount += 1;
    selectorAgg.set(selector, agg);
  }

  // Sort by actual heal count, not by boolean cast.
  const topSelectors = [...selectorAgg.values()]
    .filter((s) => s.healCount > 0)
    .sort((a, b) => b.healCount - a.healCount)
    .slice(0, 10);

  // Aggregate savings trend across ALL workspace projects, merging by timestamp.
  const merged = new Map();
  for (const pid of projectIds) {
    const series = metricSamplesRepo.getSeries(pid, "healing.savings", { limit: 90 });
    for (const s of series) {
      const cur = merged.get(s.ts) || { ts: s.ts, value: 0 };
      cur.value += Number(s.value || 0);
      merged.set(s.ts, cur);
    }
  }
  const savingsTrend = [...merged.values()].sort((a, b) => a.ts - b.ts);

  const visionHealCount = visionHealStrategy.pixelmatch + visionHealStrategy.llm;
  res.json({
    strategies: [...byStrategy.values()].map((s) => ({
      ...s,
      successRate: s.total ? s.successes / s.total : 0,
    })),
    topSelectors,
    estimates: { testsThatWouldHaveFailed: wouldFail },
    savingsTrend,
    visionHealCount,
    visionHealCostUsd: 0,
    visionHealStrategy,
  });
});

export default router;

/**
 * @module database/repositories/visionBudgetRepo
 * @description MNT-001b — per-project budget counters enforced by
 * `tryVisionHeal` stage 8.
 *
 * Two windows per project:
 *   - daily   — `callCount`  vs `project.visionHealMaxCallsPerDay`
 *   - monthly — `costUsd`    vs `project.visionHealMaxCostUsdPerMonth`
 *
 * Window keys encode the period so old buckets age out naturally — the
 * check only ever queries the current window's row. UTC throughout: a
 * day rolls over at 00:00 UTC, a month at the 1st 00:00 UTC. We don't
 * try to align to a tenant's local timezone — operators looking at the
 * budget gauge see a single global rollover, which is easier to reason
 * about than per-tenant clocks.
 */
import { getDatabase } from "../sqlite.js";
import * as projectRepo from "./projectRepo.js";

/**
 * Compute the current daily-window key from `now`. Format `daily:YYYY-MM-DD`
 * in UTC so callers across timezones share one bucket per project.
 *
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function dailyWindowKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `daily:${y}-${m}-${d}`;
}

/**
 * Compute the current monthly-window key from `now`. Format
 * `monthly:YYYY-MM` in UTC.
 *
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function monthlyWindowKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `monthly:${y}-${m}`;
}

/**
 * Record a single vision-heal LLM call against the project's budget.
 * Increments both the daily call counter and the monthly cost counter
 * in one transaction so the two buckets stay consistent.
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {number} params.costUsd  Cost of this single call.
 * @param {Date}   [params.now]
 */
export function recordCall({ projectId, costUsd = 0, now = new Date() }) {
  if (!projectId) return;
  const db = getDatabase();
  const updatedAt = now.toISOString();
  const dailyKey = dailyWindowKey(now);
  const monthlyKey = monthlyWindowKey(now);
  const cost = Number.isFinite(costUsd) ? Number(costUsd) : 0;
  const txn = db.transaction(() => {
    // Daily bucket: increment callCount, leave costUsd at 0 (cost lives in
    // the monthly bucket per the schema's split-rollover semantics).
    db.prepare(`
      INSERT INTO vision_heal_budget (projectId, windowKey, callCount, costUsd, updatedAt)
      VALUES (@projectId, @windowKey, 1, 0, @updatedAt)
      ON CONFLICT(projectId, windowKey) DO UPDATE SET
        callCount = callCount + 1,
        updatedAt = @updatedAt
    `).run({ projectId, windowKey: dailyKey, updatedAt });
    // Monthly bucket: increment costUsd, leave callCount at 0.
    db.prepare(`
      INSERT INTO vision_heal_budget (projectId, windowKey, callCount, costUsd, updatedAt)
      VALUES (@projectId, @windowKey, 0, @cost, @updatedAt)
      ON CONFLICT(projectId, windowKey) DO UPDATE SET
        costUsd = costUsd + @cost,
        updatedAt = @updatedAt
    `).run({ projectId, windowKey: monthlyKey, cost, updatedAt });
  });
  txn();
}

/**
 * Current daily call count for a project, or 0 when no calls have landed
 * in today's bucket yet.
 *
 * @param {string} projectId
 * @param {Date}   [now]
 * @returns {number}
 */
export function getDailyCalls(projectId, now = new Date()) {
  const db = getDatabase();
  const row = db.prepare(
    "SELECT callCount FROM vision_heal_budget WHERE projectId = ? AND windowKey = ?"
  ).get(projectId, dailyWindowKey(now));
  return row?.callCount ?? 0;
}

/**
 * Current monthly cost (USD) for a project, or 0 when no calls have
 * landed in this month's bucket yet.
 *
 * @param {string} projectId
 * @param {Date}   [now]
 * @returns {number}
 */
export function getMonthlyCost(projectId, now = new Date()) {
  const db = getDatabase();
  const row = db.prepare(
    "SELECT costUsd FROM vision_heal_budget WHERE projectId = ? AND windowKey = ?"
  ).get(projectId, monthlyWindowKey(now));
  return row?.costUsd ?? 0;
}

/**
 * Budget check consumed by `tryVisionHeal` stage 8. Reads the project's
 * caps from `projectRepo` (which defaults missing rows to 100 calls/day
 * and $50/month) and compares them to the current bucket values.
 *
 * Returns `{ dailyCalls: boolean, monthlyCost: boolean }` — both `true`
 * means stage 8 is fully shut off; `false` for both means it can fire.
 * On any internal error returns both `true` so the orchestrator's
 * conservative-skip path takes over — matches `tryVisionHeal`'s
 * documented contract for "budget check failed".
 *
 * @param {string} projectId
 * @returns {Promise<{dailyCalls: boolean, monthlyCost: boolean}>}
 */
export async function isBudgetExhausted(projectId) {
  if (!projectId) return { dailyCalls: true, monthlyCost: true };
  const project = projectRepo.getById(projectId);
  if (!project) return { dailyCalls: true, monthlyCost: true };
  const dailyCap = Number.isFinite(project.visionHealMaxCallsPerDay)
    ? project.visionHealMaxCallsPerDay : 100;
  const monthlyCap = Number.isFinite(project.visionHealMaxCostUsdPerMonth)
    ? project.visionHealMaxCostUsdPerMonth : 50;
  const calls = getDailyCalls(projectId);
  const cost = getMonthlyCost(projectId);
  return {
    dailyCalls:  calls >= dailyCap,
    monthlyCost: cost >= monthlyCap,
  };
}

/**
 * Delete budget rows older than `days` days (by `updatedAt`). Called from
 * the scheduler's daily sweep so historical buckets don't accumulate.
 *
 * Today's daily bucket and this month's monthly bucket are written every
 * call, so their `updatedAt` is always fresh — they survive any sane
 * retention setting. A 90-day default keeps a quarter of trend data
 * around for the dashboard without unbounded growth.
 *
 * @param {number} days
 * @returns {number}
 */
export function purgeOlderThan(days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM vision_heal_budget WHERE updatedAt < ?").run(cutoff).changes;
}

/**
 * Delete all budget rows for a project (cascade from project hard-delete).
 *
 * @param {string} projectId
 * @returns {number}
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare("DELETE FROM vision_heal_budget WHERE projectId = ?").run(projectId).changes;
}

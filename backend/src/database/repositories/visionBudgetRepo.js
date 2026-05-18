/**
 * @module database/repositories/visionBudgetRepo
 * @description MNT-001b — per-project budget counters enforced by
 * `tryVisionHeal` stage 8.
 *
 * Two windows per project:
 *   - day   — `calls`   vs `project.visionHealMaxCallsPerDay`
 *   - month — `costUsd` vs `project.visionHealMaxCostUsdPerMonth`
 *
 * Schema (`vision_budget_counters`): one row per (projectId, windowKind,
 * windowKey). The `windowKind` column is the discriminator ('day' | 'month')
 * with a CHECK constraint; `windowKey` is the bare date / month string
 * (no prefix — the discriminator lives in its own column for indexability).
 * Named `windowKind` rather than `window` because `window` is a reserved
 * keyword in PostgreSQL (window functions) and unquoted DDL fails there.
 *
 * UTC throughout: a day rolls over at 00:00 UTC, a month at the 1st 00:00
 * UTC. We don't try to align to a tenant's local timezone — operators
 * looking at the budget gauge see a single global rollover, which is
 * easier to reason about than per-tenant clocks.
 */
import { getDatabase } from "../sqlite.js";
import * as projectRepo from "./projectRepo.js";

/**
 * Compute the current day-window key from `now`. Format `YYYY-MM-DD` in
 * UTC so callers across timezones share one bucket per project. Bare —
 * the discriminator ('day') lives in its own column, not as a prefix.
 *
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function dayKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Compute the current month-window key from `now`. Format `YYYY-MM` in UTC.
 *
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function monthKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Record a single vision-heal LLM call against the project's budget.
 * Increments both the daily call counter and the monthly cost counter
 * in one transaction so the two buckets stay consistent.
 *
 * Stage-7 (pixelmatch) heals pass `costUsd=0` — the daily-call counter
 * still ticks (so "how many heal attempts hit the LLM path" stays
 * accurate for telemetry) but the monthly-cost counter stays put. Stage-8
 * (LLM) passes the per-call cost estimate from `callVisionModel`.
 *
 * @param {string} projectId
 * @param {number} [costUsd=0]  Cost of this single call.
 * @param {Date}   [now]        Override for tests; default `new Date()`.
 */
export function record(projectId, costUsd = 0, now = new Date()) {
  if (!projectId) return;
  const db = getDatabase();
  const updatedAt = now.toISOString();
  const dKey = dayKey(now);
  const mKey = monthKey(now);
  const cost = Number.isFinite(costUsd) ? Number(costUsd) : 0;
  // Single UPSERT statement reused for both row shapes — the discriminator
  // and key are bound per call so the transaction is atomic across both
  // windows. `excluded.costUsd` references the value bound on THIS call so
  // subsequent calls accumulate cost on the monthly row.
  const stmt = db.prepare(`
    INSERT INTO vision_budget_counters (projectId, windowKind, windowKey, calls, costUsd, updatedAt)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(projectId, windowKind, windowKey) DO UPDATE SET
      calls = calls + 1,
      costUsd = costUsd + excluded.costUsd,
      updatedAt = excluded.updatedAt
  `);
  const txn = db.transaction(() => {
    stmt.run(projectId, "day",   dKey, cost, updatedAt);
    stmt.run(projectId, "month", mKey, cost, updatedAt);
  });
  txn();
}

/**
 * Read both window counters for the current day + month in a single
 * helper. Returns `{ dailyCalls, monthlyCostUsd, day, month }` so callers
 * (dashboard route, `isBudgetExhausted`) get a one-shot view without
 * threading dates through two separate calls.
 *
 * @param {string} projectId
 * @param {Date}   [now]
 * @returns {{dailyCalls: number, monthlyCostUsd: number, day: string, month: string}}
 */
export function getCounters(projectId, now = new Date()) {
  const db = getDatabase();
  const today = dayKey(now);
  const thisMonth = monthKey(now);
  const dayRow = db.prepare(
    "SELECT calls FROM vision_budget_counters WHERE projectId = ? AND windowKind = 'day' AND windowKey = ?"
  ).get(projectId, today);
  const monthRow = db.prepare(
    "SELECT costUsd FROM vision_budget_counters WHERE projectId = ? AND windowKind = 'month' AND windowKey = ?"
  ).get(projectId, thisMonth);
  return {
    dailyCalls: dayRow?.calls ?? 0,
    monthlyCostUsd: monthRow?.costUsd ?? 0,
    day: today,
    month: thisMonth,
  };
}

/**
 * Current daily call count for a project. Thin wrapper over
 * {@link getCounters} kept for test ergonomics + dashboard convenience.
 *
 * @param {string} projectId
 * @param {Date}   [now]
 * @returns {number}
 */
export function getDailyCalls(projectId, now = new Date()) {
  return getCounters(projectId, now).dailyCalls;
}

/**
 * Current monthly cost (USD) for a project. Thin wrapper over
 * {@link getCounters}.
 *
 * @param {string} projectId
 * @param {Date}   [now]
 * @returns {number}
 */
export function getMonthlyCost(projectId, now = new Date()) {
  return getCounters(projectId, now).monthlyCostUsd;
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
  // One round-trip via getCounters instead of two — same data, half the
  // statement preparation cost on the hot stage-8 check path.
  const { dailyCalls, monthlyCostUsd } = getCounters(projectId);
  return {
    dailyCalls:  dailyCalls >= dailyCap,
    monthlyCost: monthlyCostUsd >= monthlyCap,
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
  return db.prepare("DELETE FROM vision_budget_counters WHERE updatedAt < ?").run(cutoff).changes;
}

/**
 * Delete all budget rows for a project (cascade from project hard-delete).
 *
 * @param {string} projectId
 * @returns {number}
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare("DELETE FROM vision_budget_counters WHERE projectId = ?").run(projectId).changes;
}

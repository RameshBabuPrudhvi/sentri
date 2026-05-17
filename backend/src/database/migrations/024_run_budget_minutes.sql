-- Migration 021: Run budget minutes (AUTO-001)
--
-- Persist the wall-clock budget (in minutes) that was applied to a test
-- run's dispatch queue so the Run Detail page can render the "budget: Nm"
-- label and so CI consumers polling the trigger status endpoint can see
-- whether the run was capped. Pre-migration runs (and runs triggered
-- without a `budgetMinutes` body param) have NULL here — the frontend
-- omits the badge when the field is null, matching today's behaviour
-- for runs that pre-date this feature.
--
-- Stored as REAL (not INTEGER) because `normalizeBudgetMinutes()` in
-- `backend/src/pipeline/riskScorer.js` clamps to `MAX_BUDGET_MINUTES`
-- but otherwise preserves fractional values (a caller may legitimately
-- pass `2.5` minutes). Nullable with no default to match the established
-- pattern used for `networkCondition` (migration 012) and `browser`
-- (migration 009). Both SQLite and the PostgreSQL adapter (INF-001)
-- handle this form without dialect translation.

ALTER TABLE runs ADD COLUMN budgetMinutes REAL;

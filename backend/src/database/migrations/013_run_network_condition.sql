-- Migration 012: Run network condition (AUTO-006)
--
-- Persist the network condition the run was executed under (`fast` /
-- `slow3g` / `offline`) so historical analytics can answer questions
-- like "did slow-3G runs flake more than fast?". Pre-migration runs
-- have NULL here — analytics queries should treat NULL as `fast` (the
-- documented default).
--
-- Nullable TEXT with no default to match the established pattern used
-- for `browser` (migration 009) and `pages` (migration 007). Both
-- SQLite and the PostgreSQL adapter (INF-001) handle this form
-- without dialect translation.

ALTER TABLE runs ADD COLUMN networkCondition TEXT;

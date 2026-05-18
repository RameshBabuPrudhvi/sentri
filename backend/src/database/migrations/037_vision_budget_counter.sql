-- MNT-001b — per-project, per-window counters for the vision-heal budget
-- circuit-breaker enforced by `tryVisionHeal` stage 8.
--
-- Two row shapes share one table, distinguished by the `windowKind` column:
--   windowKind='day',   windowKey='2026-05-18'  (UTC YYYY-MM-DD)
--   windowKind='month', windowKey='2026-05'     (UTC YYYY-MM)
--
-- NOTE: column is named `windowKind`, not `window` — `window` is a reserved
-- keyword in PostgreSQL (used for window functions) and unquoted DDL fails
-- with a syntax error on that dialect. `windowKind` is portable across
-- SQLite + PostgreSQL without identifier quoting.
--
-- The CHECK constraint catches typos at insert time. Splitting the
-- discriminator into its own column (instead of prefix-encoding into
-- windowKey) makes per-window queries indexable on a real column without
-- `LIKE 'daily:%'` scans, and keeps the date itself parseable for the
-- dashboard's trend chart without string-splitting on every row.
--
-- Both windows roll automatically: `dayKey()` / `monthKey()` return a fresh
-- string at the UTC boundary, so the next call after midnight falls through
-- to a fresh row (callCount=0 default) instead of inheriting yesterday's.
-- Old rows age out via the daily retention sweep.
CREATE TABLE IF NOT EXISTS vision_budget_counters (
  projectId  TEXT    NOT NULL,
  windowKind TEXT    NOT NULL CHECK (windowKind IN ('day', 'month')),
  windowKey  TEXT    NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 0,
  costUsd    REAL    NOT NULL DEFAULT 0,
  updatedAt  TEXT    NOT NULL,
  PRIMARY KEY (projectId, windowKind, windowKey)
);
CREATE INDEX IF NOT EXISTS idx_vision_budget_lookup
  ON vision_budget_counters (projectId, windowKind, windowKey);
CREATE INDEX IF NOT EXISTS idx_vision_budget_updatedAt
  ON vision_budget_counters (updatedAt);

-- MNT-001b — per-project per-window counters for the vision-heal budget
-- circuit-breaker enforced by `tryVisionHeal` stage 8.
--
-- `windowKey` is a string identifier for the (projectId, kind, period)
-- tuple — e.g. "daily:2026-01-15" for the daily-calls bucket and
-- "monthly:2026-01" for the monthly-cost bucket. Storing the period as
-- part of the key (instead of derived columns) keeps the increment path
-- a single UPSERT and lets old buckets age out naturally — the budget
-- check only ever queries the current window's key.
--
-- `dailyCalls` and `monthlyCost` would normally live in separate tables,
-- but co-locating them lets a single `isBudgetExhausted(projectId)` read
-- return both flags from one (projectId, windowKey) lookup per row type.
CREATE TABLE IF NOT EXISTS vision_heal_budget (
  projectId    TEXT    NOT NULL,
  windowKey    TEXT    NOT NULL,  -- "daily:YYYY-MM-DD" | "monthly:YYYY-MM"
  callCount    INTEGER NOT NULL DEFAULT 0,
  costUsd      REAL    NOT NULL DEFAULT 0,
  updatedAt    TEXT    NOT NULL,
  PRIMARY KEY (projectId, windowKey)
);
CREATE INDEX IF NOT EXISTS idx_vision_heal_budget_updatedAt
  ON vision_heal_budget (updatedAt);

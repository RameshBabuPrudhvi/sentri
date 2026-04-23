-- Migration 008: Visual regression baselines (DIF-001)
--
-- Stores the baseline (golden) screenshot reference for a given test + step
-- so future runs can diff against it and surface pixel-level regressions.
-- The actual PNG files live under `artifacts/baselines/<testId>/step-<N>.png`;
-- this table holds the lightweight metadata used to look them up quickly and
-- track when each baseline was last accepted.
--
-- Columns:
--   testId          - FK to tests.id (cascade delete)
--   stepNumber      - 0 for the final end-of-test screenshot, 1..N for per-step
--                     captures (matches DIF-016 stepCaptures numbering).
--   imagePath       - relative path under artifacts/, e.g.
--                     "/artifacts/baselines/TC-1/step-0.png"
--   width, height   - dimensions of the baseline image (used to short-circuit
--                     the diff when a run captures at a different resolution).
--   createdAt       - ISO 8601 timestamp when the baseline was first created.
--   updatedAt       - ISO 8601 timestamp of the most recent "Accept changes".

CREATE TABLE IF NOT EXISTS baseline_screenshots (
  testId      TEXT NOT NULL,
  stepNumber  INTEGER NOT NULL DEFAULT 0,
  imagePath   TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  PRIMARY KEY (testId, stepNumber),
  FOREIGN KEY (testId) REFERENCES tests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_baseline_testId ON baseline_screenshots(testId);

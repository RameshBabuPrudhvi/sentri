-- Migration 010: Browser-aware visual baselines (DIF-002b gap 1)
--
-- Baselines were previously keyed by (testId, stepNumber), which caused
-- false regressions when Firefox/WebKit captures were compared against a
-- Chromium baseline. Re-key baselines by browser engine so each test step
-- keeps separate golden images per browser.

ALTER TABLE baseline_screenshots RENAME TO baseline_screenshots_old;

CREATE TABLE baseline_screenshots (
  testId      TEXT NOT NULL,
  stepNumber  INTEGER NOT NULL DEFAULT 0,
  browser     TEXT NOT NULL DEFAULT 'chromium',
  imagePath   TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  PRIMARY KEY (testId, stepNumber, browser),
  FOREIGN KEY (testId) REFERENCES tests(id) ON DELETE CASCADE
);

INSERT INTO baseline_screenshots (
  testId, stepNumber, browser, imagePath, width, height, createdAt, updatedAt
)
SELECT
  testId, stepNumber, 'chromium', imagePath, width, height, createdAt, updatedAt
FROM baseline_screenshots_old;

DROP TABLE baseline_screenshots_old;

CREATE INDEX IF NOT EXISTS idx_baseline_testId ON baseline_screenshots(testId);
CREATE INDEX IF NOT EXISTS idx_baseline_testId_browser ON baseline_screenshots(testId, browser);

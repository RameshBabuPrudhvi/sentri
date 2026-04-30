-- Migration 013: Accessibility violations (AUTO-016)
-- Persist per-page WCAG violations discovered during crawl.

CREATE TABLE IF NOT EXISTS accessibility_violations (
  runId TEXT NOT NULL,
  pageUrl TEXT NOT NULL,
  ruleId TEXT NOT NULL,
  impact TEXT,
  wcagCriterion TEXT,
  help TEXT NOT NULL,
  description TEXT NOT NULL,
  nodesJson TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (runId) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_accessibility_violations_run ON accessibility_violations(runId);
CREATE INDEX IF NOT EXISTS idx_accessibility_violations_page ON accessibility_violations(runId, pageUrl);

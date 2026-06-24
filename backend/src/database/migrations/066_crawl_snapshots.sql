-- B1.3 — Snapshot streaming (AUDIT-ROADMAP Bundle 1).
--
-- Replaces the in-memory `run.snapshots[]` accumulation pattern in
-- `crawlBrowser.js` / `stateExplorer.js` with an append-only table.
-- Each crawled page persists its snapshot JSON immediately and the
-- pipeline generates tests for that page before crawling the next,
-- dropping peak heap from O(N pages) to O(1 page).
--
-- The `loadMs` column is consumed by Bundle 2 (B2-3 adaptive timeout)
-- to compute `run.p95LoadMs` post-crawl. Included now so B2 doesn't
-- need a follow-up ALTER TABLE.
--
-- Rollback: DROP TABLE crawl_snapshots; — callers fall back to the
-- in-memory shadow path that the pipeline retains during the B1 →
-- B2 transition.

-- Referential integrity: `ON DELETE CASCADE` mirrors every other child
-- table of `runs` (run_logs, accessibility_violations, …) so a parent
-- run purge cleans up snapshots without leaving orphans — SOC 2 CC8.1
-- baseline for audit-trail integrity.

CREATE TABLE IF NOT EXISTS crawl_snapshots (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  snapshotJson TEXT NOT NULL,
  loadMs INTEGER,
  fromIframe INTEGER DEFAULT 0,
  iframeSrc TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE(runId, url)
);

CREATE INDEX IF NOT EXISTS idx_cs_runId ON crawl_snapshots(runId);

INSERT OR IGNORE INTO counters(name, value) VALUES ('crawl_snapshot', 0);

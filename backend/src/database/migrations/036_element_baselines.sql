-- MNT-001b — per-element baseline crops captured on green runs so the
-- vision-healing waterfall (stage 7 pixelmatch) has something to slide-match
-- against when DOM selectors break.
--
-- Key shape mirrors healing_history: "<versionedTestId>::<action>::<label>"
-- where versionedTestId already encodes the test's codeVersion (e.g.
-- "TC-1@v2"). When the test body changes, healingScopeId bumps and the
-- old crops become unreachable by lookup — they age out via the daily
-- retention sweep below rather than being deleted inline.
--
-- BLOB column: better-sqlite3 binds Node Buffer directly; the Postgres
-- adapter translates to BYTEA. Typical row is 2-10 KB (small UI element
-- at viewport scale); 1000 baselines per project ≈ 10 MB. The index on
-- capturedAt keeps the retention sweep O(log n) instead of full-scan.
CREATE TABLE IF NOT EXISTS element_baselines (
  projectId    TEXT    NOT NULL,
  healingKey   TEXT    NOT NULL,
  cropPng      BLOB    NOT NULL,
  cropWidth    INTEGER NOT NULL,
  cropHeight   INTEGER NOT NULL,
  capturedAt   TEXT    NOT NULL,
  PRIMARY KEY (projectId, healingKey)
);
CREATE INDEX IF NOT EXISTS idx_element_baselines_capturedAt
  ON element_baselines (capturedAt);

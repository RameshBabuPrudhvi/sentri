-- B1.1 — Run checkpoint / crash-recovery columns (AUDIT-ROADMAP Bundle 1).
--
-- `failureReason` distinguishes ordinary test failures from process-level
-- terminations. On server startup, any run still flagged `status =
-- 'running'` with no `run_test_results` flush in the last
-- `CHECKPOINT_STALE_MS` window is transitioned to
-- `status = 'failed', failureReason = 'process_crash'` so the UI does
-- not show phantom in-flight runs.
--
-- `reviewRejectedTests` AND `reviewerCollapsed` are both forward-declared
-- here (despite belonging conceptually to Bundle 3) because the
-- AUDIT-ROADMAP doc at `docs/roadmap/AUDIT-ROADMAP.md:507-509` declares
-- BOTH columns in the same B3 migration stub. Forward-declaring the pair
-- on B1's migration avoids a redundant ALTER TABLE round-trip when B3
-- lands, and keeps the "B1 forward-declared what B3 needs" promise the
-- PR description makes (originally only `reviewRejectedTests` was
-- forward-declared, leaving `reviewerCollapsed` as a gratuitous future
-- migration). B3 will populate both columns; B1 only reads
-- `failureReason`. Default 0 (false) matches B3's spec:
-- "ALTER TABLE runs ADD COLUMN reviewerCollapsed INTEGER DEFAULT 0".
--
-- Convention: `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite.
-- The migration runner (`migrate.js`) tolerates "duplicate column name"
-- errors so re-running this file is safe on already-migrated DBs.

ALTER TABLE runs ADD COLUMN failureReason TEXT;
ALTER TABLE runs ADD COLUMN reviewRejectedTests TEXT DEFAULT '[]';
ALTER TABLE runs ADD COLUMN reviewerCollapsed INTEGER DEFAULT 0;

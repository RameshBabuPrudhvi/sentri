-- B3 (AUDIT-ROADMAP Bundle 3) — per-project escalation threshold for
-- review-rejection notifications. When the post-run feedback loop's
-- reviewer↔author loop terminates with `ReviewRejection` for N tests,
-- the FEA-001 dispatcher only fires when
-- `run.reviewRejectedTests.length >= reviewRejectionAlertThreshold`.
--
-- Default 0 → "always notify on any rejection" (industry default for
-- escalation gates: surface everything until the operator dials in
-- a noise floor). Explicit -1 → "never notify" (operator opt-out
-- mirrors GitHub Actions `failure-notification-threshold: -1` and
-- Datadog monitor mute semantics).
--
-- Spec: `docs/roadmap/AUDIT-ROADMAP.md:502-504`.
--
-- Convention: `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite.
-- The migration runner (`migrate.js`) tolerates "duplicate column name"
-- errors so re-running this file is safe on already-migrated DBs.
-- `schema_migrations` ledger ensures this file runs exactly once.

ALTER TABLE projects ADD COLUMN reviewRejectionAlertThreshold INTEGER DEFAULT 0;

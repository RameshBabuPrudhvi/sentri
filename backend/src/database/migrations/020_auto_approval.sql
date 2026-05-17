-- Migration 017: confidence scoring + auto-approval thresholds/provenance
-- (AUTO-003b)
--
-- Idempotency note: uses bare `ALTER TABLE ... ADD COLUMN` per the
-- convention followed by migrations 003, 006, 007, 011, 014, 015, 018.
-- Idempotency is guaranteed at the *runner* level — `schema_migrations`
-- tracks applied versions (`backend/src/database/migrationRunner.js`), so
-- re-running a file is a no-op. `ADD COLUMN IF NOT EXISTS` was considered
-- as belt-and-suspenders but is SQLite-3.35+ only and has different syntax
-- in PostgreSQL, which the migration adapter's `translateSql()` doesn't
-- currently handle. Breaking convention for marginal safety isn't worth
-- the portability risk.

ALTER TABLE tests ADD COLUMN confidenceScore REAL;
ALTER TABLE tests ADD COLUMN approvalSource TEXT;
ALTER TABLE tests ADD COLUMN approvalThreshold REAL;
ALTER TABLE tests ADD COLUMN approvedAt INTEGER;
ALTER TABLE tests ADD COLUMN approvedBy TEXT;

ALTER TABLE projects ADD COLUMN autoApproveThreshold REAL;

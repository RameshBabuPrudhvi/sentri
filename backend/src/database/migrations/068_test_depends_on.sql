-- Migration 068: Per-test dependency declarations (AUTO-014)

ALTER TABLE tests ADD COLUMN dependsOn JSON;

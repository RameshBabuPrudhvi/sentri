-- B6.1 — Per-test dry-run execution gate (AUDIT-ROADMAP Bundle 6, QAL-001).
--
-- Adds three columns to `tests` that record the outcome of the one-shot
-- dry-run executed by `pipeline/dryRunGate.js` BEFORE the test enters the
-- review queue. When `project.dryRunGate = 1` is set, every generated test
-- is executed once against the project URL in a lightweight
-- `browserPool.acquire()` lease; the outcome lands on these columns:
--
--   • dryRunStatus      — TEXT enum: 'passed' | 'failed' | 'trivial' | NULL.
--                          NULL = gate was disabled when the test was
--                          persisted (legacy + opted-out projects).
--                          'trivial' = all assertions completed in
--                          < DRY_RUN_TRIVIAL_THRESHOLD_MS with zero
--                          network requests (spec at
--                          `docs/roadmap/AUDIT-ROADMAP.md:739-741`).
--   • dryRunError       — TEXT, first ~2KB of the Playwright error
--                          message when status='failed'. Mirrors the
--                          `run_test_results.error` shape so the Review
--                          Queue card can render the same chip.
--   • dryRunDurationMs  — INTEGER, wall-clock of the dry-run lease;
--                          drives the 'trivial' threshold check and the
--                          `app_dry_run_gate_duration_seconds` histogram.
--
-- Industry parallels: Cypress `cy.session()` validation, Playwright's own
-- `--ui` smoke pass, GitHub Actions `--dry-run`, Terraform `plan`.
-- Treating "passes structural validation but fails on first execution"
-- as a separate signal from "fails review" is the canonical pre-merge
-- gate pattern in test-platform design.
--
-- Auto-approval interaction: `testPersistence.js#persistGeneratedTests`
-- gates `reviewStatus = 'approved'` on `dryRunStatus === 'passed'` so a
-- dry-run failure is never auto-approved (spec at
-- `docs/roadmap/AUDIT-ROADMAP.md:743-744`).
--
-- Rollback: ALTER TABLE tests DROP COLUMN dryRunStatus / dryRunError /
-- dryRunDurationMs; pipeline reverts to the pre-B6 path (every test
-- enters review queue regardless of execution outcome).

ALTER TABLE tests ADD COLUMN dryRunStatus TEXT;
ALTER TABLE tests ADD COLUMN dryRunError TEXT;
ALTER TABLE tests ADD COLUMN dryRunDurationMs INTEGER;

CREATE INDEX IF NOT EXISTS idx_tests_dryRunStatus ON tests(dryRunStatus);

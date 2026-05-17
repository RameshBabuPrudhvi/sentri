-- Migration 018: structured metadata column on activities for AUTO-003b.
--
-- The auto-approval pipeline (testPersistence.js) and the revoke handler
-- (routes/tests.js) need to attach typed metadata to activity rows
-- (`{ score, threshold }` on `test.auto_approve`, `{ wasAutoApproved }` on
-- `test.revoke`) so the project-level approval-stats handler can compute a
-- 7-day revert rate without correlating testIds across activity types.
-- Stored as JSON-encoded TEXT to keep it forward-compatible — readers parse
-- on the way out, writers serialize on the way in.

ALTER TABLE activities ADD COLUMN meta TEXT;

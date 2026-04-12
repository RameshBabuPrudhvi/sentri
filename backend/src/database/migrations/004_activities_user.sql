-- Migration 004: Add userId and userName columns to activities table
-- Enables a full, per-user audit trail — previously impossible to know
-- which user performed which action.
--
-- Both columns are nullable: system-generated activities (orphan recovery,
-- scheduled runs, background jobs) have no associated user and store NULL.
-- All user-triggered activities from /api/* routes will populate userId and
-- userName from req.authUser (set by requireAuth middleware).

ALTER TABLE activities ADD COLUMN userId   TEXT;
ALTER TABLE activities ADD COLUMN userName TEXT;

-- Index for filtering the activity log by a specific user
CREATE INDEX IF NOT EXISTS idx_activities_userId ON activities(userId);

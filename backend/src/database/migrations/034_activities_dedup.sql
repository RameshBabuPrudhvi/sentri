-- SEC-007: industry-standard audit-log event dedup (Splunk / CloudTrail /
-- Auth0 / Datadog all collapse identical consecutive events into a single
-- row with a count + lastAt — see PCI-DSS 10.5.3 which explicitly permits
-- "summarisation of repeated events" provided every event remains
-- attributable).
--
-- ### Columns
-- `count`  — how many identical events collapsed into this row. Starts at 1
--            for every freshly INSERTed row. Caller `activityRepo.create`
--            increments via UPDATE when a dedup-window hit fires.
-- `lastAt` — most recent occurrence of this collapsed event. `createdAt`
--            keeps the FIRST occurrence (so the chronological feed order
--            is stable); `lastAt` is what the UI shows when count > 1.
--
-- ### Why nullable + default 1 (not NOT NULL with backfill)
-- The migration is additive — every existing row keeps `count = 1`,
-- `lastAt = NULL`. Readers treat `lastAt IS NULL` as "single event,
-- never deduped" and fall back to `createdAt`. This makes the change
-- non-breaking for historical rows that predate dedup.
ALTER TABLE activities ADD COLUMN count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activities ADD COLUMN lastAt TEXT NULL;

-- Index supports the dedup lookup: find the most recent row for
-- (workspaceId, userId, type) so we can compare against the dedup window.
-- The existing `idx_activities_userId` is too broad (no type filter), and
-- `idx_activities_type` doesn't include the actor scope — dedup needs both.
CREATE INDEX IF NOT EXISTS idx_activities_dedup
  ON activities(workspaceId, userId, type, createdAt);

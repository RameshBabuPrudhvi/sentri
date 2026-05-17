-- CAP-002: persist shard metadata on runs.
ALTER TABLE runs ADD COLUMN shardCount INTEGER;
ALTER TABLE runs ADD COLUMN shardsCompleted INTEGER;

-- CAP-002 Phase 2 (Prerequisite #2): per-shard trace artifacts.
-- A shard-mode run produces N trace zips at
-- `${TRACES_DIR}/${runId}/shard-${shardIndex}.zip`, one per shard worker.
-- The existing `tracePath` TEXT column holds the canonical first-shard
-- path so legacy consumers keep working unchanged; this new JSON-array
-- column carries the full per-shard list so `RunDetail.jsx` can render
-- a dropdown when `shardCount > 1`. Single-shard runs leave this column
-- NULL — the existing `tracePath` is sufficient.
ALTER TABLE runs ADD COLUMN tracePaths TEXT;

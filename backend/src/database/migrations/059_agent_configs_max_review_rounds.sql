-- B3.3 — Per-workspace, per-role reviewer↔author loop bound.
--
-- Adds `agent_configs.maxReviewRounds` so operators can tune the loop
-- ceiling on a per-(workspace, role) basis without redeploying. The
-- server-side `HARD_MAX_REVIEW_ROUNDS = 10` cap in
-- `backend/src/aiProvider/agentLoop.js` remains the absolute ceiling —
-- this column is clamped to `[1, 10]` at the repo layer.
--
-- NULL = use loop default (`DEFAULT_MAX_REVIEW_ROUNDS = 3`). We do not
-- set a column-level DEFAULT 3 because we want a row that has never
-- been touched to read as "no override" rather than "operator pinned 3"
-- — the runtime default lives in code and stays authoritative.
--
-- Both SQLite + Postgres accept bare `ALTER TABLE ... ADD COLUMN`
-- unchanged. The runner-level `schema_migrations` ledger ensures this
-- file runs exactly once (mirrors migration 058's pattern).

ALTER TABLE agent_configs ADD COLUMN maxReviewRounds INTEGER;

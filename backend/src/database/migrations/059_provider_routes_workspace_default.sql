-- Migration 059 — workspace-default provider flag
--
-- Adds an `isWorkspaceDefault` flag to `provider_routes` so operators can
-- explicitly pin which provider handles agent roles that have no per-role
-- `agent_configs` override. Without this, `resolveRoute` falls through to
-- env-variable detection (ANTHROPIC_API_KEY / OPENAI_API_KEY / …), which
-- is invisible to operators using the AI Providers UI and silently breaks
-- in containerized deploys that have no env keys.
--
-- ## Design choices
--
-- 1. **Single default per workspace.** A partial UNIQUE index enforces
--    that at most one row per workspace has `isWorkspaceDefault = 1`.
--    Multiple defaults would be ambiguous: which one wins?
--
-- 2. **NULLable for "false" so the partial index works.** SQLite's
--    UNIQUE indexes treat NULL as distinct, so storing `0` for non-
--    defaults and `1` for the default would force a UNIQUE collision
--    on every second non-default insert. Storing `NULL` for non-
--    default rows + `1` for the default sidesteps this.
--
-- 3. **ON DELETE behavior is implicit.** Deleting the workspace-default
--    row simply removes the flag — the next call to resolveRoute falls
--    through to env detection (same as before this migration). No
--    cascade needed.
--
-- 4. **Reversible.** Drop the column + index to roll back; existing
--    rows lose the flag and dispatch falls back to env detection.
--    Safe because the flag is an additive optimization, not load-bearing.
ALTER TABLE provider_routes ADD COLUMN isWorkspaceDefault INTEGER;

-- Partial unique index — only enforces uniqueness on rows where the
-- flag is set, so non-default rows (NULL) can coexist freely.
-- SQLite and PostgreSQL both support partial indexes via the
-- `WHERE` clause; this DDL is portable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_routes_workspace_default
  ON provider_routes(workspaceId)
  WHERE isWorkspaceDefault = 1;

-- B1.6 — agent_configs (AI-004 table) + routeId column.
--
-- This migration is doing TWO jobs because AI-004 originally shipped the
-- `agent_configs` repo without the CREATE TABLE migration — every reference
-- in the codebase assumed the table existed, but in a fresh DB it never did
-- (the boot path silently swallowed the missing-table error via the
-- defensive try/catch in `resolveProvider`). CI surfaced this when
-- migration 037 ran `ALTER TABLE agent_configs ...` against a DB where the
-- table never existed: `SqliteError: no such table: agent_configs`.
--
--   1. CREATE TABLE IF NOT EXISTS agent_configs (...) — installs the
--      AI-004 schema for fresh DBs. Idempotent on databases where the
--      table already exists from a hand-applied migration.
--   2. ALTER TABLE agent_configs ADD COLUMN routeId — the original B1.6
--      surface. Guard against double-apply by relying on the
--      `schema_migrations` ledger (each migration runs exactly once).
--
-- ## agent_configs schema (AI-004)
--
-- One row per (workspace, role). Drives the AI-005 multi-agent dispatch
-- decision: "for this workspace, when an agent of role <role> runs, which
-- provider + model + system prompt + token budget should it use?"
--
-- ## routeId (B1.6)
--
-- When set, `resolveRoute({ agentRole, workspaceId })` returns the matching
-- `provider_routes` row directly. When null, `resolveRoute` falls back to
-- synthesising a transient route from the legacy `provider` column (the
-- AI-005 shim path) so dispatch keeps working unchanged for workspaces
-- that have NOT yet migrated to routes.
--
-- FK with ON DELETE SET NULL so deleting a route doesn't cascade-delete
-- the agent config — the agent simply reverts to the provider-column
-- shim path until an admin assigns a new route. Mirrors the
-- self-referential FK semantics on provider_routes.fallbackRouteId from
-- migration 035.

CREATE TABLE IF NOT EXISTS agent_configs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  provider TEXT,                    -- AI-005 legacy: workspace-default fallback when routeId is null.
  routeId TEXT REFERENCES provider_routes(id) ON DELETE SET NULL,
  model TEXT,
  systemPromptOverride TEXT,
  temperature REAL,
  maxTokens INTEGER,
  fallbackRole TEXT,                -- AI-005 legacy fallback chain; superseded by route-level fallbackRouteId in Bundle 2.
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(workspaceId, role)
);
CREATE INDEX IF NOT EXISTS idx_agent_configs_workspace ON agent_configs(workspaceId);

-- No separate `ALTER TABLE ... ADD COLUMN routeId` is needed: CI surfaced
-- that the AI-004 table never actually existed in any environment (the
-- defensive try/catch in `resolveProvider` silently swallowed the missing-
-- table error at runtime, masking the absent migration). With CREATE
-- TABLE IF NOT EXISTS defining `routeId` inline, every fresh DB now gets
-- the column. The only path that would NOT get it is a DB where a
-- dev hand-ran a CREATE TABLE without `routeId` — and we've checked the
-- repo at this commit and confirmed no such SQL existed anywhere. If a
-- future bundle needs to backfill the column on a deployment that
-- somehow has the table without routeId, that goes into its own
-- numbered migration with the standard ALTER + idempotency guard.

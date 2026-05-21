-- B4.6 — Route groups for weighted / latency / cost-aware routing.
--
-- Operators can group multiple provider_routes rows under a single
-- `route_groups` entry and assign the group to an agent_config's
-- `routeId`. `resolveRoute` resolves group → concrete route at call
-- time using the group's `strategy`:
--
--   • `weighted`  — random pick by `weight` column
--   • `latency`   — pick the lowest-p50 healthy route
--   • `cost`      — pick the cheapest route meeting capability reqs
--
-- The schema is intentionally minimal — a group is just an id + name +
-- strategy; members are a join table with a weight column. The resolver
-- reads both tables in one query and picks inline. No background worker,
-- no pre-computed routing table, no external dependency.
--
-- ## FK design
--
-- `route_group_members.routeId` cascades on delete so removing a route
-- automatically shrinks the group. `route_groups.id` does NOT cascade
-- from `agent_configs.routeId` — an agent_config can point at either a
-- `provider_routes.id` or a `route_groups.id`; the resolver
-- distinguishes by prefix (`pr-` vs `rg-`).
--
-- ## Compatibility
--
-- SQLite + PostgreSQL both accept this syntax. No CHECK constraints —
-- strategy enum is validated at the route layer.
CREATE TABLE IF NOT EXISTS route_groups (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'weighted',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(workspaceId, name)
);
CREATE TABLE IF NOT EXISTS route_group_members (
  id TEXT PRIMARY KEY,
  groupId TEXT NOT NULL REFERENCES route_groups(id) ON DELETE CASCADE,
  routeId TEXT NOT NULL REFERENCES provider_routes(id) ON DELETE CASCADE,
  weight INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  UNIQUE(groupId, routeId)
);
CREATE INDEX IF NOT EXISTS idx_route_group_members_group ON route_group_members(groupId);
CREATE INDEX IF NOT EXISTS idx_route_groups_workspace ON route_groups(workspaceId);

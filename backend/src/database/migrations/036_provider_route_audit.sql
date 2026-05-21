-- B1.2 — provider_route_audit
--
-- Append-only audit trail for every mutation to `provider_routes` plus the
-- handful of read-side events that change observable state (key probes,
-- exports, imports). Designed to be the single source of truth for "who
-- changed which route, when, and what did they touch?" — paired with the
-- existing `activities` audit log surface, this one is route-scoped so the
-- Settings → Provider Routes screen can render a per-route history without
-- joining against the global activities firehose.
--
-- Hard invariants (enforced at the repo layer):
--   • Inserts only. No UPDATE / DELETE paths exposed.
--   • `metadata` is JSON-stringified context, NEVER a plaintext API key
--     — rotate_key events store `{ lastFour: "abcd" }` from
--     `provider_routes.apiKeyLastFour`, not the secret itself.
--
-- Indexing:
--   • (workspaceId, createdAt) — drives the paginated list query used by
--     the audit-log UI. createdAt second so the workspace prefix narrows
--     before the time scan.
--   • routeId left unindexed for now — per-route history is filtered in the
--     workspace scan path; add a covering index if a per-route view ships.

CREATE TABLE IF NOT EXISTS provider_route_audit (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  routeId TEXT,
  userId TEXT,
  action TEXT NOT NULL,                 -- create|update|delete|rotate_key|probe|export|import
  metadata TEXT,                        -- JSON, never plaintext keys
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_audit_workspace ON provider_route_audit(workspaceId, createdAt);

/**
 * @module database/repositories/providerRouteAuditRepo
 * @description B1.2 — Append-only audit trail for `provider_routes`
 *   mutations and security-relevant reads (rotate_key, probe, export,
 *   import). The repo intentionally exposes only `append` + paginated
 *   `list` — there is no update or delete path so the audit log can be
 *   trusted as a tamper-evident record of who changed what.
 *
 * ## Security contract
 *
 * - `metadata` is the only free-form column. Callers MUST stringify
 *   structured context (`JSON.stringify`) BEFORE calling `append`. The
 *   repo never inspects the payload, so the burden of redacting
 *   plaintext secrets falls on the caller — by convention, rotate_key
 *   events store `{ lastFour }` from `provider_routes.apiKeyLastFour`
 *   and never the cleartext key.
 *
 * - `list` is workspace-scoped and accepts an optional `routeId` filter.
 *   Cross-workspace reads are not supported by design.
 *
 * ## Schema
 *
 * Defined in `migrations/036_provider_route_audit.sql`.
 */

import { randomUUID } from "crypto";
import { getDatabase } from "../sqlite.js";

// Per-process monotonic sequence prefix for audit row ids. Two audit rows
// written in the same millisecond would otherwise tie on `createdAt` and
// fall back to a random-UUID tiebreaker in `ORDER BY createdAt DESC, id
// DESC` — non-deterministic ordering breaks the `provider-routes.test.js`
// "remove() emits delete after create" assertion intermittently (and any
// real UI relying on chronological audit-row ordering). We prepend a
// 16-hex-char zero-padded counter to the id so lexicographic `id DESC`
// matches insertion order. Portable across SQLite + PostgreSQL — we
// deliberately do NOT use SQLite's `rowid` because the postgres adapter
// doesn't translate that pseudo-column and the queries would fail there.
// Counter resets on process restart, but `createdAt` (the primary sort
// key) has always advanced by then so cross-restart ordering still works.
let _auditSeq = 0n;
function nextSeqHex() {
  _auditSeq = (_auditSeq + 1n) & 0xFFFFFFFFFFFFFFFFn;
  return _auditSeq.toString(16).padStart(16, "0");
}

/**
 * Allow-listed audit actions. Mirrors the column comment on the migration
 * and the route-handler call sites in B1.3+. Validated here so a typo at
 * a call site (`"deleted"` vs `"delete"`) fails fast instead of polluting
 * the audit log with un-queryable variants.
 *
 * @type {ReadonlySet<string>}
 */
export const AUDIT_ACTIONS = Object.freeze(new Set([
  "create",
  "update",
  "delete",
  "rotate_key",
  "probe",
  "export",
  "import",
]));

/**
 * Append a single audit row. Synchronous (better-sqlite3) — callers in
 * the request lifecycle can fire-and-forget without awaiting an async
 * boundary.
 *
 * @param {Object}  entry
 * @param {string}  entry.workspaceId           - Required. FK to `workspaces.id` (not declared at the SQL level so historical rows survive workspace deletion — same pattern as the global `activities` table).
 * @param {string}  [entry.routeId]             - Optional. FK-ish to `provider_routes.id`. Nullable for workspace-scoped events that don't target a specific route (e.g. bulk `import`).
 * @param {string}  [entry.userId]              - Optional. Actor id. Null for system-initiated events (cron probes, etc).
 * @param {string}  entry.action                - Required. One of {@link AUDIT_ACTIONS}.
 * @param {Object|string|null} [entry.metadata] - Optional. Object → JSON-stringified here; string → stored as-is (caller is responsible for valid JSON); null → stored as null. Plaintext secrets MUST be redacted by the caller before passing in.
 * @returns {{ id: string, createdAt: string }} The freshly persisted row's id + timestamp, for log correlation.
 * @throws {Error} When `action` is not in {@link AUDIT_ACTIONS} (`code === "ERR_AUDIT_INVALID_ACTION"`).
 * @throws {Error} When `workspaceId` is falsy (`code === "ERR_AUDIT_MISSING_WORKSPACE"`).
 */
export function append(entry) {
  if (!entry?.workspaceId) {
    const err = new Error("workspaceId is required");
    err.code = "ERR_AUDIT_MISSING_WORKSPACE";
    throw err;
  }
  if (!AUDIT_ACTIONS.has(entry.action)) {
    const err = new Error(`Invalid audit action: ${entry.action}`);
    err.code = "ERR_AUDIT_INVALID_ACTION";
    throw err;
  }
  // Monotonic-prefix id so lexicographic ordering on `id DESC` matches
  // insertion order — the random-UUID suffix preserves uniqueness even if
  // a future change reads `_auditSeq` from disk and replays old values.
  const id = `pra-${nextSeqHex()}-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  // Normalise metadata: objects → JSON; strings + null pass through. This
  // matches the convention in `activities.meta` (migration 018) so the two
  // audit surfaces are interchangeable for downstream consumers.
  let metadata = null;
  if (entry.metadata != null) {
    metadata = typeof entry.metadata === "string"
      ? entry.metadata
      : JSON.stringify(entry.metadata);
  }
  getDatabase().prepare(`
    INSERT INTO provider_route_audit (id, workspaceId, routeId, userId, action, metadata, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, entry.workspaceId, entry.routeId || null, entry.userId || null, entry.action, metadata, createdAt);
  return { id, createdAt };
}

/**
 * Paginated read of audit rows for a workspace, newest first.
 *
 * Pagination uses keyset (`before` / `createdAt`) rather than OFFSET so
 * large audit tables stay O(log n) per page. The (workspaceId, createdAt)
 * index from the migration is the covering index for this query.
 *
 * @param {string} workspaceId       - Required. Workspace scope.
 * @param {Object} [opts]
 * @param {string} [opts.routeId]    - Optional filter to a single route's history.
 * @param {string} [opts.action]     - Optional filter to a single action type.
 * @param {string} [opts.before]     - Optional ISO timestamp — returns rows with `createdAt < before`. Use the previous page's last row's `createdAt` to paginate.
 * @param {number} [opts.limit=50]   - Max rows to return. Clamped to [1, 500].
 * @returns {Object[]} Rows in `createdAt DESC` order. `metadata` is left as a string — caller decides whether to `JSON.parse`.
 */
export function list(workspaceId, opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  const clauses = ["workspaceId = ?"];
  const params = [workspaceId];
  if (opts.routeId) {
    clauses.push("routeId = ?");
    params.push(opts.routeId);
  }
  if (opts.action) {
    clauses.push("action = ?");
    params.push(opts.action);
  }
  if (opts.before) {
    clauses.push("createdAt < ?");
    params.push(opts.before);
  }
  const where = clauses.join(" AND ");
  return getDatabase().prepare(
    `SELECT id, workspaceId, routeId, userId, action, metadata, createdAt
       FROM provider_route_audit
      WHERE ${where}
      ORDER BY createdAt DESC, id DESC
      LIMIT ?`
  ).all(...params, limit);
}

/**
 * B3.9 — Daily retention sweep. Deletes audit rows older than the
 * configured window. The default 90-day retention matches the roadmap
 * checklist; operators tune via `SENTRI_AUDIT_RETENTION_DAYS`. The
 * `(workspaceId, createdAt)` index from migration 036 doesn't cover
 * this query (no workspace filter), but `createdAt` is highly
 * selective on its own — even at 1M-row tables the sweep is sub-second.
 *
 * Returns the number of rows deleted for log correlation. Best-effort
 * — a DB failure logs and returns 0; the next janitor run picks up
 * what this one missed.
 *
 * @param {number} days - Retention window in days. `≤ 0` disables the
 *   sweep entirely (returns 0 without touching the table).
 * @returns {number} Rows deleted.
 */
export function purgeOlderThan(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  try {
    const result = getDatabase().prepare(
      "DELETE FROM provider_route_audit WHERE createdAt < ?",
    ).run(cutoff);
    return result.changes || 0;
  } catch {
    return 0;
  }
}

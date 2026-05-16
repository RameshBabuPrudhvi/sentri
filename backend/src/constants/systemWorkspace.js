/**
 * @module constants/systemWorkspace
 * @description SEC-007: sentinel workspace ID for activity rows that have no
 * resolvable tenant.
 *
 * ### Problem
 * Some audit events fire BEFORE a workspace can be resolved — most notably
 * `auth.login.failed` against an unknown email (credential-stuffing probe).
 * Persisting these rows with `workspaceId = NULL` makes them invisible to
 * every workspace-scoped admin query, which means probes against the
 * deployment leave no surfacing path other than direct DB inspection.
 *
 * ### Solution
 * Tag those rows with `SYSTEM_WORKSPACE_ID` — a fixed, well-known string
 * that:
 *   1. Cannot collide with any real workspace. `generateWorkspaceId()`
 *      (`backend/src/utils/idGenerator.js`) mints IDs as `WS-<n>` from
 *      a monotonic counter; `__system__` is structurally outside that
 *      namespace.
 *   2. Lets a dedicated admin route surface these events without bypassing
 *      the standard `workspaceId` column or adding null-handling everywhere.
 *
 * ### Surfacing path
 * `GET /api/v1/system/security-events` (admin-only) filters
 * `workspaceId = SYSTEM_WORKSPACE_ID` and returns the system-scoped events.
 * The workspace-scoped routes (`/activities`, `/workspaces/:id/audit-log`)
 * filter by `req.workspaceId` and naturally exclude system rows — a real
 * tenant cannot see them.
 *
 * ### Why not just route to "the workspace of the email that was probed"?
 * Because:
 *   - The email is unknown, so there's no user → no workspace mapping.
 *   - Even when we COULD resolve, doing so leaks tenant existence: an
 *     attacker who probes `alice@acme.com` could detect membership of
 *     workspace `acme` from the side-channel of which workspace the row
 *     lands in. Sentinel routing decouples the probe from any tenant.
 */
export const SYSTEM_WORKSPACE_ID = "__system__";

/**
 * Test whether a workspaceId is the system sentinel.
 *
 * Use this instead of comparing the literal string at the call site so a
 * future rename (e.g. to `__sentri_system__`) is a one-file change.
 *
 * @param {string|null|undefined} workspaceId
 * @returns {boolean}
 */
export function isSystemWorkspace(workspaceId) {
  return workspaceId === SYSTEM_WORKSPACE_ID;
}

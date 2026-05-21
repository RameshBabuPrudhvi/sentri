/**
 * @module middleware/workspaceScope
 * @description Middleware that resolves the authenticated user's workspace
 * and role, injecting `req.workspaceId` and `req.userRole` on every request.
 *
 * Must run AFTER `requireAuth` (which sets `req.authUser`).
 *
 * ### Resolution strategy
 * The JWT contains `workspaceId` as a hint for which workspace the user last
 * used.  The **role is always resolved from the database** so that permission
 * changes (promote / demote / remove) take effect immediately — not after the
 * JWT expires.  This follows the Slack / GitHub model: identity in the token,
 * authorization from the DB.
 *
 * If the user has no workspace membership at all, returns 403.
 *
 * @example
 * import { workspaceScope } from "../middleware/workspaceScope.js";
 * app.use("/api/projects", requireAuth, workspaceScope, projectsRouter);
 */

import * as workspaceRepo from "../database/repositories/workspaceRepo.js";
import * as Sentry from "@sentry/node";

/**
 * INF-007 — Attach the authenticated user + workspace identity to the current
 * Sentry scope so any error captured during this request carries the tenant
 * identifier as searchable tags / user context.
 *
 * Without this, multi-tenant Sentry inboxes look like undifferentiated
 * noise — operators cannot answer "which customer is impacted?" without
 * cross-referencing every event by hand. With it:
 *
 *   - `Sentry.setUser({ id })` — populates the standard `user.id` field so
 *     Sentry's "users affected" rollup is accurate. Email / username are NOT
 *     attached (PII minimisation per GDPR / SOC 2).
 *   - `Sentry.setTag("workspace_id", …)` — searchable tag so the on-call can
 *     filter "errors in workspace WS-7" with one click.
 *   - `Sentry.setTag("user_role", …)` — distinguishes admin / qa_lead /
 *     viewer impact (a viewer-only crash is lower priority than admin).
 *
 * Safe to call when Sentry has not been init'd — `setUser` / `setTag` are
 * documented no-ops in that case. Wrapped in `try/catch` as defence-in-depth
 * so any SDK throw never breaks the auth middleware chain.
 *
 * @param {Object} req - The Express request after workspaceScope has set req.workspaceId.
 */
function attachSentryContext(req) {
  if (!process.env.SENTRY_DSN) return;
  try {
    Sentry.setUser({ id: req.authUser?.sub || null });
    if (req.workspaceId) Sentry.setTag("workspace_id", req.workspaceId);
    if (req.userRole) Sentry.setTag("user_role", req.userRole);
  } catch { /* best-effort */ }
}

/**
 * Express middleware that injects workspace context onto the request.
 *
 * Sets:
 * - `req.workspaceId` — The active workspace ID.
 * - `req.userRole`    — The user's role in that workspace ('admin' | 'qa_lead' | 'viewer').
 */
export function workspaceScope(req, res, next) {
  // Skip for non-user auth strategies (e.g. trigger tokens)
  if (!req.authUser) return next();

  const { sub: userId, workspaceId: jwtWorkspaceId } = req.authUser;

  // If the JWT contains a workspaceId hint, verify membership and resolve
  // the current role from the DB (never trust the JWT for authorization).
  if (jwtWorkspaceId) {
    const membership = workspaceRepo.getMembership(jwtWorkspaceId, userId);
    if (membership) {
      req.workspaceId = jwtWorkspaceId;
      req.userRole = membership.role;
      attachSentryContext(req);
      return next();
    }
    // Membership was revoked since the JWT was issued — fall through to
    // check if the user has any other workspace.
  }

  // Resolve from all memberships (no JWT hint, or hint was stale).
  const workspaces = workspaceRepo.getByUserId(userId);
  if (!workspaces || workspaces.length === 0) {
    return res.status(403).json({
      error: "You are not a member of any workspace. Please contact your administrator.",
    });
  }

  // Use the first workspace. Future: allow workspace switching via header.
  const ws = workspaces[0];
  req.workspaceId = ws.id;
  req.userRole = ws.role;
  attachSentryContext(req);
  next();
}

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
  const headerWorkspaceId = typeof req.headers["x-workspace-id"] === "string"
    ? req.headers["x-workspace-id"].trim()
    : "";
  const requestedWorkspaceId = headerWorkspaceId || jwtWorkspaceId;

  // If the JWT contains a workspaceId hint, verify membership and resolve
  // the current role from the DB (never trust the JWT for authorization).
  if (requestedWorkspaceId) {
    const membership = workspaceRepo.getMembership(requestedWorkspaceId, userId);
    if (membership) {
      req.workspaceId = requestedWorkspaceId;
      req.userRole = membership.role;
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
  next();
}

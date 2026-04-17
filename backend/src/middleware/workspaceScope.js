/**
 * @module middleware/workspaceScope
 * @description Middleware that resolves the authenticated user's workspace
 * and role, injecting `req.workspaceId` and `req.userRole` on every request.
 *
 * Must run AFTER `requireAuth` (which sets `req.authUser`).
 *
 * ### Resolution strategy
 * 1. If the JWT payload contains `workspaceId` and `workspaceRole`, use those
 *    (fast path — no DB query on every request).
 * 2. Otherwise, look up the user's first workspace membership in the DB
 *    (fallback for tokens issued before ACL-001).
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

  const { sub: userId, workspaceId, workspaceRole } = req.authUser;

  // Fast path: workspace info is in the JWT
  if (workspaceId && workspaceRole) {
    req.workspaceId = workspaceId;
    req.userRole = workspaceRole;
    return next();
  }

  // Fallback: look up membership in DB (tokens issued before ACL-001)
  const workspaces = workspaceRepo.getByUserId(userId);
  if (!workspaces || workspaces.length === 0) {
    return res.status(403).json({
      error: "You are not a member of any workspace. Please contact your administrator.",
    });
  }

  // Use the first workspace (default). Future: allow workspace switching.
  const ws = workspaces[0];
  req.workspaceId = ws.id;
  req.userRole = ws.role;
  next();
}

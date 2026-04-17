/**
 * @module utils/authWorkspace
 * @description Shared workspace-aware auth payload/response builders (ACL-001).
 */

import crypto from "crypto";
import * as workspaceRepo from "../database/repositories/workspaceRepo.js";

/**
 * Build a JWT payload with a workspace hint.
 *
 * The JWT carries `workspaceId` as a routing hint only. Authorization is always
 * resolved from `workspace_members` at request time.
 *
 * @param {Object} user - User row from the database.
 * @param {string} [workspaceIdHint] - Preferred current workspace ID.
 * @returns {{ sub: string, email: string, name: string, role: string, jti: string, workspaceId?: string }}
 */
export function buildJwtPayload(user, workspaceIdHint) {
  const jti = crypto.randomUUID();
  const payload = { sub: user.id, email: user.email, name: user.name, role: user.role, jti };

  const workspaces = workspaceRepo.getByUserId(user.id);
  if (workspaces && workspaces.length > 0) {
    const currentWorkspace = workspaces.find((ws) => ws.id === workspaceIdHint) || workspaces[0];
    payload.workspaceId = currentWorkspace.id;
  }

  return payload;
}

/**
 * Build the user response object with workspace context for the frontend.
 *
 * @param {Object} user - User row from the database.
 * @param {string} [workspaceIdHint] - Preferred current workspace ID.
 * @returns {Object}
 */
export function buildUserResponse(user, workspaceIdHint) {
  const resp = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar || null,
  };

  const workspaces = workspaceRepo.getByUserId(user.id);
  if (workspaces && workspaces.length > 0) {
    const currentWorkspace = workspaces.find((ws) => ws.id === workspaceIdHint) || workspaces[0];
    resp.workspaceId = currentWorkspace.id;
    resp.workspaceName = currentWorkspace.name;
    resp.workspaceRole = currentWorkspace.role;
  }

  if (workspaces && workspaces.length > 1) {
    resp.workspaces = workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      role: ws.role,
      isOwner: ws.ownerId === user.id,
    }));
  }

  return resp;
}

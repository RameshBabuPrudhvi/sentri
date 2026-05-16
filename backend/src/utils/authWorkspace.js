/**
 * @module utils/authWorkspace
 * @description Shared workspace-aware auth payload/response builders (ACL-001).
 */

import crypto from "crypto";
import * as workspaceRepo from "../database/repositories/workspaceRepo.js";

/**
 * Resolve the current workspace from a user's memberships.
 * Returns the workspace matching `hint`, or the first workspace as fallback.
 *
 * @param {Object[]} workspaces - Result of `workspaceRepo.getByUserId()`.
 * @param {string}   [hint]     - Preferred workspace ID.
 * @returns {Object|undefined}    The resolved workspace, or undefined if empty.
 */
function resolveCurrentWorkspace(workspaces, hint) {
  if (!workspaces || workspaces.length === 0) return undefined;
  return workspaces.find((ws) => ws.id === hint) || workspaces[0];
}

/**
 * @typedef {Object} JwtPayload
 * @property {string}            sub
 * @property {string}            email
 * @property {string}            name
 * @property {string}            role
 * @property {string}            jti
 * @property {string}            [workspaceId] - Present when the user has workspaces.
 * @property {string[]}          [amr] - Authentication Methods References (RFC 8176).
 *   Values used by Sentri: `"pwd"` (password), `"mfa"` (TOTP / recovery code),
 *   `"oauth"` (GitHub / Google). Multi-factor sessions carry both `"pwd"` and
 *   `"mfa"`. Future high-assurance routes can require `amr.includes("mfa")`.
 */

/**
 * Build a JWT payload with a workspace hint.
 *
 * The JWT carries `workspaceId` as a routing hint only. Authorization is always
 * resolved from `workspace_members` at request time.
 *
 * @param {Object} user - User row from the database.
 * @param {string} [workspaceIdHint] - Preferred current workspace ID.
 * @param {Object} [opts] - Optional payload extras.
 * @param {string[]} [opts.amr] - Authentication Methods References (SEC-004).
 *   Distinguishes password-only (`["pwd"]`), MFA-asserted (`["pwd","mfa"]`),
 *   and OAuth (`["oauth"]`) sessions. Omitted when empty.
 * @returns {JwtPayload}
 */
export function buildJwtPayload(user, workspaceIdHint, opts = {}) {
  const jti = crypto.randomUUID();
  const payload = { sub: user.id, email: user.email, name: user.name, role: user.role, jti };

  const workspaces = workspaceRepo.getByUserId(user.id);
  const current = resolveCurrentWorkspace(workspaces, workspaceIdHint);
  if (current) {
    payload.workspaceId = current.id;
  }

  if (Array.isArray(opts.amr) && opts.amr.length > 0) {
    payload.amr = opts.amr;
  }

  return payload;
}

/**
 * @typedef {Object} UserResponse
 * @property {string}      id
 * @property {string}      name
 * @property {string}      email
 * @property {string}      role
 * @property {string|null} avatar
 * @property {string}      [workspaceId]    - Active workspace ID (present when user has workspaces).
 * @property {string}      [workspaceName]  - Active workspace display name.
 * @property {string}      [workspaceRole]  - User's role in the active workspace.
 * @property {Array<{id: string, name: string, role: string, isOwner: boolean}>} [workspaces] - All workspaces (present when user belongs to 2+).
 */

/**
 * Build the user response object with workspace context for the frontend.
 *
 * @param {Object} user - User row from the database.
 * @param {string} [workspaceIdHint] - Preferred current workspace ID.
 * @returns {UserResponse}
 */
export function buildUserResponse(user, workspaceIdHint) {
  const resp = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar || null,
    hasPassword: !!user.passwordHash,
  };

  const workspaces = workspaceRepo.getByUserId(user.id);
  const current = resolveCurrentWorkspace(workspaces, workspaceIdHint);
  if (current) {
    resp.workspaceId = current.id;
    resp.workspaceName = current.name;
    resp.workspaceRole = current.role;
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

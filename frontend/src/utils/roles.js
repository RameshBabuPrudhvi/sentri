/**
 * @module utils/roles
 * @description Workspace role hierarchy for client-side UI gating (ACL-002).
 *
 * **Important:** The frontend role check is for UX only (hiding buttons,
 * showing 403 pages).  The backend enforces authorization via
 * `backend/src/middleware/requireRole.js` — the source of truth.
 *
 * If you add or reorder roles, update BOTH this file and the backend
 * `requireRole.js` ROLE_WEIGHT map.
 */

/** Role hierarchy weights — higher = more privileged. Must match backend/src/middleware/requireRole.js. */
const ROLE_WEIGHT = Object.freeze({ admin: 30, qa_lead: 20, viewer: 10 });

/**
 * Check if a workspace role meets a minimum required role.
 * @param {string|null} userRole — The user's current workspace role.
 * @param {string} requiredRole — The minimum role needed.
 * @returns {boolean}
 */
export function hasMinimumRole(userRole, requiredRole) {
  if (!requiredRole) return true;
  const userW = ROLE_WEIGHT[userRole] || 0;
  const reqW = ROLE_WEIGHT[requiredRole] || 0;
  return userW >= reqW;
}

/**
 * Check if a user object has the minimum required workspace role.
 * Convenience wrapper for use with the `useAuth()` user object.
 *
 * @param {Object|null} user — The user object from useAuth().
 * @param {string} role — Minimum role required.
 * @returns {boolean}
 */
export function userHasRole(user, role) {
  if (!user) return false;
  return hasMinimumRole(user.workspaceRole, role);
}

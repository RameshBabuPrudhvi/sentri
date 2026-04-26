/**
 * @module middleware/requireRole
 * @description Role-based access control middleware (ACL-002).
 *
 * Creates Express middleware that checks `req.userRole` (injected by the
 * workspace-aware auth flow in `authenticate.js`) against a minimum role
 * level.
 *
 * ### Role hierarchy
 * ```
 * admin > qa_lead > viewer
 * ```
 *
 * `requireRole('qa_lead')` allows `admin` and `qa_lead` but blocks `viewer`.
 * `requireRole('admin')` allows only `admin`.
 *
 * ### Usage
 * ```js
 * import { requireRole } from "../middleware/requireRole.js";
 *
 * router.delete("/:id", requireRole("admin"), (req, res) => { … });
 * router.post("/",      requireRole("qa_lead"), (req, res) => { … });
 * ```
 *
 * ### Keeping `permissions.json` in sync
 * Every `requireRole(...)` call site is mirrored in `./permissions.json`,
 * which is the canonical machine-readable RBAC matrix consumed by agents
 * and reviewers (see QA.md, AGENT.md, REVIEW.md). Whenever you add, remove,
 * or change a role gate, update the corresponding entry in `permissions.json`.
 * Audit drift with: `grep -rn 'requireRole(' backend/src/routes/`.
 *
 * @param {string} minimumRole — The minimum role required ('admin' | 'qa_lead' | 'viewer').
 * @returns {Function} Express middleware `(req, res, next)`.
 */

/** Numeric weight per role — higher = more privileged. */
const ROLE_WEIGHT = {
  admin:   30,
  qa_lead: 20,
  viewer:  10,
};

/** Valid role names for input validation. */
export const VALID_ROLES = new Set(Object.keys(ROLE_WEIGHT));

/**
 * Create an Express middleware that enforces a minimum role.
 *
 * Expects `req.userRole` to be set by the auth middleware.  If missing,
 * returns 401.  If the role is below the minimum, returns 403.
 *
 * @param {string} minimumRole — 'admin' | 'qa_lead' | 'viewer'
 * @returns {Function} Express middleware
 */
export function requireRole(minimumRole) {
  const minWeight = ROLE_WEIGHT[minimumRole];
  if (minWeight === undefined) {
    throw new Error(`[requireRole] Unknown role: "${minimumRole}". Valid roles: ${[...VALID_ROLES].join(", ")}`);
  }

  return (req, res, next) => {
    const userRole = req.userRole;
    if (!userRole) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const userWeight = ROLE_WEIGHT[userRole];
    if (userWeight === undefined || userWeight < minWeight) {
      return res.status(403).json({
        error: `This action requires ${minimumRole} permissions.`,
        requiredRole: minimumRole,
        currentRole: userRole || "unknown",
      });
    }

    next();
  };
}

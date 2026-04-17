/**
 * @module utils/actor
 * @description Extracts userId and userName from req.authUser (set by requireAuth
 * middleware) so every logActivity() call automatically records who performed the
 * action.  Returns an object that can be spread into logActivity({ ...actor(req), ... }).
 */

/**
 * @param {Object} req - Express request with `authUser` set by requireAuth
 *                        and `workspaceId` set by workspaceScope.
 * @returns {{ userId: string, userName: string, workspaceId: string } | {}}
 */
export function actor(req) {
  const u = req?.authUser;
  if (!u) return {};
  return {
    userId: u.sub,
    userName: u.name || u.email || u.sub,
    workspaceId: req.workspaceId || null,
  };
}

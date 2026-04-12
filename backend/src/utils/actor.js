/**
 * @module utils/actor
 * @description Extracts userId and userName from req.authUser (set by requireAuth
 * middleware) so every logActivity() call automatically records who performed the
 * action.  Returns an object that can be spread into logActivity({ ...actor(req), ... }).
 */

/**
 * @param {import("express").Request} req
 * @returns {{ userId: string, userName: string } | {}}
 */
export function actor(req) {
  const u = req?.authUser;
  if (!u) return {};
  return { userId: u.sub, userName: u.name || u.email || u.sub };
}

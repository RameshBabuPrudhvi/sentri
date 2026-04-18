/**
 * @module routes/workspaces
 * @description Workspace and member management routes (ACL-001, ACL-002).
 *
 * ### Endpoints
 * | Method | Path                                    | Description                   | Min Role |
 * |--------|-----------------------------------------|-------------------------------|----------|
 * | GET    | `/api/workspaces/current`               | Get current workspace info    | viewer   |
 * | PATCH  | `/api/workspaces/current`               | Update workspace name/slug    | admin    |
 * | GET    | `/api/workspaces/current/members`       | List workspace members        | viewer   |
 * | POST   | `/api/workspaces/current/members`       | Invite a member               | admin    |
 * | PATCH  | `/api/workspaces/current/members/:userId` | Update member role          | admin    |
 * | DELETE | `/api/workspaces/current/members/:userId` | Remove a member             | admin    |
 */

import { Router } from "express";
import * as workspaceRepo from "../database/repositories/workspaceRepo.js";
import * as userRepo from "../database/repositories/userRepo.js";
import { requireRole, VALID_ROLES } from "../middleware/requireRole.js";
import { signJwt, getJwtSecret, revokedTokens, AUTH_COOKIE } from "../middleware/authenticate.js";
import { cookieSameSite } from "../middleware/appSetup.js";
import { buildJwtPayload, buildUserResponse } from "../utils/authWorkspace.js";

const EXP_COOKIE  = "token_exp";
const JWT_TTL_SEC = 8 * 60 * 60;

const router = Router();

// ─── Current workspace info ───────────────────────────────────────────────────

/**
 * Get the current workspace details.
 * @route GET /api/workspaces/current
 */
router.get("/current", (req, res) => {
  const ws = workspaceRepo.getById(req.workspaceId);
  if (!ws) return res.status(404).json({ error: "Workspace not found." });
  return res.json(ws);
});

/**
 * Update the current workspace (name, slug).
 * @route PATCH /api/workspaces/current
 */
router.patch("/current", requireRole("admin"), (req, res) => {
  const { name, slug } = req.body;
  const updates = {};
  if (name && typeof name === "string") updates.name = name.trim().slice(0, 100);
  if (slug && typeof slug === "string") {
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
    if (!cleanSlug) return res.status(400).json({ error: "Invalid slug." });
    // Check uniqueness
    const existing = workspaceRepo.getBySlug(cleanSlug);
    if (existing && existing.id !== req.workspaceId) {
      return res.status(409).json({ error: "This slug is already taken." });
    }
    updates.slug = cleanSlug;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update." });
  }
  workspaceRepo.update(req.workspaceId, updates);
  const ws = workspaceRepo.getById(req.workspaceId);
  return res.json(ws);
});

// ─── Workspace listing & switching ────────────────────────────────────────────

/**
 * List all workspaces the current user belongs to.
 * @route GET /api/workspaces
 */
router.get("/", (req, res) => {
  const userId = req.authUser.sub;
  const workspaces = workspaceRepo.getByUserId(userId);
  return res.json(workspaces.map(ws => ({
    id: ws.id, name: ws.name, slug: ws.slug, role: ws.role,
    isOwner: ws.ownerId === userId, createdAt: ws.createdAt,
  })));
});

/**
 * Switch the active workspace. Issues a new JWT with the target workspaceId
 * hint and returns updated user info. The user must be a member of the
 * target workspace.
 *
 * @route POST /api/workspaces/switch
 * @param {Object} req.body
 * @param {string} req.body.workspaceId — The workspace to switch to.
 */
 router.post("/switch", (req, res) => {
  const { workspaceId: targetId } = req.body;
  if (!targetId || typeof targetId !== "string") {
    return res.status(400).json({ error: "workspaceId is required." });
  }

  const userId = req.authUser.sub;
  const membership = workspaceRepo.getMembership(targetId, userId);
  if (!membership) {
    return res.status(403).json({ error: "You are not a member of that workspace." });
  }

  const user = userRepo.getById(userId);
  if (!user) return res.status(401).json({ error: "User not found." });

  // Revoke the old token so it cannot be replayed (matches /refresh behaviour)
  const { jti: oldJti, exp: oldExp } = req.authUser;
  if (oldJti) revokedTokens.set(oldJti, oldExp);

  // Issue a new JWT with the target workspace as the hint
  const payload = buildJwtPayload(user, targetId);
  const token = signJwt(payload, getJwtSecret());
  const exp = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;

  // Set cookies
  const maxAge = JWT_TTL_SEC;
  const sameSite = cookieSameSite();
  res.appendHeader("Set-Cookie", `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Max-Age=${maxAge}${sameSite}`);
  res.appendHeader("Set-Cookie", `${EXP_COOKIE}=${exp}; Path=/; Max-Age=${maxAge}${sameSite}`);

  return res.json({ user: buildUserResponse(user, targetId) });
});

// ─── Member management ────────────────────────────────────────────────────────

/**
 * List all members of the current workspace.
 * @route GET /api/workspaces/current/members
 */
router.get("/current/members", (req, res) => {
  const members = workspaceRepo.getMembers(req.workspaceId);
  return res.json(members);
});

/**
 * Invite a user to the current workspace by email.
 * @route POST /api/workspaces/current/members
 */
router.post("/current/members", requireRole("admin"), (req, res) => {
  const { email, role } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email is required." });
  }
  const memberRole = role || "viewer";
  if (!VALID_ROLES.has(memberRole)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${[...VALID_ROLES].join(", ")}` });
  }

  const user = userRepo.getByEmail(email.trim().toLowerCase());
  if (!user) {
    return res.status(404).json({ error: "No user found with that email. They must register first." });
  }

  // Check if already a member
  const existing = workspaceRepo.getMembership(req.workspaceId, user.id);
  if (existing) {
    return res.status(409).json({ error: "User is already a member of this workspace." });
  }

  const membership = workspaceRepo.addMember(req.workspaceId, user.id, memberRole);
  return res.status(201).json({
    ...membership,
    name: user.name,
    email: user.email,
    avatar: user.avatar || null,
  });
});

/**
 * Update a member's role.
 * @route PATCH /api/workspaces/current/members/:userId
 */
router.patch("/current/members/:userId", requireRole("admin"), (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  if (!role || !VALID_ROLES.has(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${[...VALID_ROLES].join(", ")}` });
  }

  // Prevent demoting the last admin
  if (role !== "admin") {
    const members = workspaceRepo.getMembers(req.workspaceId);
    const admins = members.filter(m => m.role === "admin");
    if (admins.length === 1 && admins[0].userId === userId) {
      return res.status(400).json({ error: "Cannot remove the last admin. Promote another member first." });
    }
  }

  const updated = workspaceRepo.updateMemberRole(req.workspaceId, userId, role);
  if (!updated) {
    return res.status(404).json({ error: "Member not found in this workspace." });
  }
  return res.json({ userId, role, updated: true });
});

/**
 * Remove a member from the workspace.
 * @route DELETE /api/workspaces/current/members/:userId
 */
router.delete("/current/members/:userId", requireRole("admin"), (req, res) => {
  const { userId } = req.params;

  // Prevent removing yourself if you're the last admin
  const members = workspaceRepo.getMembers(req.workspaceId);
  const admins = members.filter(m => m.role === "admin");
  if (admins.length === 1 && admins[0].userId === userId) {
    return res.status(400).json({ error: "Cannot remove the last admin. Transfer ownership first." });
  }

  const removed = workspaceRepo.removeMember(req.workspaceId, userId);
  if (!removed) {
    return res.status(404).json({ error: "Member not found in this workspace." });
  }
  return res.json({ userId, removed: true });
});

export default router;

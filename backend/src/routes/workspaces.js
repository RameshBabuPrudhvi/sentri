/**
 * @module routes/workspaces
 * @description Workspace and member management routes (ACL-001, ACL-002).
 *
 * ### Endpoints
 * | Method | Path                                    | Description                   | Min Role |
 * |--------|-----------------------------------------|-------------------------------|----------|
 * | GET    | `/api/workspaces`                       | List user's workspaces        | viewer   |
 * | POST   | `/api/workspaces/switch`                | Switch active workspace       | viewer   |
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
import * as webauthnRepo from "../database/repositories/webauthnRepo.js";
import { requireRole, VALID_ROLES } from "../middleware/requireRole.js";
import { signJwt, getJwtSecret, revokedTokens } from "../middleware/authenticate.js";
import { buildJwtPayload, buildUserResponse } from "../utils/authWorkspace.js";
import { logActivity } from "../utils/activityLogger.js";
import { evaluateMfaEnforcement } from "../utils/mfaEnforcement.js";
import { setAuthCookie, JWT_TTL_SEC } from "./auth.js";

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
 * Update the current workspace (name, slug, MFA enforcement policy).
 *
 * SEC-004: `mfaRequired` / `mfaGracePeriodDays` are admin-managed enforcement
 * controls. Flipping `mfaRequired` from 0 → 1 stamps `mfaPolicyUpdatedAt`
 * with the current time so the grace clock starts at the policy change —
 * existing members get the full grace window before being locked out.
 *
 * @route PATCH /api/workspaces/current
 */
router.patch("/current", requireRole("admin"), (req, res) => {
  const { name, slug, mfaRequired, mfaGracePeriodDays } = req.body;
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

  // SEC-004: MFA enforcement policy. Accept booleans or 0/1 for `mfaRequired`
  // for ergonomic frontend payloads; coerce to the integer column shape.
  let mfaPolicyChanged = false;
  if (mfaRequired !== undefined) {
    const next = (mfaRequired === true || mfaRequired === 1 || mfaRequired === "1") ? 1 : 0;
    const current = workspaceRepo.getById(req.workspaceId);
    if (!current) return res.status(404).json({ error: "Workspace not found." });
    if (next !== (current.mfaRequired || 0)) {
      updates.mfaRequired = next;
      // Stamp policy-changed timestamp so the grace clock starts here.
      updates.mfaPolicyUpdatedAt = new Date().toISOString();
      mfaPolicyChanged = true;
    }
  }
  if (mfaGracePeriodDays !== undefined) {
    const n = Number.parseInt(mfaGracePeriodDays, 10);
    if (!Number.isFinite(n) || n < 0 || n > 90) {
      return res.status(400).json({ error: "mfaGracePeriodDays must be between 0 and 90." });
    }
    updates.mfaGracePeriodDays = n;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update." });
  }
  workspaceRepo.update(req.workspaceId, updates);
  const ws = workspaceRepo.getById(req.workspaceId);

  if (mfaPolicyChanged) {
    logActivity({
      type: "workspace.mfa_policy_changed",
      req,
      detail: `MFA enforcement ${ws.mfaRequired === 1 ? "enabled" : "disabled"} for workspace.`,
      userId: req.authUser.sub, userName: req.authUser.name || req.authUser.email,
      workspaceId: req.workspaceId,
      meta: { mfaRequired: ws.mfaRequired, mfaGracePeriodDays: ws.mfaGracePeriodDays },
    });
  }

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

  // SEC-004 §11: re-check MFA enforcement on every workspace switch.
  //
  // Strictest-wins semantics: `evaluateMfaEnforcement(user)` inspects EVERY
  // workspace the user belongs to (not just `targetId`) and returns the
  // strictest outcome. This intentionally prevents a user from escaping
  // enforcement by switching from a strict-MFA workspace into a no-MFA one
  // — once any of their workspaces requires MFA past grace, they must
  // enroll before any workspace switch succeeds. See the contract in
  // `backend/src/utils/mfaEnforcement.js`.
  //
  // Same pattern as the /refresh enforcement check in routes/auth.js.
  const enforcement = evaluateMfaEnforcement(user);
  if (enforcement.state === "block") {
    logActivity({
      type: "auth.mfa.enrollment_required",
      req,
      detail: "Workspace switch blocked: target workspace requires MFA.",
      userId: user.id, userName: user.name || user.email,
      workspaceId: enforcement.workspaceId,
      meta: { method: "workspace_switch" },
    });
    return res.status(403).json({
      error: "Your workspace requires multi-factor authentication. Enroll before switching.",
      code: "MFA_ENROLLMENT_REQUIRED",
      workspaceId: enforcement.workspaceId,
      workspaceName: enforcement.workspaceName,
    });
  }

  // Revoke the old token so it cannot be replayed (matches /refresh behaviour)
  const { jti: oldJti, exp: oldExp } = req.authUser;
  if (oldJti) revokedTokens.set(oldJti, oldExp);

  // Issue a new JWT with the target workspace as the hint.
  // SEC-004 §5c: forward the existing `amr` claim so a workspace switch by an
  // MFA-asserted user does not silently downgrade their session to password-
  // only. Same rationale as the `/refresh` forward at routes/auth.js — both
  // revoke + reissue paths must preserve the authentication strength.
  const payload = buildJwtPayload(user, targetId, { amr: req.authUser.amr });
  const token = signJwt(payload, getJwtSecret());
  const exp = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;

  setAuthCookie(res, token, exp);

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
 * Report MFA enrollment compliance for the current workspace (SEC-004).
 * Used by the admin Settings panel to show "N of M members not enrolled"
 * before flipping the enforcement policy.
 *
 * @route GET /api/workspaces/current/mfa-compliance
 * @returns {200} `{ totalMembers, enrolled, notEnrolled, members: [{userId,name,email,mfaEnabled}] }`
 */
router.get("/current/mfa-compliance", requireRole("admin"), (req, res) => {
  const members = workspaceRepo.getMembers(req.workspaceId);
  const detailed = members.map((m) => {
    const u = userRepo.getById(m.userId);
    // SEC-004: a registered passkey is just as strong a second factor as TOTP
    // (see `evaluateMfaEnforcement` at backend/src/utils/mfaEnforcement.js).
    // Count passkey-only users as enrolled so the admin preview matches what
    // the enforcement engine will actually allow — otherwise OAuth-only users
    // who registered a passkey but no TOTP are misreported as "not enrolled".
    const passkeyCount = webauthnRepo.countByUser(m.userId);
    const totp = u?.mfaEnabled === 1;
    const webauthn = passkeyCount > 0;
    return {
      userId: m.userId,
      name: m.name,
      email: m.email,
      role: m.role,
      mfaEnabled: totp || webauthn,
      totp,
      webauthn,
    };
  });
  const enrolled = detailed.filter((d) => d.mfaEnabled).length;
  return res.json({
    totalMembers: detailed.length,
    enrolled,
    notEnrolled: detailed.length - enrolled,
    members: detailed,
  });
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

  // Capture the previous role for the audit-log meta before mutating, so
  // a SOC-2 reviewer can answer "what changed?" without a separate query.
  const beforeMembers = workspaceRepo.getMembers(req.workspaceId);
  const previousRole = beforeMembers.find((m) => m.userId === userId)?.role || null;

  const updated = workspaceRepo.updateMemberRole(req.workspaceId, userId, role);
  if (!updated) {
    return res.status(404).json({ error: "Member not found in this workspace." });
  }

  // SEC-007: emit `auth.role.change` so the workspace audit log captures
  // every role mutation with actor + target + before/after + IP/UA.
  const target = userRepo.getById(userId);
  logActivity({
    type: "auth.role.change",
    req,
    userId,
    userName: target?.name || target?.email || null,
    workspaceId: req.workspaceId,
    meta: {
      from: previousRole,
      to: role,
      changedBy: req.authUser.sub,
      changedByName: req.authUser.name || req.authUser.email || null,
    },
  });

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

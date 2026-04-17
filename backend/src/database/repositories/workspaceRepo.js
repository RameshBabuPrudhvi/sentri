/**
 * @module database/repositories/workspaceRepo
 * @description Workspace CRUD backed by SQLite (ACL-001).
 *
 * Each workspace is an isolated tenant.  All entity tables (projects, tests,
 * runs, activities) carry a `workspaceId` foreign key so queries can be
 * scoped to the authenticated user's workspace.
 *
 * ### Default workspace
 * On first startup after migration 004, {@link ensureDefaultWorkspace} creates
 * a "Default" workspace for every existing user and backfills `workspaceId`
 * on all orphaned entity rows.  This makes the migration non-breaking for
 * existing single-user deployments.
 */

import crypto from "crypto";
import { getDatabase } from "../sqlite.js";
import { generateWorkspaceId, generateWorkspaceMemberId } from "../../utils/idGenerator.js";

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get a workspace by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) || undefined;
}

/**
 * Get a workspace by slug.
 * @param {string} slug
 * @returns {Object|undefined}
 */
export function getBySlug(slug) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM workspaces WHERE slug = ?").get(slug) || undefined;
}

/**
 * Get all workspaces for a user (via workspace_members).
 * @param {string} userId
 * @returns {Object[]}
 */
export function getByUserId(userId) {
  const db = getDatabase();
  return db.prepare(`
    SELECT w.*, wm.role
    FROM workspaces w
    INNER JOIN workspace_members wm ON wm.workspaceId = w.id
    WHERE wm.userId = ?
    ORDER BY w.createdAt ASC
  `).all(userId);
}

/**
 * Get a user's membership in a specific workspace.
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Object|undefined} — { id, workspaceId, userId, role, joinedAt }
 */
export function getMembership(workspaceId, userId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM workspace_members WHERE workspaceId = ? AND userId = ?"
  ).get(workspaceId, userId) || undefined;
}

/**
 * Get all members of a workspace.
 * @param {string} workspaceId
 * @returns {Object[]}
 */
export function getMembers(workspaceId) {
  const db = getDatabase();
  return db.prepare(`
    SELECT wm.id, wm.workspaceId, wm.userId, wm.role, wm.joinedAt,
           u.name, u.email, u.avatar
    FROM workspace_members wm
    INNER JOIN users u ON u.id = wm.userId
    WHERE wm.workspaceId = ?
    ORDER BY wm.joinedAt ASC
  `).all(workspaceId);
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Create a workspace and add the creator as admin.
 * @param {Object} opts
 * @param {string} opts.name     — Display name.
 * @param {string} opts.slug     — URL-friendly identifier.
 * @param {string} opts.ownerId  — User ID of the creator.
 * @returns {Object} The created workspace.
 */
export function create({ name, slug, ownerId }) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = generateWorkspaceId();

  db.prepare(`
    INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt)
    VALUES (@id, @name, @slug, @ownerId, @createdAt, @updatedAt)
  `).run({ id, name, slug, ownerId, createdAt: now, updatedAt: now });

  // Add creator as admin member
  addMember(id, ownerId, "admin");

  return { id, name, slug, ownerId, createdAt: now, updatedAt: now };
}

/**
 * Update workspace fields.
 * @param {string} id
 * @param {Object} fields — { name?, slug? }
 */
export function update(id, fields) {
  const db = getDatabase();
  const allowed = ["name", "slug"];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (sets.length === 0) return;
  sets.push("updatedAt = @updatedAt");
  params.updatedAt = new Date().toISOString();
  db.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Add a user to a workspace with a given role.
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} [role='viewer'] — 'admin' | 'qa_lead' | 'viewer'
 * @returns {Object} The membership row.
 */
export function addMember(workspaceId, userId, role = "viewer") {
  const db = getDatabase();
  const id = generateWorkspaceMemberId();
  const joinedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO workspace_members (id, workspaceId, userId, role, joinedAt)
    VALUES (@id, @workspaceId, @userId, @role, @joinedAt)
  `).run({ id, workspaceId, userId, role, joinedAt });
  return { id, workspaceId, userId, role, joinedAt };
}

/**
 * Update a member's role.
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} role — 'admin' | 'qa_lead' | 'viewer'
 * @returns {boolean} Whether the membership was found and updated.
 */
export function updateMemberRole(workspaceId, userId, role) {
  const db = getDatabase();
  const info = db.prepare(
    "UPDATE workspace_members SET role = ? WHERE workspaceId = ? AND userId = ?"
  ).run(role, workspaceId, userId);
  return info.changes > 0;
}

/**
 * Remove a member from a workspace.
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {boolean} Whether the membership was found and removed.
 */
export function removeMember(workspaceId, userId) {
  const db = getDatabase();
  const info = db.prepare(
    "DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?"
  ).run(workspaceId, userId);
  return info.changes > 0;
}

// ─── Default workspace backfill ───────────────────────────────────────────────

/**
 * Generate a URL-friendly slug from a name.
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    || "workspace";
}

/**
 * Ensure every existing user has at least one workspace.
 *
 * Called once on startup after migration 004.  For each user without a
 * workspace membership, creates a personal workspace.
 *
 * ### Orphaned entity backfill
 * Entities (projects, tests, runs) have no `userId` column, so there is no
 * reliable way to attribute them to individual users.  The backfill strategy
 * depends on how many orphan users exist:
 *
 * - **Single orphan user:** All orphaned entities are assigned to that user's
 *   workspace.  This is the common case (single-user deployment upgrading).
 * - **Multiple orphan users:** A shared "Default" workspace is created and
 *   all orphaned entities are assigned there.  All orphan users are added as
 *   members.  The first orphan user is the admin; the rest are viewers.
 *   This prevents the first-user-claims-everything bug and preserves data
 *   visibility for all existing users.
 *
 * Activities (which have `userId`) are always attributed to the correct
 * user's workspace when possible.
 *
 * This is idempotent — calling it multiple times is safe.
 */
export function ensureDefaultWorkspaces() {
  const db = getDatabase();

  // Find users who are not members of any workspace
  const orphanUsers = db.prepare(`
    SELECT u.id, u.name FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM workspace_members wm WHERE wm.userId = u.id
    )
  `).all();

  if (orphanUsers.length === 0) return;

  const txn = db.transaction(() => {
    if (orphanUsers.length === 1) {
      // ── Single user: straightforward assignment ─────────────────────
      const user = orphanUsers[0];
      const wsName = `${user.name || "My"}'s Workspace`;
      const slug = `${slugify(user.name || "user")}-${crypto.randomBytes(3).toString("hex")}`;
      const ws = create({ name: wsName, slug, ownerId: user.id });

      db.prepare("UPDATE projects SET workspaceId = ? WHERE workspaceId IS NULL").run(ws.id);
      db.prepare("UPDATE tests SET workspaceId = ? WHERE workspaceId IS NULL").run(ws.id);
      db.prepare("UPDATE runs SET workspaceId = ? WHERE workspaceId IS NULL").run(ws.id);
      db.prepare("UPDATE activities SET workspaceId = ? WHERE workspaceId IS NULL").run(ws.id);
    } else {
      // ── Multiple users: shared workspace for orphaned entities ──────
      const sharedSlug = `default-${crypto.randomBytes(3).toString("hex")}`;
      const sharedWs = create({ name: "Default Workspace", slug: sharedSlug, ownerId: orphanUsers[0].id });

      // Add all other orphan users to the shared workspace
      for (let i = 1; i < orphanUsers.length; i++) {
        addMember(sharedWs.id, orphanUsers[i].id, "viewer");
      }

      // Assign all un-owned entities to the shared workspace
      db.prepare("UPDATE projects SET workspaceId = ? WHERE workspaceId IS NULL").run(sharedWs.id);
      db.prepare("UPDATE tests SET workspaceId = ? WHERE workspaceId IS NULL").run(sharedWs.id);
      db.prepare("UPDATE runs SET workspaceId = ? WHERE workspaceId IS NULL").run(sharedWs.id);

      // Activities have userId — attribute to the correct user's workspace
      // where possible. Activities without a userId go to the shared workspace.
      db.prepare("UPDATE activities SET workspaceId = ? WHERE workspaceId IS NULL AND userId IS NULL").run(sharedWs.id);

      // For activities with a userId, they all go to the shared workspace
      // too (since all users are members), but we set it explicitly.
      db.prepare("UPDATE activities SET workspaceId = ? WHERE workspaceId IS NULL").run(sharedWs.id);

      // Also create personal workspaces for each user (empty — for future use)
      for (const user of orphanUsers) {
        // Skip the first user — they already own the shared workspace
        if (user.id === orphanUsers[0].id) continue;
        const slug = `${slugify(user.name || "user")}-${crypto.randomBytes(3).toString("hex")}`;
        create({ name: `${user.name || "My"}'s Workspace`, slug, ownerId: user.id });
      }
    }
  });
  txn();
}

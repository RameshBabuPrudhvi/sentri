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
 * workspace membership, creates a personal "My Workspace" workspace and
 * assigns all their orphaned entities (projects with NULL workspaceId) to it.
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
    for (const user of orphanUsers) {
      const wsName = `${user.name}'s Workspace`;
      const baseSlug = slugify(user.name);
      // Ensure slug uniqueness by appending a short random suffix
      const slug = `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;

      const ws = create({ name: wsName, slug, ownerId: user.id });

      // Backfill all orphaned entities to this workspace
      db.prepare("UPDATE projects SET workspaceId = ? WHERE workspaceId IS NULL").run(ws.id);
      db.prepare("UPDATE tests SET workspaceId = ? WHERE workspaceId IS NULL").run(ws.id);
      db.prepare("UPDATE runs SET workspaceId = ? WHERE workspaceId IS NULL").run(ws.id);
      db.prepare("UPDATE activities SET workspaceId = ? WHERE workspaceId IS NULL").run(ws.id);
    }
  });
  txn();
}

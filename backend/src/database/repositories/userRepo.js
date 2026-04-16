/**
 * @module database/repositories/userRepo
 * @description User CRUD backed by SQLite.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Get a user by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) || undefined;
}

/**
 * Find a user by email (case-sensitive — callers should lowercase before storing).
 * @param {string} email
 * @returns {Object|undefined}
 */
export function getByEmail(email) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) || undefined;
}

/**
 * Get all users.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM users").all();
}

/**
 * Create a user.
 * @param {Object} user — { id, name, email, passwordHash, role, avatar, createdAt, updatedAt }
 */
export function create(user) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO users (id, name, email, passwordHash, role, avatar, createdAt, updatedAt)
    VALUES (@id, @name, @email, @passwordHash, @role, @avatar, @createdAt, @updatedAt)
  `).run({
    id: user.id,
    name: user.name,
    email: user.email,
    passwordHash: user.passwordHash || null,
    role: user.role || "user",
    avatar: user.avatar || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
}

/**
 * Update specific fields on a user.
 * @param {string} id
 * @param {Object} fields — Partial user fields to update.
 */
export function update(id, fields) {
  const db = getDatabase();
  const allowed = ["name", "email", "passwordHash", "role", "avatar", "emailVerified", "updatedAt"];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

// ─── OAuth ID helpers ─────────────────────────────────────────────────────────

/**
 * Get the userId linked to an OAuth key (e.g. "github:12345").
 * @param {string} key
 * @returns {string|undefined}
 */
export function getOAuthUserId(key) {
  const db = getDatabase();
  const row = db.prepare("SELECT userId FROM oauth_ids WHERE key = ?").get(key);
  return row?.userId;
}

/**
 * Link an OAuth key to a userId.
 * @param {string} key
 * @param {string} userId
 */
export function setOAuthLink(key, userId) {
  const db = getDatabase();
  db.prepare("INSERT OR REPLACE INTO oauth_ids (key, userId) VALUES (?, ?)").run(key, userId);
}

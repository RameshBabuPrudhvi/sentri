/**
 * @module database/repositories/passwordResetTokenRepo
 * @description Password reset token CRUD backed by SQLite (migration 003).
 *
 * Encapsulates all `password_reset_tokens` queries so route handlers never
 * write raw SQL — per AGENT.md: "Do not write raw SQL in route handlers."
 */

import { getDatabase } from "../sqlite.js";

/**
 * Create a new password reset token, invalidating any existing unused tokens
 * for the same user first (only the latest token should be valid).
 *
 * @param {string} token     - Cryptographically random base64url string.
 * @param {string} userId    - The user requesting the reset.
 * @param {string} expiresAt - ISO 8601 expiry timestamp.
 */
export function create(token, userId, expiresAt) {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    "DELETE FROM password_reset_tokens WHERE userId = ? AND usedAt IS NULL"
  ).run(userId);
  db.prepare(
    "INSERT INTO password_reset_tokens (token, userId, expiresAt, usedAt, createdAt)"
    + " VALUES (?, ?, ?, NULL, ?)"
  ).run(token, userId, expiresAt, now);
}

/**
 * Atomically claim a token — marks it as used only if it is still unused and
 * not expired.  Returns the token row on success, or `null` if the token was
 * missing, already used, or expired (i.e. another concurrent request won the race).
 *
 * This eliminates the TOCTOU race between SELECT and UPDATE by performing a
 * single atomic UPDATE and checking `changes > 0`.
 *
 * @param {string} token - The reset token to claim.
 * @returns {Object|null}  The token row (with `usedAt` now set), or `null`.
 */
export function claim(token) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE password_reset_tokens SET usedAt = ? WHERE token = ? AND usedAt IS NULL AND expiresAt >= ?"
  ).run(now, token, now);
  if (result.changes === 0) return null;
  return db.prepare(
    "SELECT * FROM password_reset_tokens WHERE token = ?"
  ).get(token);
}

/**
 * Delete all unused tokens for a user (called after a successful reset to
 * invalidate any other outstanding reset links).
 *
 * @param {string} userId
 * @returns {number} Number of deleted rows.
 */
export function deleteUnusedByUserId(userId) {
  const db = getDatabase();
  const info = db.prepare(
    "DELETE FROM password_reset_tokens WHERE userId = ? AND usedAt IS NULL"
  ).run(userId);
  return info.changes;
}

/**
 * Delete all expired tokens (both used and unused) — called by the periodic
 * cleanup job so the table stays small.
 *
 * @returns {number} Number of deleted rows.
 */
export function deleteExpired() {
  const db = getDatabase();
  const info = db.prepare(
    "DELETE FROM password_reset_tokens WHERE expiresAt < ?"
  ).run(new Date().toISOString());
  return info.changes;
}

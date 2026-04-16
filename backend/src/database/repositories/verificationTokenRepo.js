/**
 * @module database/repositories/verificationTokenRepo
 * @description Email verification token CRUD backed by SQLite (migration 003).
 *
 * Encapsulates all `verification_tokens` queries so route handlers never
 * write raw SQL — per AGENT.md: "Do not write raw SQL in route handlers."
 */

import { getDatabase } from "../sqlite.js";

/**
 * Create a new verification token, invalidating any existing unused tokens
 * for the same user first (only the latest token should be valid).
 *
 * @param {string} token     - Cryptographically random base64url string.
 * @param {string} userId    - The user requesting verification.
 * @param {string} email     - The email address to verify.
 * @param {string} expiresAt - ISO 8601 expiry timestamp.
 */
export function create(token, userId, email, expiresAt) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare(
      "DELETE FROM verification_tokens WHERE userId = ? AND usedAt IS NULL"
    ).run(userId);
    db.prepare(
      "INSERT INTO verification_tokens (token, userId, email, expiresAt, usedAt, createdAt)"
      + " VALUES (?, ?, ?, ?, NULL, ?)"
    ).run(token, userId, email, expiresAt, now);
  });
  txn();
}

/**
 * Atomically claim a token — marks it as used only if it is still unused and
 * not expired.  Returns the token row on success, or `null` if the token was
 * missing, already used, or expired.
 *
 * This eliminates the TOCTOU race between SELECT and UPDATE by performing a
 * single atomic UPDATE and checking `changes > 0`.
 *
 * @param {string} token - The verification token to claim.
 * @returns {Object|null}  The token row (with `usedAt` now set), or `null`.
 */
export function claim(token) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE verification_tokens SET usedAt = ? WHERE token = ? AND usedAt IS NULL AND expiresAt >= ?"
  ).run(now, token, now);
  if (result.changes === 0) return null;
  return db.prepare(
    "SELECT * FROM verification_tokens WHERE token = ?"
  ).get(token);
}

/**
 * Get the most recent unused verification token for a user.
 * Used to check if a resend is needed or if a token is still pending.
 *
 * @param {string} userId
 * @returns {Object|undefined}
 */
export function getUnusedByUserId(userId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM verification_tokens WHERE userId = ? AND usedAt IS NULL ORDER BY createdAt DESC LIMIT 1"
  ).get(userId) || undefined;
}

/**
 * Delete all unused tokens for a user (called after successful verification
 * to invalidate any other outstanding verification links).
 *
 * @param {string} userId
 * @returns {number} Number of deleted rows.
 */
export function deleteUnusedByUserId(userId) {
  const db = getDatabase();
  const info = db.prepare(
    "DELETE FROM verification_tokens WHERE userId = ? AND usedAt IS NULL"
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
    "DELETE FROM verification_tokens WHERE expiresAt < ?"
  ).run(new Date().toISOString());
  return info.changes;
}

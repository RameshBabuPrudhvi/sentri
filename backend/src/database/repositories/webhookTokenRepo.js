/**
 * @module database/repositories/webhookTokenRepo
 * @description Data-access layer for the `webhook_tokens` table (ENH-011).
 *
 * Stores per-project CI/CD trigger tokens.  The plaintext token is shown
 * exactly once at creation and never stored — only the SHA-256 hash is
 * persisted.  Authentication checks hash the incoming token and compare.
 *
 * ### Schema
 * ```
 * webhook_tokens(id TEXT PK, projectId TEXT, tokenHash TEXT UNIQUE,
 *                label TEXT, createdAt TEXT, lastUsedAt TEXT)
 * ```
 *
 * ### Exports
 * - {@link create}           — insert a new hashed token row
 * - {@link getByProjectId}   — list all tokens for a project (no hash)
 * - {@link findByHash}       — look up a token by its SHA-256 hash
 * - {@link touch}            — update `lastUsedAt` after a successful trigger
 * - {@link deleteById}       — remove a single token
 * - {@link deleteByProjectId} — remove all tokens for a project (project delete)
 */

import crypto from "crypto";
import { getDatabase } from "../sqlite.js";

// ─── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Hash a plaintext token with SHA-256.
 * @param {string} plaintext
 * @returns {string} 64-char hex digest
 */
export function hashToken(plaintext) {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Generate a cryptographically random URL-safe token string.
 * Returns 40 bytes of randomness encoded as hex (80 chars).
 * @returns {string}
 */
export function generateToken() {
  return crypto.randomBytes(40).toString("hex");
}

// ─── @typedef ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WebhookTokenRow
 * @property {string}      id          - Primary key (e.g. "WH-1")
 * @property {string}      projectId
 * @property {string}      label       - Human-readable label (optional)
 * @property {string}      createdAt   - ISO 8601
 * @property {string|null} lastUsedAt  - ISO 8601, null if never used
 */

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Insert a new webhook token row.
 * The caller is responsible for generating the ID (use idGenerator) and
 * hashing the plaintext (use {@link hashToken}).
 *
 * @param {Object} opts
 * @param {string} opts.id         - Primary key
 * @param {string} opts.projectId
 * @param {string} opts.tokenHash  - SHA-256 hex of the plaintext token
 * @param {string} [opts.label]    - Optional human label
 * @returns {void}
 */
export function create({ id, projectId, tokenHash, label }) {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO webhook_tokens (id, projectId, tokenHash, label, createdAt)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, projectId, tokenHash, label || null, new Date().toISOString());
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get all tokens for a project.
 * Returns public fields only — the `tokenHash` is intentionally omitted
 * so it cannot be accidentally logged or sent to the client.
 *
 * @param {string} projectId
 * @returns {WebhookTokenRow[]}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT id, projectId, label, createdAt, lastUsedAt FROM webhook_tokens WHERE projectId = ? ORDER BY createdAt DESC"
  ).all(projectId);
}

/**
 * Look up a token row by its SHA-256 hash.
 * Used to authenticate incoming trigger requests.
 * Returns the full row including `tokenHash` (needed to verify it still matches).
 *
 * @param {string} hash - 64-char hex SHA-256 digest
 * @returns {{ id: string, projectId: string, tokenHash: string, label: string|null, createdAt: string, lastUsedAt: string|null }|undefined}
 */
export function findByHash(hash) {
  const db = getDatabase();
  return db.prepare(
    "SELECT id, projectId, tokenHash, label, createdAt, lastUsedAt FROM webhook_tokens WHERE tokenHash = ?"
  ).get(hash);
}

// ─── Update ───────────────────────────────────────────────────────────────────

/**
 * Record a successful use of the token (updates `lastUsedAt`).
 * @param {string} id - Token primary key
 * @returns {void}
 */
export function touch(id) {
  const db = getDatabase();
  db.prepare(
    "UPDATE webhook_tokens SET lastUsedAt = ? WHERE id = ?"
  ).run(new Date().toISOString(), id);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Delete a single token by ID.
 * @param {string} id
 * @returns {boolean} `true` if a row was deleted.
 */
export function deleteById(id) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM webhook_tokens WHERE id = ?").run(id);
  return info.changes > 0;
}

/**
 * Delete all tokens for a project (cascade on project delete).
 * @param {string} projectId
 * @returns {number} Number of rows deleted.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM webhook_tokens WHERE projectId = ?").run(projectId);
  return info.changes;
}

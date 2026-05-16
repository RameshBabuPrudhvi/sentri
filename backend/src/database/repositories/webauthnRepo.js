/**
 * @module database/repositories/webauthnRepo
 * @description WebAuthn / passkey credential CRUD backed by SQLite
 * (migration 029, SEC-004).
 *
 * Encapsulates all `webauthn_credentials` queries so route handlers never
 * write raw SQL — per AGENT.md: "Do not write raw SQL in route handlers."
 *
 * ### Field shapes
 * - `id` — WebAuthn credential ID (base64url-encoded string, primary key).
 * - `publicKey` — COSE-encoded public key (base64 string).
 * - `counter` — signature counter, monotonically increasing per credential.
 * - `transports` — JSON-encoded array of WebAuthn transport hints,
 *   e.g. `["internal"]`, `["usb","nfc"]`. Stored as TEXT, hydrated to an
 *   array by readers below.
 * - `deviceName` — user-supplied label shown in the credentials list.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Parse the JSON `transports` column into an array of strings for callers.
 * Tolerant of legacy / malformed rows (returns `[]`).
 * @param {Object} row
 * @returns {Object}
 * @private
 */
function hydrate(row) {
  if (!row) return row;
  if (typeof row.transports === "string" && row.transports.length > 0) {
    try { row.transports = JSON.parse(row.transports); } catch { row.transports = []; }
  } else {
    row.transports = [];
  }
  return row;
}

/**
 * Create a new WebAuthn credential row.
 *
 * @param {Object} cred
 * @param {string}   cred.id
 * @param {string}   cred.userId
 * @param {string}   cred.publicKey
 * @param {number}   [cred.counter=0]
 * @param {string[]} [cred.transports=[]]
 * @param {string}   [cred.deviceName]
 * @returns {Object} The created credential row (with transports hydrated).
 */
export function create({ id, userId, publicKey, counter = 0, transports = [], deviceName }) {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO webauthn_credentials (id, userId, publicKey, counter, transports, deviceName, createdAt, lastUsedAt)
    VALUES (@id, @userId, @publicKey, @counter, @transports, @deviceName, @createdAt, NULL)
  `).run({
    id,
    userId,
    publicKey,
    counter,
    transports: JSON.stringify(Array.isArray(transports) ? transports : []),
    deviceName: deviceName || null,
    createdAt: now,
  });
  return hydrate(db.prepare("SELECT * FROM webauthn_credentials WHERE id = ?").get(id));
}

/**
 * Look up a credential by its WebAuthn ID.
 * @param {string} credentialId
 * @returns {Object|undefined}
 */
export function getById(credentialId) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM webauthn_credentials WHERE id = ?").get(credentialId);
  return row ? hydrate(row) : undefined;
}

/**
 * List all credentials registered to a user, oldest first so the UI can
 * render them in registration order.
 * @param {string} userId
 * @returns {Object[]}
 */
export function listByUser(userId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM webauthn_credentials WHERE userId = ? ORDER BY createdAt ASC"
  ).all(userId).map(hydrate);
}

/**
 * Update a credential's signature counter and last-used timestamp after a
 * successful authentication. The counter is part of the WebAuthn clone-
 * detection protocol — callers MUST verify `newCounter > oldCounter` before
 * calling this; otherwise the credential may have been cloned.
 *
 * @param {string} credentialId
 * @param {number} counter
 * @returns {boolean} `true` if a row was updated.
 */
export function updateCounter(credentialId, counter) {
  const db = getDatabase();
  const info = db.prepare(
    "UPDATE webauthn_credentials SET counter = ?, lastUsedAt = ? WHERE id = ?"
  ).run(counter, new Date().toISOString(), credentialId);
  return info.changes > 0;
}

/**
 * Delete a credential — scoped by `userId` so one user cannot remove
 * another user's credential even if they guess the ID.
 *
 * @param {string} credentialId
 * @param {string} userId
 * @returns {boolean} `true` if a row was deleted.
 */
export function deleteById(credentialId, userId) {
  const db = getDatabase();
  const info = db.prepare(
    "DELETE FROM webauthn_credentials WHERE id = ? AND userId = ?"
  ).run(credentialId, userId);
  return info.changes > 0;
}

/**
 * Count credentials for a user. Used by the Settings UI to display
 * "N passkeys registered" without round-tripping the full list.
 * @param {string} userId
 * @returns {number}
 */
export function countByUser(userId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT COUNT(*) AS cnt FROM webauthn_credentials WHERE userId = ?"
  ).get(userId)?.cnt || 0;
}

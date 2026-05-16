/**
 * @module database/repositories/workspaceSiemConfigRepo
 * @description SEC-007 Part C — per-workspace SIEM forwarder configuration.
 *
 * Stores the admin-configured webhook target (URL, HMAC secret, optional
 * custom headers) the audit-log forwarder uses to push every event to a
 * customer's SIEM. Schema defined by migration 032.
 *
 * ### Encryption-at-rest
 * The `hmacSecret` column is encrypted via `credentialEncryption.js`
 * (AES-256-GCM) before persist and decrypted lazily on read. The
 * encryption key is the same one used for AI provider keys and TOTP
 * secrets — derived from `JWT_SECRET` (or `CREDENTIAL_ENCRYPTION_KEY`
 * if explicitly set).
 *
 * ### Read API conventions
 * - `getDecrypted(workspaceId)` — full row with `hmacSecret` decrypted.
 *   ONLY for the forwarder to dispatch events. NEVER return this to a
 *   client.
 * - `getMasked(workspaceId)` — same shape but `hmacSecret` replaced with
 *   `"••••••••<last4>"`. Use for `GET /siem-config` admin responses.
 */

import { getDatabase } from "../sqlite.js";
import { encryptString, decryptString } from "../../utils/credentialEncryption.js";

/**
 * Mask an HMAC secret for client display — keeps the last 4 characters
 * visible so admins can confirm which secret is configured without
 * exposing the value.
 *
 * @param {string|null} secret
 * @returns {string|null}
 * @private
 */
function maskSecret(secret) {
  if (!secret) return null;
  if (secret.length <= 4) return "••••";
  return "••••••••" + secret.slice(-4);
}

/**
 * Upsert the SIEM config for a workspace. The HMAC secret is encrypted
 * before persist so even a DB-dump leak doesn't yield usable secrets.
 *
 * @param {string} workspaceId
 * @param {Object} cfg
 * @param {string} cfg.targetUrl - Validated by the route handler via SSRF guard.
 * @param {string} cfg.hmacSecret - Plaintext — encrypted here before INSERT.
 * @param {Object|null} [cfg.headers] - Optional headers object.
 * @param {boolean} [cfg.enabled=true]
 * @returns {Object} The persisted row (without the plaintext secret).
 */
export function upsert(workspaceId, { targetUrl, hmacSecret, headers = null, enabled = true }) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const headersJson = headers ? JSON.stringify(headers) : null;
  const encryptedSecret = encryptString(hmacSecret);

  // INSERT OR REPLACE is the cross-dialect way to upsert with this
  // module's translator (postgres-adapter rewrites to ON CONFLICT
  // DO UPDATE — see backend/src/database/adapters/postgres-adapter.js).
  // Preserves `createdAt` on update by reading the existing row first.
  const existing = db.prepare("SELECT createdAt FROM workspace_siem_config WHERE workspaceId = ?")
    .get(workspaceId);
  const createdAt = existing?.createdAt || now;

  db.prepare(`
    INSERT OR REPLACE INTO workspace_siem_config
      (workspaceId, targetUrl, hmacSecret, headersJson, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, targetUrl, encryptedSecret, headersJson, enabled ? 1 : 0, createdAt, now);

  return {
    workspaceId, targetUrl, headers, enabled, createdAt, updatedAt: now,
    hmacSecret: maskSecret(hmacSecret),
  };
}

/**
 * Return the masked config for client display (admin Settings panel).
 * `hmacSecret` is masked; the raw value is NEVER exposed.
 *
 * @param {string} workspaceId
 * @returns {Object|null}
 */
export function getMasked(workspaceId) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM workspace_siem_config WHERE workspaceId = ?").get(workspaceId);
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    targetUrl: row.targetUrl,
    hmacSecret: maskSecret(decryptString(row.hmacSecret)),
    headers: row.headersJson ? safeParseJson(row.headersJson) : null,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Return the decrypted config for the forwarder.
 *
 * SECURITY: the returned object contains the PLAINTEXT `hmacSecret`.
 * Callers MUST NOT log it, return it in HTTP responses, or persist it
 * back to disk. Only the in-process forwarder should ever call this.
 *
 * @param {string} workspaceId
 * @returns {Object|null}
 */
export function getDecrypted(workspaceId) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM workspace_siem_config WHERE workspaceId = ?").get(workspaceId);
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    targetUrl: row.targetUrl,
    hmacSecret: decryptString(row.hmacSecret),
    headers: row.headersJson ? safeParseJson(row.headersJson) : null,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Delete the SIEM config for a workspace. Returns true if a row was
 * removed, false when none existed (idempotent).
 *
 * @param {string} workspaceId
 * @returns {boolean}
 */
export function remove(workspaceId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM workspace_siem_config WHERE workspaceId = ?").run(workspaceId);
  return info.changes > 0;
}

/**
 * Tolerant JSON parser — corrupted `headersJson` shouldn't break the
 * forwarder or admin UI. Returns null on parse failure.
 *
 * @param {string} s
 * @returns {Object|null}
 * @private
 */
function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

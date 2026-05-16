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
 * ### `hmacSecret` semantics
 * - **Insert path** (no existing row): `hmacSecret` is required — the
 *   caller MUST pass a non-empty string. Callers should validate length
 *   upstream (PUT route enforces ≥ 32 chars per NIST SP 800-107).
 * - **Update path** (row exists): `hmacSecret` is OPTIONAL. Pass it to
 *   rotate the secret; omit (`undefined`) or pass the empty string to
 *   keep the existing encrypted secret unchanged. Admins editing just
 *   the `targetUrl` / `enabled` / `headers` should not be forced to
 *   re-enter the masked secret they can't see.
 *
 * @param {string} workspaceId
 * @param {Object} cfg
 * @param {string} cfg.targetUrl - Validated by the route handler via SSRF guard.
 * @param {string} [cfg.hmacSecret] - Plaintext. Required on insert, optional on update.
 * @param {Object|null} [cfg.headers] - Optional headers object.
 * @param {boolean} [cfg.enabled=true]
 * @returns {Object} The persisted row (without the plaintext secret).
 * @throws {Error} When inserting a new row and `hmacSecret` is missing/empty.
 */
export function upsert(workspaceId, { targetUrl, hmacSecret, headers = null, enabled = true }) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const headersJson = headers ? JSON.stringify(headers) : null;

  // INSERT OR REPLACE is the cross-dialect way to upsert with this
  // module's translator (postgres-adapter rewrites to ON CONFLICT
  // DO UPDATE — see backend/src/database/adapters/postgres-adapter.js).
  // Preserves `createdAt` AND the existing encrypted secret on update
  // (when the caller omits `hmacSecret`) by reading the existing row first.
  const existing = db.prepare(
    "SELECT createdAt, hmacSecret FROM workspace_siem_config WHERE workspaceId = ?"
  ).get(workspaceId);
  const createdAt = existing?.createdAt || now;

  // Decide which encrypted blob to write:
  //   1. Caller provided a non-empty hmacSecret → rotate (encrypt fresh).
  //   2. Caller omitted on update → reuse the existing encrypted column.
  //   3. Caller omitted on insert → reject (no secret to reuse).
  let encryptedSecret;
  if (typeof hmacSecret === "string" && hmacSecret.length > 0) {
    encryptedSecret = encryptString(hmacSecret);
  } else if (existing) {
    encryptedSecret = existing.hmacSecret;
  } else {
    throw new Error("hmacSecret is required when creating a new SIEM config");
  }

  db.prepare(`
    INSERT OR REPLACE INTO workspace_siem_config
      (workspaceId, targetUrl, hmacSecret, headersJson, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, targetUrl, encryptedSecret, headersJson, enabled ? 1 : 0, createdAt, now);

  // Return the masked form of whatever secret is now persisted — either the
  // newly rotated plaintext or the prior encrypted blob's decrypted preview.
  const maskedSource = (typeof hmacSecret === "string" && hmacSecret.length > 0)
    ? hmacSecret
    : decryptString(encryptedSecret);

  return {
    workspaceId, targetUrl, headers, enabled, createdAt, updatedAt: now,
    hmacSecret: maskSecret(maskedSource),
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

/**
 * @module utils/credentialEncryption
 * @description AES-256-GCM encryption for project credentials at rest.
 *
 * Credentials (login username, password, CSS selectors) are encrypted before
 * being persisted to the JSON database and decrypted when needed by the
 * crawl/test pipeline.
 *
 * The encryption key is derived from `CREDENTIAL_SECRET` env var (or the
 * JWT_SECRET as fallback). In development, a deterministic key is derived
 * from the project directory — acceptable for local use but NOT for production.
 *
 * ### Exports
 * - {@link encryptCredentials} — Encrypt a credentials object.
 * - {@link decryptCredentials} — Decrypt a credentials object.
 */

import crypto from "crypto";
import { formatLogLine } from "./logFormatter.js";

/**
 * Cached encryption key — derived once per process to avoid repeated
 * synchronous scryptSync calls on the event loop.
 * @type {Buffer|null}
 * @private
 */
let _cachedKey = null;

/**
 * Derive a 32-byte AES key from the configured secret.
 * Result is cached for the process lifetime.
 * @returns {Buffer}
 * @private
 */
function getEncryptionKey() {
  if (_cachedKey) return _cachedKey;

  const secret = process.env.CREDENTIAL_SECRET || process.env.JWT_SECRET;
  if (secret && secret.length >= 16) {
    _cachedKey = crypto.scryptSync(secret, "sentri-credentials-salt", 32);
    return _cachedKey;
  }
  // Dev fallback — deterministic but not secure for production
  const seed = `dev-credential-key:${process.cwd()}`;
  _cachedKey = crypto.createHash("sha256").update(seed).digest();
  return _cachedKey;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * @param   {string} plaintext
 * @returns {string} Format: `"<iv-hex>:<authTag-hex>:<ciphertext-hex>"`
 * @private
 */
function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a string encrypted by {@link encrypt}.
 * @param   {string} encryptedStr - Format: `"<iv-hex>:<authTag-hex>:<ciphertext-hex>"`
 * @returns {string} The original plaintext.
 * @private
 */
function decrypt(encryptedStr) {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertext] = encryptedStr.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Encrypt sensitive fields in a credentials object before storage.
 * Non-sensitive fields (CSS selectors) are stored as-is.
 *
 * @param   {Object|null} creds - `{ usernameSelector, username, passwordSelector, password, submitSelector }`
 * @returns {Object|null}         Encrypted credentials object, or `null`.
 */
export function encryptCredentials(creds) {
  if (!creds) return null;
  return {
    usernameSelector: creds.usernameSelector || "",
    username: creds.username ? encrypt(creds.username) : "",
    passwordSelector: creds.passwordSelector || "",
    password: creds.password ? encrypt(creds.password) : "",
    submitSelector: creds.submitSelector || "",
    _encrypted: true,
  };
}

/**
 * Encrypt an arbitrary string with a version-prefixed format so callers can
 * distinguish encrypted values from legacy plaintext on read.
 *
 * Returns `"enc:v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>"`. The `enc:v1:`
 * prefix is the format marker — {@link decryptString} returns the input
 * unchanged when the prefix is absent, so callers can transparently migrate
 * a column from plaintext to encrypted without a one-shot backfill (rows
 * re-encrypt naturally on next write).
 *
 * @param   {string|null|undefined} plaintext
 * @returns {string|null} Encrypted string, or `null` when input is empty.
 */
export function encryptString(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  return `enc:v1:${encrypt(String(plaintext))}`;
}

/**
 * Decrypt a string produced by {@link encryptString}. Legacy plaintext values
 * (no `enc:v1:` prefix) are returned unchanged so callers can transparently
 * migrate a column from plaintext to encrypted storage.
 *
 * @param   {string|null|undefined} value
 * @returns {string|null}
 */
export function decryptString(value) {
  if (value === null || value === undefined || value === "") return null;
  const str = String(value);
  if (!str.startsWith("enc:v1:")) return str; // legacy plaintext — return as-is
  try {
    return decrypt(str.slice("enc:v1:".length));
  } catch (err) {
    console.error(formatLogLine("error", null, `[credentialEncryption] decryptString failed: ${err.message}`));
    return null;
  }
}

/**
 * Decrypt sensitive fields in a credentials object for use by the pipeline.
 * If the credentials are not encrypted (legacy data), returns them as-is.
 *
 * @param   {Object|null} creds - Stored credentials (possibly encrypted).
 * @returns {Object|null}         Decrypted credentials object, or `null`.
 */
export function decryptCredentials(creds) {
  if (!creds) return null;
  if (!creds._encrypted) return creds; // legacy unencrypted data
  try {
    return {
      usernameSelector: creds.usernameSelector || "",
      username: creds.username ? decrypt(creds.username) : "",
      passwordSelector: creds.passwordSelector || "",
      password: creds.password ? decrypt(creds.password) : "",
      submitSelector: creds.submitSelector || "",
    };
  } catch (err) {
    console.error(formatLogLine("error", null, `[credentialEncryption] Decryption failed: ${err.message}`));
    return null;
  }
}

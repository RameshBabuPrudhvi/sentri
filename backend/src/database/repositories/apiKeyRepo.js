/**
 * @module database/repositories/apiKeyRepo
 * @description Encrypted AI provider key persistence backed by SQLite (migration 005).
 *
 * Stores API keys and Ollama config in the `api_keys` table so they survive
 * server restarts. Cloud provider keys are encrypted at rest using the same
 * AES-256-GCM utility used for project credentials. The plaintext key is
 * never persisted — only the encrypted blob.
 *
 * ### Exports
 * - {@link set}    — Upsert an encrypted key or Ollama config for a provider.
 * - {@link get}    — Retrieve and decrypt a stored key (or Ollama config).
 * - {@link remove} — Delete the stored key for a provider.
 * - {@link getAll} — Return all stored providers with decrypted values.
 */

import { getDatabase } from "../sqlite.js";
import { encryptCredentials, decryptCredentials } from "../../utils/credentialEncryption.js";
import { formatLogLine } from "../../utils/logFormatter.js";
import * as compatConfigCache from "../../utils/compatConfigCache.js";

// Valid provider identifiers — mirrors CLOUD_KEY_MAP + local in aiProvider.js
const VALID_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "local"];
const COMPAT_PREFIX = "compat:";

/**
 * Encrypt a string value using the credential encryption utility.
 * Wraps it in a minimal object so encryptCredentials can process it.
 * @param   {string} plaintext
 * @returns {string} Encrypted blob string.
 * @private
 */
function encryptValue(plaintext) {
  const wrapped = encryptCredentials({ username: plaintext, password: "", usernameSelector: "", passwordSelector: "", submitSelector: "" });
  return wrapped.username;
}

/**
 * Decrypt a string value that was encrypted by {@link encryptValue}.
 * @param   {string} encryptedBlob
 * @returns {string} The original plaintext, or "" on failure.
 * @private
 */
function decryptValue(encryptedBlob) {
  try {
    const wrapped = decryptCredentials({
      username: encryptedBlob,
      password: "",
      usernameSelector: "",
      passwordSelector: "",
      submitSelector: "",
      _encrypted: true,
    });
    return wrapped?.username || "";
  } catch (err) {
    console.error(formatLogLine("error", null, `[apiKeyRepo] Decryption failed: ${err.message}`));
    return "";
  }
}

/**
 * Persist (upsert) an API key or Ollama config for the given provider.
 * Cloud provider values are encrypted before storage.
 * Ollama config is JSON-serialised (not sensitive) then encrypted for consistency.
 *
 * @param {string} provider - `"anthropic"` | `"openai"` | `"google"` | `"openrouter"` | `"local"`.
 * @param {string|Object} value - Plaintext API key string, or Ollama config object.
 * @throws {Error} If provider is not a recognised value.
 */
export function set(provider, value) {
  if (!VALID_PROVIDERS.includes(provider) && !isCompatProvider(provider)) {
    throw new Error(`[apiKeyRepo] Unknown provider: "${provider}"`);
  }
  const db = getDatabase();
  const plaintext = typeof value === "object" ? JSON.stringify(value) : String(value);
  const encrypted = encryptValue(plaintext);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO api_keys (provider, value, updatedAt) VALUES (?, ?, ?)" +
    " ON CONFLICT(provider) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt"
  ).run(provider, encrypted, now);
}

/**
 * Retrieve and decrypt the stored value for a provider.
 * For cloud providers this returns a plaintext API key string.
 * For `"local"` this returns the parsed Ollama config object.
 *
 * @param   {string} provider
 * @returns {string|Object|null} Decrypted value, or `null` if not found / empty.
 */
export function get(provider) {
  const db = getDatabase();
  const row = db.prepare("SELECT value FROM api_keys WHERE provider = ?").get(provider);
  if (!row) return null;
  const plaintext = decryptValue(row.value);
  if (!plaintext) return null;
  if (provider === "local" || isCompatProvider(provider)) {
    try {
      return JSON.parse(plaintext);
    } catch {
      return null;
    }
  }
  return plaintext;
}

/**
 * Remove the stored key for a provider.
 * Silently succeeds if the provider has no stored key.
 *
 * @param {string} provider
 */
export function remove(provider) {
  const db = getDatabase();
  db.prepare("DELETE FROM api_keys WHERE provider = ?").run(provider);
}

/**
 * Return all stored providers with their decrypted values.
 * Useful at startup to restore all persisted keys into the runtime cache.
 *
 * @returns {Array<{provider: string, value: string|Object}>}
 */
export function getAll() {
  const db = getDatabase();
  const rows = db.prepare("SELECT provider FROM api_keys").all();
  const result = [];
  for (const row of rows) {
    const value = get(row.provider);
    if (value !== null) {
      result.push({ provider: row.provider, value });
    }
  }
  return result;
}


function isCompatProvider(provider) {
  return typeof provider === "string" && provider.startsWith(COMPAT_PREFIX) && provider.length > COMPAT_PREFIX.length;
}

export function listCompatSlots() {
  const db = getDatabase();
  const rows = db.prepare("SELECT provider FROM api_keys WHERE provider LIKE 'compat:%' ORDER BY provider").all();
  return rows.map((r) => r.provider);
}

export function getCompatSlot(slotId) {
  const provider = slotId.startsWith(COMPAT_PREFIX) ? slotId : `${COMPAT_PREFIX}${slotId}`;
  const value = get(provider);
  if (!value || typeof value !== "object") return null;
  return value;
}

export function setCompatSlot(slotId, config) {
  const provider = slotId.startsWith(COMPAT_PREFIX) ? slotId : `${COMPAT_PREFIX}${slotId}`;
  set(provider, config);
  // Write-through invalidation: clear the local cache AND publish on Redis
  // so other instances drop their stale entry for this slot.  Runs AFTER
  // the DB write so a concurrent reader on another instance that pre-empts
  // the publish will still see the new row via the DB loader.
  compatConfigCache.invalidate(provider);
}

export function deleteCompatSlot(slotId) {
  const provider = slotId.startsWith(COMPAT_PREFIX) ? slotId : `${COMPAT_PREFIX}${slotId}`;
  remove(provider);
  compatConfigCache.invalidate(provider);
}

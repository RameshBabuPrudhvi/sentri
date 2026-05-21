/**
 * @module aiProvider/secrets
 * @description B1.4 — AES-256-GCM at-rest encryption for `provider_routes`
 *   API keys.
 *
 * Distinct surface from `utils/credentialEncryption` (which encrypts text
 * columns with a scrypt-derived key and an `"enc:v1:..."` envelope). This
 * module:
 *
 *   • Operates on the `provider_routes.apiKeyEncrypted` + `apiKeyNonce`
 *     BLOB columns directly — no string envelope, no version prefix.
 *   • Uses a raw 32-byte master key from `SENTRI_MASTER_KEY` (base64)
 *     instead of scrypt-from-secret. Operator owns rotation explicitly.
 *   • Fails fast on import when `NODE_ENV=production` and the master
 *     key is missing or malformed — dispatch must NEVER come up against
 *     production data with a derived "dev key".
 *   • Caches plaintext for 5 minutes keyed by `routeId` so the dispatch
 *     hot path doesn't pay an AES round-trip on every call.
 *
 * ## Threat model
 *
 * Encryption defends against database-dump exfiltration (sqlite file
 * stolen, replica leaked, backup copied). It does NOT defend against
 * process-memory access — the plaintext cache lives in the V8 heap.
 * Pair with OS-level memory protections and a master-key store outside
 * the DB host (KMS / Vault / restricted-perms FS mount) for
 * defence-in-depth.
 */
import crypto from "crypto";
import { formatLogLine } from "../utils/logFormatter.js";
import * as providerRouteRepo from "../database/repositories/providerRouteRepo.js";
const MASTER_KEY_LEN_BYTES = 32; // AES-256
const NONCE_LEN_BYTES      = 12; // GCM-recommended nonce length
const AUTH_TAG_LEN_BYTES   = 16; // GCM default tag length
const CACHE_TTL_MS         = 5 * 60 * 1000;
let _masterKey = null;
let _warnedDevMode = false;
/**
 * Resolve the master key from `SENTRI_MASTER_KEY` (base64, 32 bytes).
 *   • Production: missing or malformed → throw on import.
 *   • Development: missing → log once, derive deterministic dev key.
 *
 * @returns {Buffer}
 * @throws {Error & { code: "ERR_MASTER_KEY_MISSING" | "ERR_MASTER_KEY_INVALID" }}
 */
function resolveMasterKey() {
  const raw = process.env.SENTRI_MASTER_KEY;
  const isProd = process.env.NODE_ENV === "production";
  if (raw) {
    let buf;
    try { buf = Buffer.from(raw, "base64"); }
    catch {
      const err = new Error("SENTRI_MASTER_KEY is not valid base64");
      err.code = "ERR_MASTER_KEY_INVALID";
      throw err;
    }
    if (buf.length !== MASTER_KEY_LEN_BYTES) {
      const err = new Error(
        `SENTRI_MASTER_KEY must decode to exactly ${MASTER_KEY_LEN_BYTES} bytes ` +
        `(got ${buf.length}). Generate with: openssl rand -base64 32`
      );
      err.code = "ERR_MASTER_KEY_INVALID";
      throw err;
    }
    return buf;
  }
  if (isProd) {
    const err = new Error(
      "SENTRI_MASTER_KEY is required when NODE_ENV=production. " +
      "Generate with: openssl rand -base64 32"
    );
    err.code = "ERR_MASTER_KEY_MISSING";
    throw err;
  }
  // Dev fallback — deterministic per cwd so two terminals in the same
  // checkout interop, but distinct across checkouts so a leaked dev row
  // from one repo can't be opened in another.
  if (!_warnedDevMode) {
    console.warn(formatLogLine("warn", null,
      "[aiProvider/secrets] SENTRI_MASTER_KEY not set; using a deterministic " +
      "dev key. DO NOT use this build to encrypt production secrets."
    ));
    _warnedDevMode = true;
  }
  return crypto.createHash("sha256")
    .update(`sentri-dev-master:${process.cwd()}`)
    .digest();
}
_masterKey = resolveMasterKey();
// ── Plaintext cache ───────────────────────────────────────────────────────────
/** @type {Map<string, { plaintext: string, expiresAt: number }>} */
const plaintextCache = new Map();
function cacheGet(routeId) {
  const entry = plaintextCache.get(routeId);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    plaintextCache.delete(routeId);
    return null;
  }
  return entry.plaintext;
}
function cacheSet(routeId, plaintext) {
  plaintextCache.set(routeId, {
    plaintext,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}
/**
 * Drop a single routeId's plaintext from the cache. Called by
 * `providerRouteRepo.upsert` on `rotate_key` and on delete so a
 * subsequent decrypt re-reads the fresh ciphertext.
 */
export function invalidateRouteSecret(routeId) {
  plaintextCache.delete(routeId);
}
/**
 * Wipe the entire plaintext cache. Use during master-key rotation or
 * from a test setup before re-seeding routes.
 */
export function clearSecretCache() {
  plaintextCache.clear();
}
// ── Encrypt / decrypt primitives ──────────────────────────────────────────────
/**
 * Encrypt a plaintext API key for storage in `provider_routes`.
 *
 * Output shape matches the three migration columns:
 *   • `ciphertext` — AES-256-GCM ciphertext with the 16-byte auth tag
 *     appended. Single BLOB simplifies the schema; decrypt splits it back.
 *   • `nonce` — random 12-byte IV stored separately so a rotation can
 *     re-encrypt without regenerating nonces for unchanged rows.
 *   • `lastFour` — last 4 chars of plaintext for UI display ("••••abcd").
 *     Lets Settings render without ever decrypting.
 *
 * @param {string} plaintext
 * @returns {{ ciphertext: Buffer, nonce: Buffer, lastFour: string }}
 * @throws {TypeError} When `plaintext` is empty or not a string.
 */
export function encryptKey(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TypeError("encryptKey: plaintext must be a non-empty string");
  }
  const nonce = crypto.randomBytes(NONCE_LEN_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", _masterKey, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]),
    nonce,
    lastFour: plaintext.slice(-4),
  };
}
/**
 * Decrypt a ciphertext + nonce pair produced by {@link encryptKey}.
 * Bypasses the routeId cache — use {@link getDecryptedKey} on the hot
 * path. This primitive exists for explicit one-off decrypts (export,
 * key-rotation re-encrypt loop, tests).
 *
 * @param {Buffer} ciphertext
 * @param {Buffer} nonce
 * @returns {string}
 * @throws {Error & { code: "ERR_SECRET_DECRYPT_FAILED" }}
 */
export function decryptKey(ciphertext, nonce) {
  if (!Buffer.isBuffer(ciphertext) || !Buffer.isBuffer(nonce)) {
    const err = new Error("decryptKey: ciphertext and nonce must be Buffers");
    err.code = "ERR_SECRET_DECRYPT_FAILED";
    throw err;
  }
  if (ciphertext.length < AUTH_TAG_LEN_BYTES) {
    const err = new Error("decryptKey: ciphertext shorter than auth tag");
    err.code = "ERR_SECRET_DECRYPT_FAILED";
    throw err;
  }
  const tagOffset = ciphertext.length - AUTH_TAG_LEN_BYTES;
  const body = ciphertext.subarray(0, tagOffset);
  const authTag = ciphertext.subarray(tagOffset);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", _masterKey, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch (err) {
    // Never echo the underlying GCM error message — it can leak length /
    // tag-mismatch shape useful to an attacker probing the master key.
    const wrapped = new Error("Decryption failed");
    wrapped.code = "ERR_SECRET_DECRYPT_FAILED";
    throw wrapped;
  }
}
/**
 * Resolve a routeId to its plaintext API key, using the in-memory cache
 * when fresh. Hot-path helper for the dispatch layer (B2+) — adapters
 * call this once per outbound request.
 *
 * @param {string} workspaceId
 * @param {string} routeId
 * @returns {string|null} Plaintext key, or `null` when the route has no
 *   stored secret (e.g. Ollama route with no auth).
 * @throws {Error & { code: "ERR_SECRET_DECRYPT_FAILED" }}
 */
export function getDecryptedKey(workspaceId, routeId) {
  const cached = cacheGet(routeId);
  if (cached !== null) return cached;
  const row = providerRouteRepo.getSecretById(workspaceId, routeId);
  if (!row || !row.apiKeyEncrypted || !row.apiKeyNonce) return null;
  const plaintext = decryptKey(row.apiKeyEncrypted, row.apiKeyNonce);
  cacheSet(routeId, plaintext);
  return plaintext;
}

// ── Test seam ─────────────────────────────────────────────────────────────────
/**
 * Re-resolve the master key from the current env. Test-only — exported
 * so the master-key-rotation test in `tests/provider-secrets.test.js`
 * can mutate `process.env.SENTRI_MASTER_KEY` and verify decrypt fails
 * against ciphertext written under a previous key.
 *
 * NEVER call this from product code. Production master-key rotation
 * MUST go through the documented procedure (process restart with the
 * new key + a re-encrypt batch under both keys), not a live mutation.
 *
 * @internal
 */
export function _reloadMasterKeyForTests() {
  _warnedDevMode = false;
  _masterKey = resolveMasterKey();
  plaintextCache.clear();
}

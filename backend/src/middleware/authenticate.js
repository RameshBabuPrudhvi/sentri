/**
 * @module middleware/authenticate
 * @description Centralised authentication middleware (strategy pattern).
 *
 * All token extraction and verification logic lives in this single file so
 * adding a new auth method (API keys, service accounts, SAML, etc.) means
 * adding one strategy object — no route files need to change.
 *
 * ### Strategies
 * | Name             | Token source                        | Verifier                                    | Sets on `req`                              |
 * |------------------|-------------------------------------|---------------------------------------------|----------------------------------------------|
 * | `jwt-cookie`     | `access_token` HttpOnly cookie      | HS256 JWT verify + revocation check         | `req.authUser` (JWT payload)               |
 * | `jwt-bearer`     | `Authorization: Bearer` header      | Same as jwt-cookie                          | `req.authUser`                             |
 * | `jwt-query`      | `?token=` query param (SSE)         | Same as jwt-cookie                          | `req.authUser`                             |
 * | `trigger-token`  | `Authorization: Bearer` header      | SHA-256 hash lookup in `webhook_tokens`     | `req.triggerToken`, `req.triggerProject`    |
 *
 * ### CSRF integration
 * `req.authStrategy` is set on every authenticated request.  The CSRF
 * middleware in `appSetup.js` checks `COOKIE_STRATEGIES.has(req.authStrategy)`
 * — non-cookie strategies are automatically exempt without manual regex
 * carve-outs.
 *
 * ### Backward compatibility
 * `requireAuth` is re-exported from `routes/auth.js` as an alias for
 * `requireUser` so existing imports continue to work without changes.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { redis, redisSub, isRedisAvailable } from "../utils/redisClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Strategy name constants ──────────────────────────────────────────────────

/** @enum {string} Auth strategy identifiers. */
export const AUTH_TYPE = Object.freeze({
  JWT_COOKIE:    "jwt-cookie",
  JWT_BEARER:    "jwt-bearer",
  JWT_QUERY:     "jwt-query",
  TRIGGER_TOKEN: "trigger-token",
});

/**
 * Strategies that use cookies and therefore require CSRF protection.
 * Any strategy NOT in this set is automatically CSRF-exempt.
 * @type {Set<string>}
 */
export const COOKIE_STRATEGIES = new Set([AUTH_TYPE.JWT_COOKIE]);

// ─── JWT primitives ───────────────────────────────────────────────────────────

/** JWT cookie name — HttpOnly so JS cannot read the token. */
export const AUTH_COOKIE = "access_token";

/**
 * Sign a JWT with HS256 using only Node.js `crypto` (no external library).
 *
 * @param   {Object} payload      - Claims to include.
 * @param   {string} secret       - HMAC secret (32+ chars recommended).
 * @param   {number} [expiresInSec=28800] - Token lifetime in seconds (default 8 hours).
 * @returns {string}                The signed JWT string.
 */
export function signJwt(payload, secret, expiresInSec = 8 * 60 * 60) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSec })).toString("base64url");
  const sig    = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/**
 * Verify and decode a JWT signed with HS256.
 * Returns the decoded payload if valid, or `null` if invalid/expired/malformed.
 * Uses constant-time signature comparison and explicit buffer length check.
 *
 * @param   {string}       token  - The JWT string to verify.
 * @param   {string}       secret - The HMAC secret used for signing.
 * @returns {Object|null}           Decoded payload, or `null` on failure.
 */
export function verifyJwt(token, secret) {
  try {
    const parts = token?.split(".");
    if (parts?.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ─── JWT secret management ────────────────────────────────────────────────────

/** @type {string|null} */
let _cachedSecret = null;

/**
 * Get the JWT signing secret.
 *
 * Resolution order:
 * 1. `JWT_SECRET` env var (required in production, recommended everywhere)
 * 2. Dev/test only: auto-generate a random 256-bit secret and persist it to
 *    `backend/data/.jwt-secret` so tokens survive server restarts.
 *
 * @returns {string} The secret (always ≥ 32 chars).
 * @throws {Error} In production if `JWT_SECRET` is missing or too short.
 */
export function getJwtSecret() {
  if (_cachedSecret) return _cachedSecret;

  const envSecret = process.env.JWT_SECRET;
  if (envSecret && envSecret.length >= 32) {
    _cachedSecret = envSecret;
    return _cachedSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("[auth] FATAL: JWT_SECRET is missing or too short. Set a 32+ char secret in .env for production.");
  }

  const secretPath = path.join(__dirname, "..", "..", "data", ".jwt-secret");

  try {
    const existing = fs.readFileSync(secretPath, "utf-8").trim();
    if (existing.length >= 32) {
      _cachedSecret = existing;
      console.warn(formatLogLine("warn", null, "Using auto-generated JWT secret from data/.jwt-secret. Set JWT_SECRET in .env for production."));
      return _cachedSecret;
    }
  } catch { /* file doesn't exist yet */ }

  const newSecret = crypto.randomBytes(32).toString("base64url");
  try {
    const dir = path.dirname(secretPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(secretPath, newSecret, "utf-8");
    console.warn(formatLogLine("warn", null, "Generated new JWT secret → data/.jwt-secret. Set JWT_SECRET in .env for production."));
  } catch (err) {
    console.warn(formatLogLine("warn", null, `Could not persist JWT secret to disk: ${err.message}`));
  }
  _cachedSecret = newSecret;
  return _cachedSecret;
}

// ─── Token revocation ─────────────────────────────────────────────────────────

// When Redis is available (INF-002), revoked JTIs are stored as Redis keys
// with a TTL matching the token's remaining lifetime.  This means:
//   1. Revocations survive server restarts.
//   2. Revocations are shared across all instances in a multi-process deployment.
//   3. Expired entries are cleaned up automatically by Redis TTL.
// When Redis is NOT available, the original in-memory Map is used as fallback.

/** In-memory fallback revocation list: { jti → expiry_timestamp_sec } */
const _localRevokedTokens = new Map();

/** Redis pub/sub channel for broadcasting revocations across instances. */
const REVOKE_CHANNEL = "sentri:token:revoked";

// Purge expired entries from the in-memory fallback every hour.
// Only needed when Redis is not available — Redis handles TTL natively.
const _purgeInterval = setInterval(() => {
  if (isRedisAvailable()) return;
  const now = Date.now() / 1000;
  for (const [jti, exp] of _localRevokedTokens) {
    if (exp < now) _localRevokedTokens.delete(jti);
  }
}, 60 * 60 * 1000);
_purgeInterval.unref();

// Subscribe to the revocation broadcast channel so revocations from other
// instances are reflected in this instance's local Map. This keeps has()
// synchronous while ensuring cross-instance consistency.
if (redisSub) {
  redisSub.subscribe(REVOKE_CHANNEL).catch(err => {
    console.warn(formatLogLine("warn", null, `[auth] Redis subscribe for revocations failed: ${err.message}`));
  });
  redisSub.on("message", (channel, message) => {
    if (channel !== REVOKE_CHANNEL) return;
    try {
      const { jti, exp } = JSON.parse(message);
      if (jti && exp) _localRevokedTokens.set(jti, exp);
    } catch { /* malformed — ignore */ }
  });
}

// On startup, pre-load recent revocations from Redis into the local Map
// so tokens revoked before this instance started are still rejected.
if (isRedisAvailable()) {
  (async () => {
    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "sentri:revoked:*", "COUNT", 100);
        cursor = nextCursor;
        for (const key of keys) {
          const jti = key.slice("sentri:revoked:".length);
          const ttl = await redis.ttl(key);
          if (ttl > 0) {
            _localRevokedTokens.set(jti, Math.floor(Date.now() / 1000) + ttl);
          }
        }
      } while (cursor !== "0");
    } catch (err) {
      console.warn(formatLogLine("warn", null, `[auth] Failed to pre-load revocations from Redis: ${err.message}`));
    }
  })();
}

/**
 * Revoked tokens facade — `.set()` / `.has()` API matching the original Map
 * so all existing callers (auth.js logout, refresh) work without changes.
 * Delegates to Redis when available. Cross-instance sync is handled by
 * pub/sub — set() publishes to the REVOKE_CHANNEL so other instances
 * update their local Maps, and has() always checks the local Map (fast,
 * synchronous, and kept in sync by the subscriber).
 */
export const revokedTokens = {
  set(jti, exp) {
    _localRevokedTokens.set(jti, exp);
    if (isRedisAvailable()) {
      const ttl = Math.max(1, Math.ceil(exp - Date.now() / 1000));
      redis.set(`sentri:revoked:${jti}`, "1", "EX", ttl).catch(() => {});
      // Broadcast to other instances so their local Maps are updated.
      redis.publish(REVOKE_CHANNEL, JSON.stringify({ jti, exp })).catch(() => {});
    }
  },
  has(jti) {
    return _localRevokedTokens.has(jti);
  },
};

// ─── Strategy definitions ─────────────────────────────────────────────────────

/**
 * JWT verification shared by all jwt-* strategies.
 * @param {string} token - Raw JWT string.
 * @returns {Object|null} Decoded payload or null.
 */
function verifyJwtToken(token) {
  const payload = verifyJwt(token, getJwtSecret());
  if (!payload) return null;
  if (payload.jti && revokedTokens.has(payload.jti)) return null;
  return payload;
}

/** @type {Array<{name: string, extract: Function, verify: Function}>} */
const STRATEGIES = [
  // 1. JWT from HttpOnly cookie (primary for browser sessions)
  {
    name: AUTH_TYPE.JWT_COOKIE,
    extract: (req) => req.cookies?.[AUTH_COOKIE] || null,
    verify: (token) => {
      const payload = verifyJwtToken(token);
      return payload ? { strategy: AUTH_TYPE.JWT_COOKIE, authUser: payload } : null;
    },
  },
  // 2. JWT from Authorization: Bearer header (backward compat, direct API consumers)
  {
    name: AUTH_TYPE.JWT_BEARER,
    extract: (req) => {
      const h = req.headers.authorization;
      return h?.startsWith("Bearer ") ? h.slice(7) : null;
    },
    verify: (token) => {
      const payload = verifyJwtToken(token);
      return payload ? { strategy: AUTH_TYPE.JWT_BEARER, authUser: payload } : null;
    },
  },
  // 3. JWT from ?token= query param (SSE / EventSource fallback)
  {
    name: AUTH_TYPE.JWT_QUERY,
    extract: (req) => req.query.token || null,
    verify: (token) => {
      const payload = verifyJwtToken(token);
      return payload ? { strategy: AUTH_TYPE.JWT_QUERY, authUser: payload } : null;
    },
  },
  // 4. Per-project trigger token (CI/CD pipelines)
  {
    name: AUTH_TYPE.TRIGGER_TOKEN,
    extract: (req) => {
      const h = req.headers.authorization;
      return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    },
    verify: (token, req) => {
      if (!token) return null;
      const tokenRow = webhookTokenRepo.findByHash(webhookTokenRepo.hashToken(token));
      if (!tokenRow) return null;
      const project = projectRepo.getById(req.params.id);
      if (!project) return null;
      if (tokenRow.projectId !== project.id) return null;
      return {
        strategy: AUTH_TYPE.TRIGGER_TOKEN,
        triggerToken: tokenRow,
        triggerProject: project,
      };
    },
  },
];

// Build a name → strategy lookup for fast filtering.
const _strategyMap = new Map(STRATEGIES.map(s => [s.name, s]));

// ─── Public middleware factory ─────────────────────────────────────────────────

/**
 * Create an Express middleware that authenticates the request using the
 * specified strategies (tried in declaration order).
 *
 * On success, sets `req.authUser`, `req.triggerToken`, `req.triggerProject`,
 * and `req.authStrategy` as appropriate for the winning strategy.
 *
 * @param {...string} allowedNames - Strategy names to try (from {@link AUTH_TYPE}).
 *   If empty, tries ALL strategies.
 * @returns {Function} Express middleware `(req, res, next)`.
 */
export function authenticate(...allowedNames) {
  const allowed = allowedNames.length
    ? allowedNames.map(n => _strategyMap.get(n)).filter(Boolean)
    : STRATEGIES;

  return (req, res, next) => {
    for (const strategy of allowed) {
      const raw = strategy.extract(req);
      if (!raw) continue;
      const result = strategy.verify(raw, req);
      if (result) {
        if (result.authUser)       req.authUser       = result.authUser;
        if (result.triggerToken)   req.triggerToken    = result.triggerToken;
        if (result.triggerProject) req.triggerProject  = result.triggerProject;
        // Tag the strategy so CSRF middleware can auto-exempt non-cookie auth.
        req.authStrategy = result.strategy;
        return next();
      }
    }

    // ── Strategy-specific error messages ──────────────────────────────────
    // When only trigger-token is allowed, give CI-friendly diagnostics.
    if (allowedNames.length === 1 && allowedNames[0] === AUTH_TYPE.TRIGGER_TOKEN) {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Authorization: Bearer <token> header required." });
      }
      const plaintext = authHeader.slice(7).trim();
      if (!plaintext) {
        return res.status(401).json({ error: "Empty token." });
      }
      // Token was present — check if it's valid but for the wrong project.
      const tokenRow = webhookTokenRepo.findByHash(webhookTokenRepo.hashToken(plaintext));
      if (!tokenRow) {
        return res.status(401).json({ error: "Invalid trigger token." });
      }
      const project = projectRepo.getById(req.params.id);
      if (!project) {
        return res.status(404).json({ error: "not found" });
      }
      if (tokenRow.projectId !== project.id) {
        return res.status(403).json({ error: "Token does not belong to this project." });
      }
    }

    // Default error for JWT strategies
    return res.status(401).json({ error: "Authentication required." });
  };
}

// ─── Convenience aliases ──────────────────────────────────────────────────────

/**
 * JWT auth middleware — tries cookie → bearer → query param.
 * This is the standard middleware for all user-facing API routes.
 * Backward-compatible drop-in replacement for the old `requireAuth`.
 */
export const requireUser = authenticate(
  AUTH_TYPE.JWT_COOKIE,
  AUTH_TYPE.JWT_BEARER,
  AUTH_TYPE.JWT_QUERY,
);

/**
 * Trigger token auth middleware — per-project Bearer token for CI/CD.
 * Sets `req.triggerToken` and `req.triggerProject` on success.
 */
export const requireTrigger = authenticate(AUTH_TYPE.TRIGGER_TOKEN);

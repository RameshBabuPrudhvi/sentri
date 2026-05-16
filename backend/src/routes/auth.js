/**
 * @module routes/auth
 * @description Authentication routes for email/password and OAuth (GitHub, Google).
 *
 * ### Endpoints (INF-005: all under `/api/v1/auth/`)
 * | Method | Path                              | Description                          |
 * |--------|-----------------------------------|--------------------------------------|
 * | POST   | `/api/v1/auth/register`           | Email/password registration          |
 * | POST   | `/api/v1/auth/login`              | Email/password sign-in               |
 * | POST   | `/api/v1/auth/logout`             | Token revocation + cookie clear      |
 * | POST   | `/api/v1/auth/refresh`            | Refresh session (extend cookie TTL)  |
 * | GET    | `/api/v1/auth/me`                 | Return current user from cookie      |
 * | GET    | `/api/v1/auth/export`             | Export user-owned account data (SEC-003) |
 * | DELETE | `/api/v1/auth/account`            | Delete account + owned data (SEC-003) |
 * | GET    | `/api/v1/auth/verify`             | Verify email via token (SEC-001)     |
 * | POST   | `/api/v1/auth/resend-verification`| Resend verification email (SEC-001)  |
 * | POST   | `/api/v1/auth/forgot-password`    | Request a password reset token       |
 * | POST   | `/api/v1/auth/reset-password`     | Reset password using a valid token   |
 * | GET    | `/api/v1/auth/github/callback`    | GitHub OAuth token exchange          |
 * | GET    | `/api/v1/auth/google/callback`    | Google OAuth token exchange          |
 *
 * ### Security measures
 * - Passwords hashed with scrypt (64-byte key, 16-byte random salt)
 * - JWT stored in HttpOnly; Secure; SameSite=Strict cookie — never in localStorage
 * - A companion `token_exp` cookie (Non-HttpOnly) exposes only the exp timestamp
 *   so the frontend can proactively warn before expiry without ever touching the JWT
 * - JWT signed with HS256, 8-hour expiry
 * - Rate limiting: separate per-endpoint buckets (login: 10, forgot/reset: 5 per IP per 15 min)
 * - Revoked tokens kept in an in-memory Map (production: use Redis — see ENH-002)
 * - Password reset tokens persisted in DB table `password_reset_tokens` (migration 003)
 * - Input validation and sanitisation on every endpoint
 * - OAuth state parameter validated on the frontend to prevent CSRF
 * - CSRF double-submit cookie protection on all mutating endpoints (via appSetup.js)
 * - No sensitive data (passwords, raw OAuth tokens, JWT strings) returned to client
 */

import express from "express";
import crypto from "crypto";
import * as userRepo from "../database/repositories/userRepo.js";
import * as resetTokenRepo from "../database/repositories/passwordResetTokenRepo.js";
import * as verificationTokenRepo from "../database/repositories/verificationTokenRepo.js";
import * as workspaceRepo from "../database/repositories/workspaceRepo.js";
import * as accountRepo from "../database/repositories/accountRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as webauthnRepo from "../database/repositories/webauthnRepo.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { logActivity } from "../utils/activityLogger.js";
import { evaluateMfaEnforcement } from "../utils/mfaEnforcement.js";
import { encryptString, decryptString } from "../utils/credentialEncryption.js";
import { stopSchedule } from "../scheduler.js";
import { sendVerificationEmail } from "../utils/emailSender.js";
import { buildJwtPayload, buildUserResponse } from "../utils/authWorkspace.js";
import { SYSTEM_WORKSPACE_ID } from "../constants/systemWorkspace.js";
import { cookieSameSite } from "../middleware/appSetup.js";
import {
  signJwt, getJwtSecret, revokedTokens,
  requireUser, AUTH_COOKIE,
} from "../middleware/authenticate.js";

/**
 * Backward-compatible alias.  All files that do
 *   `import { requireAuth } from "./routes/auth.js"`
 * continue to work — `requireUser` is the same JWT cookie → bearer → query
 * middleware that `requireAuth` used to be.
 */
export const requireAuth = requireUser;

// ─── Cookie helpers ───────────────────────────────────────────────────────────

/** Expiry hint cookie — Non-HttpOnly so the frontend can read the `exp` timestamp. */
export const EXP_COOKIE      = "token_exp";
/** JWT TTL in seconds (8 hours). Must match signJwt default. */
export const JWT_TTL_SEC     = 8 * 60 * 60;

/**
 * Set the HttpOnly auth cookie + a readable expiry hint cookie on a response.
 * Called after every successful authentication (login, OAuth, refresh, workspace switch).
 *
 * @param {Object} res       - Express response object.
 * @param {string} token     - The signed JWT string.
 * @param {number} expSec    - Unix timestamp of token expiry (seconds).
 */
export function setAuthCookie(res, token, expSec) {
  const maxAge  = JWT_TTL_SEC;
  const sameSite = cookieSameSite();

  // Use appendHeader so we don't overwrite the _csrf cookie that the
  // CSRF middleware may have already queued on this response via setHeader.
  // Primary cookie: HttpOnly prevents JS from ever reading the JWT.
  // SameSite policy is determined by cookieSameSite() — Strict for same-origin,
  // None; Secure for cross-origin (GitHub Pages + Render).
  res.appendHeader("Set-Cookie",
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Max-Age=${maxAge}${sameSite}`
  );
  // Expiry hint: NOT HttpOnly — frontend reads it for proactive expiry UX.
  // Contains only the numeric exp timestamp, not the token.
  res.appendHeader("Set-Cookie",
    `${EXP_COOKIE}=${expSec}; Path=/; Max-Age=${maxAge}${sameSite}`
  );
}

/**
 * Clear both auth cookies, effectively logging the user out client-side.
 * @param {Object} res - Express response object.
 */
function clearAuthCookies(res) {
  const sameSite = cookieSameSite();
  res.appendHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; Max-Age=0${sameSite}`);
  res.appendHeader("Set-Cookie", `${EXP_COOKIE}=; Path=/; Max-Age=0${sameSite}`);
}


const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Hash a password using Node.js scrypt (no native addon needed).
 * Generates a 16-byte random salt and derives a 64-byte key.
 *
 * @param   {string} password - The plaintext password to hash.
 * @returns {Promise<string>}   Format: `"<hex-salt>:<hex-derived-key>"`.
 * @private
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (err, key) => (err ? rej(err) : res(key)))
  );
  return `${salt}:${derived.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param   {string}  password - The plaintext password to verify.
 * @param   {string}  stored   - The stored hash in `"<salt>:<key>"` format.
 * @returns {Promise<boolean>}   `true` if the password matches.
 * @private
 */
async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const derived = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (err, key) => (err ? rej(err) : res(key)))
  );
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), derived);
}

// signJwt, verifyJwt, getJwtSecret, revokedTokens — imported from
// middleware/authenticate.js above.  No duplicated implementations here.

// Password reset tokens are stored in the `password_reset_tokens` DB table
// (migration 003). The token TTL is enforced by the `expiresAt` column.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Email verification tokens (SEC-001, migration 003).
// 24-hour TTL gives users plenty of time to check their inbox.
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Rate limiters — separate buckets per endpoint category so flooding
// one endpoint (e.g. forgot-password) doesn't lock out login.
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes

// CI/test environments (SKIP_EMAIL_VERIFICATION=true) run dozens of
// register+login cycles from 127.0.0.1 in seconds. The production budget
// of 10 logins / 15 min would cause cascading 429s in the test suite.
// Raise the ceiling to 200 in dev/CI mode — the bucket is still enforced
// so the rate-limit code path is exercised, just with a higher threshold.
//
// Evaluated lazily at each rate-limit check (NOT at module-load time) so
// tests that call `setupEnv({ SKIP_EMAIL_VERIFICATION: "true" })` AFTER
// importing this module still pick up the raised ceiling.
function _isTestMode() {
  return process.env.SKIP_EMAIL_VERIFICATION === "true"
    || process.env.RATE_LIMIT_TEST_MODE === "true";
}
const rateBuckets = {
  login:         { map: new Map(), max: 10, testMax: 200 },  // 10 login attempts per IP per 15 min (200 in test mode)
  forgotPassword:{ map: new Map(), max: 5 },   // 5 reset requests per IP per 15 min
  resetPassword: { map: new Map(), max: 5 },   // 5 reset attempts per IP per 15 min
  // SEC-004: MFA-specific buckets — verify is the brute-force surface (only
  // 6 digits of entropy per attempt), enroll prevents secret-flooding abuse.
  // testMax raises the ceiling in CI so the MFA test suite (which runs
  // ~15 setupUser() cycles per file from 127.0.0.1) doesn't trip 429.
  mfaVerify:        { map: new Map(), max: 5,  testMax: 200 },   // 5 TOTP verify attempts per IP per 15 min
  mfaEnroll:        { map: new Map(), max: 3,  testMax: 200 },   // 3 enroll cycles per IP per 15 min
  // SEC-004 §5a: WebAuthn verify is also a brute-force surface (an attacker
  // with a stolen pendingToken could try arbitrary assertions). Same budget
  // as TOTP — failed assertions cost the same as failed codes.
  webauthnVerify:   { map: new Map(), max: 5,  testMax: 200 },   // 5 passkey verify attempts per IP per 15 min
};

/**
 * Check rate limit for a specific bucket.
 * @param {string} bucket — key in rateBuckets (e.g. "login", "forgotPassword")
 * @param {string} ip
 * @returns {{ allowed: boolean, retryAfterSec: number }}
 */
function checkRateLimit(bucket, ip) {
  const cfg = rateBuckets[bucket];
  // Honour `testMax` in dev/CI mode (SKIP_EMAIL_VERIFICATION=true). Resolved
  // here, not at module-load, so tests setting the env after import still
  // pick up the raised ceiling.
  const max = (cfg.testMax !== undefined && _isTestMode()) ? cfg.testMax : cfg.max;
  const { map } = cfg;
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || entry.resetAt < now) {
    map.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { allowed: true };
  }
  if (entry.count >= max) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfterSec };
  }
  entry.count++;
  return { allowed: true };
}

// Purge expired DB tokens periodically (reset + verification).
// In-memory revoked JWT purging is handled by middleware/authenticate.js.
// .unref() prevents this timer from keeping the process alive during tests.
const _purgeInterval = setInterval(() => {
  try {
    resetTokenRepo.deleteExpired();
  } catch (err) { console.error(formatLogLine("error", null, `[auth/purge] Failed to delete expired reset tokens: ${err.message}`)); }
  try {
    verificationTokenRepo.deleteExpired();
  } catch (err) { console.error(formatLogLine("error", null, `[auth/purge] Failed to delete expired verification tokens: ${err.message}`)); }
}, 60 * 60 * 1000);
_purgeInterval.unref();

// requireAuth is exported above as an alias for requireUser from
// middleware/authenticate.js — see the import block at the top of this file.

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Validate an email address format.
 * @param   {string}  email - The email to validate.
 * @returns {boolean}         `true` if the format is valid.
 * @private
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
/**
 * Trim and truncate a string to prevent oversized input.
 * Returns empty string for non-string values.
 *
 * @param   {*}      str           - The value to sanitise.
 * @param   {number} [maxLen=200]  - Maximum allowed length.
 * @returns {string}                 The sanitised string.
 * @private
 */
function sanitiseString(str, maxLen = 200) {
  return typeof str === "string" ? str.trim().slice(0, maxLen) : "";
}

// ─── Password strength validation (GAP-02) ───────────────────────────────────
// Enforces complexity beyond a minimum length: at least one uppercase letter,
// one lowercase letter, one digit, and one special character.  Also rejects the
// 20 most common passwords that pass the character-class checks.

const COMMON_PASSWORDS = new Set([
  "password", "12345678", "123456789", "1234567890", "qwerty123",
  "password1", "iloveyou", "sunshine1", "princess1", "football1",
  "charlie1", "access14", "trustno1", "passw0rd", "master123",
  "welcome1", "monkey123", "dragon12", "letmein1", "abc12345",
]);

/**
 * Validate password strength.
 * @param   {string} password
 * @returns {string|null} Error message, or null if valid.
 */
function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (password.length > 128) {
    return "Password is too long.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter.";
  }
  if (!/[a-z]/.test(password)) {
    return "Password must contain at least one lowercase letter.";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one digit.";
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return "Password must contain at least one special character.";
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return "This password is too common. Please choose a stronger one.";
  }
  return null;
}

/**
 * Ensure the user belongs to at least one workspace, creating a personal
 * workspace if needed.  Called from every auth path (login, OAuth) so no
 * user can end up without a workspace.
 *
 * @param {Object} user — User row from the database.
 */
function ensureUserWorkspace(user) {
  const existing = workspaceRepo.getByUserId(user.id);
  if (existing && existing.length > 0) return;
  const slug = `${(user.name || "user").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  workspaceRepo.create({ name: `${user.name || "My"}'s Workspace`, slug, ownerId: user.id });
}


// ─── SEC-004: TOTP / MFA helpers ─────────────────────────────────────────────
//
// In-memory pending-login store. Keyed by an opaque base64url token returned
// to the client when password verification succeeds but MFA is still required.
// Consumed by POST /mfa/verify in exchange for the auth cookie.
//
// Tokens are single-use and expire after MFA_LOGIN_TTL_MS. A periodic sweep
// removes expired entries so an abandoned MFA flow cannot accumulate memory
// indefinitely. For multi-replica deployments this Map should move to Redis;
// tracked under SEC-004c as a follow-up.
const mfaPendingLogins = new Map();
const MFA_LOGIN_TTL_MS = parseInt(process.env.MFA_PENDING_TTL_MS ?? "", 10) || 5 * 60 * 1000;

const _mfaPurgeInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mfaPendingLogins) {
    if (v.expiresAt < now) mfaPendingLogins.delete(k);
  }
}, 5 * 60 * 1000);
_mfaPurgeInterval.unref();

/**
 * Decode a base32-encoded TOTP secret to its raw byte buffer (RFC 4648).
 * Tolerant of whitespace, lowercase, and trailing `=` padding.
 * @param {string} input
 * @returns {Buffer}
 * @private
 */
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "").toUpperCase().replace(/=+$/g, "").replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of clean) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
/**
 * Generate a fresh 160-bit (32-char base32) TOTP secret. Matches RFC 6238 /
 * Google Authenticator defaults so any standard authenticator app interops.
 * @returns {string}
 * @private
 */
function generateTotpSecret() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = crypto.randomBytes(20);
  let out = "";
  let bits = 0; let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Compute the RFC 6238 TOTP code for a given base32 secret at a given step
 * counter. Single source of truth for both the production `verifyTotp` loop
 * and the test helper `generateTotpCode` — so any algorithm change
 * (SHA-256, different digit count, different period) breaks tests
 * immediately rather than silently letting production drift.
 *
 * @param {string} secret      - Base32 TOTP secret.
 * @param {number} stepCounter - 30-second step counter (`floor(unixSeconds / 30)`).
 * @returns {string} Zero-padded 6-digit code.
 * @private
 */
function computeTotpAtStep(secret, stepCounter) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(stepCounter));
  const hmac = crypto.createHmac("sha1", key).update(counter).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/**
 * Internal cross-module helper — exposes the TOTP code generator so the test
 * suite (`backend/tests/helpers/test-base.js`) can produce valid codes
 * without re-implementing base32-decode + HMAC. Keeping this in production
 * code means any algorithm drift (SHA-256, 8-digit, etc.) is reflected in
 * tests on the same commit. Underscore prefix marks it as not part of the
 * public API contract.
 *
 * @param {string} secret           - Base32 TOTP secret.
 * @param {number} [offsetSteps=0]  - Step offset from `now` (clock-skew tests).
 * @returns {string} 6-digit code.
 */
export function _internalGenerateTotpCode(secret, offsetSteps = 0) {
  const step = 30;
  const now = Math.floor(Date.now() / 1000 / step);
  return computeTotpAtStep(secret, now + offsetSteps);
}

/**
 * Verify a 6-digit TOTP code against a base32 secret. Allows ±`window` steps
 * (default 30s each) of clock skew either side of `now`. Configurable via the
 * `MFA_TOTP_WINDOW` env var (default 1 = ±30s tolerance).
 *
 * Constant-time: iterates every candidate window even after a match and uses
 * `crypto.timingSafeEqual` for the digit comparison so total runtime does not
 * leak which window (or whether any) matched.
 *
 * @param {string} token  - User-supplied 6-digit code.
 * @param {string} secret - Base32 TOTP secret.
 * @param {number} [window]
 * @returns {boolean}
 * @private
 */
function verifyTotp(token, secret, window) {
  const w = Number.isFinite(window) ? window : (parseInt(process.env.MFA_TOTP_WINDOW ?? "1", 10) || 1);
  const t = String(token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(t)) return false;
  const step = 30;
  const now = Math.floor(Date.now() / 1000 / step);
  const tBuf = Buffer.from(t);
  let matched = false;
  for (let i = -w; i <= w; i++) {
    const computed = computeTotpAtStep(secret, now + i);
    try {
      if (crypto.timingSafeEqual(Buffer.from(computed), tBuf)) matched = true;
    } catch { /* length mismatch — t validated as /^\d{6}$/ above so unreachable */ }
  }
  return matched;
}

/**
 * SHA-256 hash a recovery code for storage. Recovery codes are user-facing
 * secrets — never persist the raw form.
 * @param {string} code
 * @returns {string} 64-char hex digest.
 * @private
 */
function hashRecoveryCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

/**
 * Constant-time scan for a hashed recovery code in a list (SEC-004 §5b).
 * `indexOf` short-circuits on first match and leaks via timing which slot
 * matched. This iterates every entry regardless of outcome and only records
 * the first match.
 *
 * @param {string[]} codes  - Pre-hashed recovery codes (hex strings).
 * @param {string}   target - Pre-hashed candidate (hex string).
 * @returns {number} Index of the match, or -1.
 * @private
 */
function findRecoveryCodeIndex(codes, target) {
  let matchIdx = -1;
  const targetBuf = Buffer.from(target);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (typeof code !== "string" || code.length !== target.length) continue;
    try {
      if (crypto.timingSafeEqual(Buffer.from(code), targetBuf) && matchIdx < 0) {
        matchIdx = i;
      }
    } catch { /* length mismatch filtered above — unreachable */ }
  }
  return matchIdx;
}

/**
 * Mint a fresh set of MFA recovery codes. Returns both the raw codes (shown
 * to the user once) and their SHA-256 hashes (persisted to the DB).
 * Count is configurable via `MFA_RECOVERY_CODES_COUNT` (default 8).
 * @returns {{ raw: string[], hashed: string[] }}
 * @private
 */
function mintRecoveryCodes() {
  const count = Math.max(1, parseInt(process.env.MFA_RECOVERY_CODES_COUNT ?? "8", 10) || 8);
  const raw = Array.from({ length: count }, () => crypto.randomBytes(4).toString("hex"));
  return { raw, hashed: raw.map(hashRecoveryCode) };
}

/**
 * Issue a single-use pending-MFA token after password verification succeeds.
 * Exchanged at `POST /mfa/verify` for the auth cookie.
 *
 * The `workspaceId` is snapshotted here so subsequent `auth.mfa.*` audit log
 * entries can attribute the event to a workspace — without it, the rows are
 * persisted with `workspaceId = NULL` and disappear from the workspace-scoped
 * activity view that admins rely on for security monitoring.
 *
 * @param {string} userId
 * @param {string} [workspaceId] - Resolved active workspace at login time.
 * @returns {string} Opaque base64url token (24 bytes of entropy).
 * @private
 */
function createPendingMfaLogin(userId, workspaceId) {
  const token = crypto.randomBytes(24).toString("base64url");
  mfaPendingLogins.set(token, { userId, workspaceId, expiresAt: Date.now() + MFA_LOGIN_TTL_MS });
  return token;
}

/**
 * Atomically consume a pending-MFA token. Returns the entry on success and
 * deletes it (single-use). Returns null when missing, already consumed, or
 * expired.
 *
 * The optional `{ peek: true }` option returns the entry WITHOUT consuming
 * it — used by the WebAuthn flow's `/authenticate/options` endpoint, which
 * needs to look up the user before issuing a challenge but must leave the
 * token intact for the subsequent `/authenticate/verify` call.
 *
 * @param {string} token
 * @param {Object} [opts]
 * @param {boolean} [opts.peek]
 * @returns {{ userId: string, expiresAt: number } | null}
 * @private
 */
function consumePendingMfaLogin(token, opts) {
  const entry = mfaPendingLogins.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    mfaPendingLogins.delete(token);
    return null;
  }
  if (!opts?.peek) mfaPendingLogins.delete(token);
  return entry;
}

/**
 * Internal cross-module helper — exported so `routes/webauthn.js` can
 * consume / peek pending-MFA tokens issued by `/login` without duplicating
 * the in-memory store. Underscore prefix marks it as not part of the
 * public API contract.
 * @param {string} token
 * @param {Object} [opts]
 * @param {boolean} [opts.peek]
 * @returns {{ userId: string, expiresAt: number } | null}
 */
export function _internalConsumePendingMfaLogin(token, opts) {
  return consumePendingMfaLogin(token, opts);
}

/**
 * Internal cross-module helper — exported so `routes/webauthn.js` can reuse
 * the password-confirmation policy (OAuth-only users skip the password
 * check; everyone else must supply a matching password).
 * @param {Object} user
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function _internalVerifyAccountPassword(user, password) {
  return verifyAccountPassword(user, password);
}

/**
 * Internal cross-module helper — exposes the per-bucket rate limiter so the
 * WebAuthn router can apply the shared `webauthnVerify` bucket without
 * duplicating the limiter state.
 * @param {string} bucket
 * @param {string} ip
 * @returns {{ allowed: boolean, retryAfterSec: number }}
 */
export function _internalCheckRateLimit(bucket, ip) {
  return checkRateLimit(bucket, ip);
}

/**
 * SEC-004: Industry-standard "security-posture change → terminate session"
 * primitive. Revokes the current request's JTI and clears the auth cookies
 * so the caller is forced to re-authenticate immediately. Matches the
 * DELETE /account pattern and the behaviour of Auth0, Clerk, Okta, GitHub
 * on credential / MFA changes.
 *
 * Exported as an underscore-prefixed cross-module helper so
 * `routes/webauthn.js` can apply the same semantics on passkey removal
 * without duplicating the JTI-revoke + cookie-clear plumbing.
 *
 * @param {Object} req - Must carry `req.authUser` (the JWT payload).
 * @param {Object} res
 */
export function _internalRevokeCurrentSession(req, res, auditMeta) {
  const { jti, exp } = req.authUser || {};
  if (jti) revokedTokens.set(jti, exp);
  clearAuthCookies(res);
  // SEC-007: emit `auth.session.revoke` so every server-initiated session
  // termination (MFA disable, recovery-code regeneration, passkey removal,
  // etc.) lands in the compliance audit log alongside login/logout events.
  // The `reason` in `auditMeta` lets reviewers distinguish posture-change
  // revokes from explicit logouts.
  if (req?.authUser?.sub) {
    logActivity({
      type: "auth.session.revoke",
      req,
      userId: req.authUser.sub,
      userName: req.authUser.name || req.authUser.email || null,
      workspaceId: req.workspaceId || req.authUser.workspaceId || null,
      meta: { jti: jti || null, ...(auditMeta || {}) },
    });
  }
}

/**
 * SEC-004: apply workspace MFA enforcement at the end of an auth flow.
 *
 * Centralises the three-way `evaluateMfaEnforcement(user)` outcome handling
 * that was previously duplicated across `/login`, `/github/callback`, and
 * `/google/callback`:
 *   - `block` → emit `auth.mfa.enrollment_required` activity, respond 403
 *     with `code: "MFA_ENROLLMENT_REQUIRED"`, return `true` (caller must stop)
 *   - `grace` → set `X-MFA-Grace-Period-Days-Remaining` + `X-MFA-Grace-Ends-At`
 *     headers, return `false` (caller proceeds with cookie issue)
 *   - `allow` → no-op, return `false`
 *
 * @param {Object} req  - SEC-007: forwarded to `logActivity` so the
 *   `auth.mfa.enrollment_required` row captures `ipAddress` + `userAgent`.
 *   Without it the row lands with both columns NULL, breaking SOC-2
 *   session-reconstruction evidence.
 * @param {Object} res
 * @param {Object} user
 * @param {Object} auditMeta - Forwarded into the activity `meta` field
 *   (e.g. `{ method: "password" }`, `{ method: "oauth", provider: "github" }`).
 * @param {string} auditDetail - Human-readable detail for the activity row.
 * @returns {boolean} `true` when the request was already terminated with 403.
 * @private
 */
function applyMfaEnforcement(req, res, user, auditMeta, auditDetail) {
  const enforcement = evaluateMfaEnforcement(user);
  if (enforcement.state === "block") {
    logActivity({
      type: "auth.mfa.enrollment_required",
      req,
      detail: auditDetail,
      userId: user.id, userName: user.name || user.email,
      workspaceId: enforcement.workspaceId,
      meta: auditMeta,
    });
    res.status(403).json({
      error: "Your workspace requires multi-factor authentication. Enroll before signing in.",
      code: "MFA_ENROLLMENT_REQUIRED",
      workspaceId: enforcement.workspaceId,
      workspaceName: enforcement.workspaceName,
    });
    return true;
  }
  if (enforcement.state === "grace") {
    res.setHeader("X-MFA-Grace-Period-Days-Remaining", String(enforcement.gracePeriodDaysRemaining));
    res.setHeader("X-MFA-Grace-Ends-At", enforcement.graceEndsAt);
  }
  return false;
}
// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Register a new user with email and password.
 *
 * @route POST /api/v1/auth/register
 * @param {Object} req.body
 * @param {string} req.body.name     - Full name (max 100 chars).
 * @param {string} req.body.email    - Email address (max 254 chars).
 * @param {string} req.body.password - Password (8–128 chars).
 * @returns {201} `{ message }` on success.
 * @returns {400} Validation error.
 * @returns {409} Email already exists.
 */
router.post("/register", async (req, res) => {
  try {
    const name     = sanitiseString(req.body.name, 100);
    const email    = sanitiseString(req.body.email, 254).toLowerCase();
    const password = req.body.password;

    if (!name)                       return res.status(400).json({ error: "Name is required." });
    if (!isValidEmail(email))        return res.status(400).json({ error: "A valid email address is required." });
    const pwErr = validatePasswordStrength(password);
    if (pwErr)                       return res.status(400).json({ error: pwErr });

    const existing = userRepo.getByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const id           = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const now          = new Date().toISOString();

    // SEC-001: New users are created with emailVerified = 0 (false).
    // They must verify their email before they can log in.
    // SKIP_EMAIL_VERIFICATION=true bypasses this for dev/CI environments.
    const skipVerification = process.env.SKIP_EMAIL_VERIFICATION === "true";

    // Set emailVerified atomically at creation time — no separate UPDATE needed.
    // This prevents a window where the user exists with emailVerified=1 if the
    // update were to fail after the INSERT.
    const user = { id, name, email, passwordHash, role: "user", emailVerified: skipVerification ? 1 : 0, createdAt: now, updatedAt: now };
    userRepo.create(user);

    if (skipVerification) {
      // Auto-verify: dev/CI mode — no email required
      return res.status(201).json({ message: "Account created successfully." });
    }

    // Generate and send verification email
    const verifyToken = crypto.randomBytes(32).toString("base64url");
    const tokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
    try {
      verificationTokenRepo.create(verifyToken, id, email, tokenExpiresAt);
      await sendVerificationEmail(email, verifyToken, name);
    } catch (emailErr) {
      // Non-fatal: account is created, user can request a resend.
      console.error(formatLogLine("error", null, `[auth/register] Failed to send verification email: ${emailErr.message}`));
    }

    return res.status(201).json({
      message: "Account created. Please check your email to verify your account.",
      requiresVerification: true,
    });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/register] ${err.message}`));
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

/**
 * Sign in with email and password. Sets auth cookies and returns user profile.
 * Rate-limited to 10 attempts per IP per 15 minutes.
 *
 * @route POST /api/v1/auth/login
 * @param {Object} req.body
 * @param {string} req.body.email    - Email address.
 * @param {string} req.body.password - Password.
 * @returns {200} `{ user: { id, name, email, role, avatar, workspaceId, workspaceName, workspaceRole } }`.
 * @returns {400} Invalid input.
 * @returns {401} Wrong credentials.
 * @returns {403} Email not verified.
 * @returns {429} Rate limit exceeded (`Retry-After` header set).
 */
router.post("/login", async (req, res) => {
  const ip = req.ip || "unknown";
  const rate = checkRateLimit("login", ip);
  if (!rate.allowed) {
    res.setHeader("Retry-After", rate.retryAfterSec);
    return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${Math.ceil(rate.retryAfterSec / 60)} minutes.` });
  }

  try {
    const email    = sanitiseString(req.body.email, 254).toLowerCase();
    const password = req.body.password;

    if (!isValidEmail(email) || typeof password !== "string") {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    const user = userRepo.getByEmail(email);

    // Always run verifyPassword (even on non-existent user) to prevent timing attacks
    const dummyHash = "00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    const valid = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, dummyHash).catch(() => false);

    if (!user || !valid) {
      // SEC-007: route the failed-login row so it's reachable from an admin
      // UI, never `workspaceId: null` (which is invisible to every scoped
      // query). Three cases:
      //   1. Known email → snapshot the user's primary workspace; the row
      //      appears in that workspace's audit log.
      //   2. Unknown email (credential-stuffing probe) → tag with the
      //      `SYSTEM_WORKSPACE_ID` sentinel so admins can list it via
      //      `GET /api/v1/system/security-events`. The sentinel is a fixed
      //      string that can never collide with a real workspace UUID, so
      //      the row cannot leak into any tenant's workspace-scoped view.
      //   3. Empty-string email → treat as case 2 for safety.
      const failedWorkspaceId = user
        ? workspaceRepo.getByUserId(user.id)?.[0]?.id || SYSTEM_WORKSPACE_ID
        : SYSTEM_WORKSPACE_ID;
      logActivity({ type: "auth.login.failed", req, userId: user?.id || null, userName: user?.name || email || null, workspaceId: failedWorkspaceId });
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // SEC-001: Block login for unverified email accounts.
    // emailVerified defaults to 1 for existing/OAuth users (migration 003),
    // so only new email/password registrations are affected.
    if (user.emailVerified === 0) {
      return res.status(403).json({
        error: "Please verify your email address before signing in.",
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
    }

    // ACL-001: Ensure the user has a workspace before issuing a token.
    ensureUserWorkspace(user);

    // SEC-004: MFA challenge — issue a pendingToken if EITHER a TOTP secret
    // is configured OR the user has registered WebAuthn credentials. The
    // frontend uses the `methods` map to render a factor picker.
    const hasTotp = user.mfaEnabled === 1 && !!user.mfaSecret;
    const webauthnCount = webauthnRepo.countByUser(user.id);
    if (hasTotp || webauthnCount > 0) {
      // Snapshot the active workspace into the pending entry so /mfa/verify
      // can attribute audit-log rows. ensureUserWorkspace() above guarantees
      // at least one membership exists.
      const memberships = workspaceRepo.getByUserId(user.id);
      const activeWorkspaceId = memberships?.[0]?.id;
      const pendingToken = createPendingMfaLogin(user.id, activeWorkspaceId);
      return res.status(200).json({
        mfaRequired: true,
        pendingToken,
        methods: { totp: hasTotp, webauthn: webauthnCount > 0 },
      });
    }

    // SEC-004: per-workspace MFA enforcement (block past grace, banner within).
    if (applyMfaEnforcement(req, res, user, { method: "password" }, "Login blocked: workspace requires MFA.")) return;

    // SEC-004 §5c: tag password-only sessions with amr=["pwd"] so future
    // step-up auth checks can require MFA-asserted sessions explicitly.
    const payload = buildJwtPayload(user, undefined, { amr: ["pwd"] });
    const token = signJwt(payload, getJwtSecret());
    const exp   = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;

    setAuthCookie(res, token, exp);
    logActivity({ type: "auth.login", req, userId: user.id, userName: user.name || user.email, workspaceId: payload.workspaceId });

    return res.json({ user: buildUserResponse(user) });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/login] ${err.message}`));
    return res.status(500).json({ error: "Sign-in failed. Please try again." });
  }
});

/**
 * Sign out — revokes the JWT server-side so it can't be reused.
 * Requires `Authorization: Bearer <token>`.
 *
 * @route POST /api/v1/auth/logout
 * @returns {200} `{ message: "Signed out successfully." }`.
 * @returns {401} Missing or invalid token.
 */
router.post("/logout", requireAuth, (req, res) => {
  const { jti, exp } = req.authUser;
  if (jti) revokedTokens.set(jti, exp);
  logActivity({ type: "auth.logout", req, userId: req.authUser.sub, userName: req.authUser.name || null, workspaceId: req.workspaceId || req.authUser.workspaceId || null });
  clearAuthCookies(res);
  return res.json({ message: "Signed out successfully." });
});

/**
 * Get the currently authenticated user's profile with workspace context.
 *
 * @route GET /api/v1/auth/me
 * @returns {200} `{ id, name, email, role, avatar, createdAt, workspaceId, workspaceName, workspaceRole }`.
 * @returns {401} Missing or invalid token.
 * @returns {404} User not found in database.
 */
router.get("/me", requireAuth, (req, res) => {
  const user = userRepo.getById(req.authUser.sub);
  if (!user) return res.status(404).json({ error: "User not found." });
  return res.json({ ...buildUserResponse(user, req.authUser.workspaceId), createdAt: user.createdAt });
});

// ─── Account export / deletion (SEC-003) ─────────────────────────────────────

/**
 * Check whether a user registered via OAuth only (no password set).
 *
 * @param {Object} user
 * @returns {boolean}
 */
function isOAuthOnlyUser(user) {
  return !user?.passwordHash;
}

/**
 * Verify the authenticated user's password for sensitive account actions.
 * For OAuth-only users (no passwordHash), password verification is skipped
 * — the OAuth session itself serves as proof of identity.
 *
 * @param {Object} user
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function verifyAccountPassword(user, password) {
  if (isOAuthOnlyUser(user)) return true;
  if (typeof password !== "string" || !password) return false;
  return verifyPassword(password, user.passwordHash);
}

/**
 * Export all user-owned account data as JSON (GDPR/CCPA data portability).
 * Requires password confirmation via `x-account-password` header.
 *
 * @route GET /api/v1/auth/export
 * @returns {200} JSON export payload.
 * @returns {400} Missing password.
 * @returns {403} Invalid password.
 */
router.get("/export", requireAuth, async (req, res) => {
  const user = userRepo.getById(req.authUser.sub);
  if (!user) return res.status(404).json({ error: "User not found." });

  // OAuth-only users have no password — skip confirmation (session is proof).
  if (!isOAuthOnlyUser(user)) {
    const password = req.headers["x-account-password"];
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Password confirmation is required." });
    }
    const valid = await verifyAccountPassword(user, password);
    if (!valid) {
      return res.status(403).json({ error: "Password confirmation failed." });
    }
  }

  const data = accountRepo.buildAccountExport(user.id);
  return res.json(data);
});

/**
 * Delete account and all user-owned workspace data (GDPR right to erasure).
 * Requires password confirmation.
 *
 * @route DELETE /api/v1/auth/account
 * @param {Object} req.body
 * @param {string} req.body.password - Account password confirmation.
 * @returns {200} `{ ok: true }` on success.
 */
router.delete("/account", requireAuth, async (req, res) => {
  const user = userRepo.getById(req.authUser.sub);
  if (!user) return res.status(404).json({ error: "User not found." });

  // OAuth-only users have no password — skip confirmation (session is proof).
  if (!isOAuthOnlyUser(user)) {
    const password = req.body?.password;
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Password confirmation is required." });
    }
    const valid = await verifyAccountPassword(user, password);
    if (!valid) {
      return res.status(403).json({ error: "Password confirmation failed." });
    }
  }

  // Collect owned project IDs before deletion so we can stop their in-memory
  // cron tasks afterwards. deleteAccount() removes the DB rows but cannot
  // reach the process-local scheduler task Map.
  const ownedWsIds = workspaceRepo.getOwnedWorkspaceIds(user.id);
  const ownedProjectIds = ownedWsIds.flatMap(wsId => projectRepo.getAllIncludeDeleted(wsId).map(p => p.id));

  try {
    accountRepo.deleteAccount(user.id);
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/account] Delete failed for user ${user.id}: ${err.message}`));
    return res.status(500).json({ error: "Failed to delete account." });
  }

  // Stop in-memory cron tasks for deleted projects (no-op if no schedule existed).
  for (const projectId of ownedProjectIds) {
    stopSchedule(projectId);
  }

  // Revoke the current JWT so it cannot be reused from another tab or replay.
  const { jti, exp } = req.authUser;
  if (jti) revokedTokens.set(jti, exp);
  clearAuthCookies(res);
  return res.json({ ok: true, message: "Account and owned data deleted." });
});

/**
 * Refresh the session — issue a new JWT and reset the cookie TTL.
 * Called proactively by the frontend 5 minutes before expiry so users
 * never get silently logged out mid-session.
 *
 * The existing token must still be valid (not expired, not revoked).
 * The old JTI is revoked and a new one is issued.
 *
 * @route POST /api/v1/auth/refresh
 * @returns {200} `{ user }` — same shape as login response.
 * @returns {401} If the current session is invalid or expired.
 */
router.post("/refresh", requireAuth, (req, res) => {
  const user = userRepo.getById(req.authUser.sub);
  if (!user) return res.status(401).json({ error: "User not found." });

  // SEC-004 §7: re-check workspace MFA enforcement on every refresh so a
  // policy change mid-session (admin enables mfaRequired with grace=0) is
  // enforced within one refresh cycle (~8h) rather than never. Without this,
  // a user whose session pre-dates the policy change stays logged in
  // indefinitely via the automatic refresh loop.
  //
  // ORDERING: enforcement check MUST run BEFORE revoking the old token —
  // otherwise a 403 `MFA_ENROLLMENT_REQUIRED` response leaves a revoked JTI
  // in the cookie jar, and every subsequent authenticated request fails with
  // a generic 401 "Session expired" instead of the actionable 403 the
  // frontend uses to render the MFA enrollment panel. Mirrors the ordering
  // in `/workspaces/switch` at routes/workspaces.js:152-170.
  if (applyMfaEnforcement(req, res, user, { method: "refresh" }, "Session refresh blocked: workspace requires MFA.")) return;

  // Revoke the old token only after enforcement passes
  const { jti: oldJti, exp: oldExp } = req.authUser;
  if (oldJti) revokedTokens.set(oldJti, oldExp);

  // Issue a fresh token with a new JTI (includes updated workspace context).
  // SEC-004 §5c: forward the existing `amr` claim so an MFA-asserted session
  // (`["pwd","mfa"]`) stays MFA-asserted after the 8-hour refresh cycle.
  // Without this, every refresh would silently downgrade the session to
  // password-only, breaking any future step-up-auth check that requires
  // `amr.includes("mfa")`.
  const payload = buildJwtPayload(user, req.authUser.workspaceId, { amr: req.authUser.amr });
  const token = signJwt(payload, getJwtSecret());
  const exp   = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;
  setAuthCookie(res, token, exp);

  return res.json({ user: buildUserResponse(user, req.authUser.workspaceId) });
});

// ─── Email Verification (SEC-001) ────────────────────────────────────────────

/**
 * Verify a user's email address using a signed token.
 * Called when the user clicks the verification link in their email.
 *
 * @route GET /api/v1/auth/verify
 * @param {string} req.query.token - The verification token from the email.
 * @returns {200} `{ message, verified: true }` on success.
 * @returns {400} Invalid, expired, or already-used token.
 */
router.get("/verify", async (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Verification token is required." });
  }

  let entry;
  try {
    entry = verificationTokenRepo.claim(token);
  } catch (dbErr) {
    console.error(formatLogLine("error", null, `[auth/verify] DB error: ${dbErr.message}`));
    return res.status(500).json({ error: "Server error. Please try again." });
  }

  if (!entry) {
    return res.status(400).json({ error: "Invalid or expired verification link. Please request a new one." });
  }

  const user = userRepo.getById(entry.userId);
  if (!user) {
    return res.status(400).json({ error: "Account not found." });
  }

  // Mark user as verified
  userRepo.update(user.id, { emailVerified: 1, updatedAt: new Date().toISOString() });

  // Clean up any remaining unused tokens for this user
  try {
    verificationTokenRepo.deleteUnusedByUserId(entry.userId);
  } catch (dbErr) {
    console.error(formatLogLine("error", null, `[auth/verify] Token cleanup error: ${dbErr.message}`));
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(formatLogLine("info", null, `[auth/verify] Email verified for ${user.email}`));
  }

  return res.json({ message: "Email verified successfully. You can now sign in.", verified: true });
});

/**
 * Resend the verification email for an unverified account.
 * Rate-limited to prevent abuse.
 *
 * @route POST /api/v1/auth/resend-verification
 * @param {Object} req.body
 * @param {string} req.body.email - Email address of the unverified account.
 * @returns {200} `{ message }` — always returns success to prevent enumeration.
 */
router.post("/resend-verification", async (req, res) => {
  const ip = req.ip || "unknown";
  const rate = checkRateLimit("forgotPassword", ip); // reuse the same bucket
  if (!rate.allowed) {
    res.setHeader("Retry-After", rate.retryAfterSec);
    return res.status(429).json({ error: `Too many requests. Try again in ${Math.ceil(rate.retryAfterSec / 60)} minutes.` });
  }

  const email = sanitiseString(req.body.email, 254).toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  const genericMsg = "If an unverified account with that email exists, a verification link has been sent.";

  const user = userRepo.getByEmail(email);
  if (!user || user.emailVerified !== 0) {
    // No account or already verified — silently succeed to prevent enumeration
    return res.json({ message: genericMsg });
  }

  const verifyToken = crypto.randomBytes(32).toString("base64url");
  const tokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
  try {
    verificationTokenRepo.create(verifyToken, user.id, email, tokenExpiresAt);
    await sendVerificationEmail(email, verifyToken, user.name);
  } catch (emailErr) {
    console.error(formatLogLine("error", null, `[auth/resend-verification] Failed to send: ${emailErr.message}`));
    return res.status(500).json({ error: "Failed to send verification email. Please try again." });
  }

  return res.json({ message: genericMsg });
});

// ─── Password Reset ──────────────────────────────────────────────────────────

/**
 * Request a password reset. Generates a time-limited token.
 * In production this would send an email; in dev the token is returned
 * in the response and logged to console for convenience.
 *
 * Always returns 200 regardless of whether the email exists to prevent
 * user enumeration.
 *
 * @route POST /api/v1/auth/forgot-password
 * @param {Object} req.body
 * @param {string} req.body.email - Email address of the account.
 * @returns {200} `{ message, ...(dev: resetToken, resetUrl) }`.
 */
router.post("/forgot-password", async (req, res) => {
  // Rate-limit to prevent token-flooding DoS (fills memory with reset tokens)
  const ip = req.ip || "unknown";
  const rate = checkRateLimit("forgotPassword", ip);
  if (!rate.allowed) {
    res.setHeader("Retry-After", rate.retryAfterSec);
    return res.status(429).json({ error: `Too many requests. Try again in ${Math.ceil(rate.retryAfterSec / 60)} minutes.` });
  }

  const email = sanitiseString(req.body.email, 254).toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "A valid email address is required." });
  }

  const user = userRepo.getByEmail(email);

  // Always return success to prevent user enumeration
  const genericMsg = "If an account with that email exists, a password reset link has been generated.";

  if (!user || !user.passwordHash) {
    // No account or OAuth-only account — silently succeed
    return res.json({ message: genericMsg });
  }

  // Generate a cryptographically random reset token and persist it to the DB.
  // Storing tokens in the DB (migration 003) means they survive server restarts
  // and work correctly across multiple API instances.
  const resetToken = crypto.randomBytes(32).toString("base64url");
  const tokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  try {
    // Invalidate any existing unused tokens for this user before creating a new one
    resetTokenRepo.create(resetToken, user.id, tokenExpiresAt);
  } catch (dbErr) {
    console.error(formatLogLine("error", null, `[auth/forgot-password] DB error: ${dbErr.message}`));
    return res.status(500).json({ error: "Failed to generate reset token. Please try again." });
  }

  // In production: send email with resetUrl. For now, log + return in dev.
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const baseUrl = (process.env.APP_BASE_PATH || "/").replace(/\/$/, "");
  const resetUrl = `${appUrl}${baseUrl}/forgot-password?token=${resetToken}`;

  if (process.env.NODE_ENV !== "production") {
    console.log(`[auth/forgot-password] Reset token for ${email}: ${resetToken}`);
    console.log(`[auth/forgot-password] Reset URL: ${resetUrl}`);
  }

  const response = { message: genericMsg };
  // Only expose the token in the response when explicitly opted-in.
  // Using NODE_ENV!=="production" was unsafe: staging servers without the flag
  // set would leak live reset tokens to any caller. ENABLE_DEV_RESET_TOKENS
  // must be deliberately set — absence of a production flag is not sufficient.
  if (process.env.ENABLE_DEV_RESET_TOKENS === "true") {
    response.resetToken = resetToken;
    response.resetUrl = resetUrl;
  }

  return res.json(response);
});

/**
 * Reset password using a valid reset token.
 *
 * @route POST /api/v1/auth/reset-password
 * @param {Object} req.body
 * @param {string} req.body.token       - The reset token from the email/URL.
 * @param {string} req.body.newPassword - New password (8–128 chars).
 * @returns {200} `{ message }` on success.
 * @returns {400} Invalid token, expired, or validation error.
 */
router.post("/reset-password", async (req, res) => {
  // Rate-limit to prevent brute-force token guessing
  const ip = req.ip || "unknown";
  const rate = checkRateLimit("resetPassword", ip);
  if (!rate.allowed) {
    res.setHeader("Retry-After", rate.retryAfterSec);
    return res.status(429).json({ error: `Too many requests. Try again in ${Math.ceil(rate.retryAfterSec / 60)} minutes.` });
  }

  const { token, newPassword } = req.body;

  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "Reset token is required." });
  }
  const pwErr = validatePasswordStrength(newPassword);
  if (pwErr) {
    return res.status(400).json({ error: pwErr });
  }

  // Atomically claim the token — marks it as used in a single UPDATE so two
  // concurrent requests with the same token cannot both succeed (TOCTOU fix).
  let entry;
  try {
    entry = resetTokenRepo.claim(token);
  } catch (dbErr) {
    console.error(formatLogLine("error", null, `[auth/reset-password] DB error: ${dbErr.message}`));
    return res.status(500).json({ error: "Server error. Please try again." });
  }

  if (!entry) {
    return res.status(400).json({ error: "Invalid or expired reset token. Please request a new one." });
  }

  const user = userRepo.getById(entry.userId);
  if (!user) {
    return res.status(400).json({ error: "Account not found." });
  }

  // Update password
  const newHash = await hashPassword(newPassword);
  userRepo.update(user.id, { passwordHash: newHash, updatedAt: new Date().toISOString() });

  // Invalidate all other unused tokens for this user so old reset links
  // cannot be replayed. The current token is already marked as used by claim().
  try {
    resetTokenRepo.deleteUnusedByUserId(entry.userId);
  } catch (dbErr) {
    // Non-fatal — password was already changed; just log the cleanup failure.
    console.error(formatLogLine("error", null, `[auth/reset-password] Token cleanup error: ${dbErr.message}`));
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[auth/reset-password] Password reset for ${user.email}`);
  }

  // SEC-007: `/reset-password` is a public endpoint so `req.workspaceId` is
  // unset. Resolve the user's primary workspace from their membership (same
  // pattern as the MFA pending-login flow above) so the reset event is
  // visible in the workspace-scoped audit log rather than orphaned with
  // `workspaceId = NULL`.
  const resetWorkspaceId = req.workspaceId || workspaceRepo.getByUserId(user.id)?.[0]?.id || null;
  logActivity({ type: "auth.password.reset", req, userId: user.id, userName: user.name || user.email, workspaceId: resetWorkspaceId });
  return res.json({ message: "Password has been reset successfully. You can now sign in." });
});

// ─── GitHub OAuth ─────────────────────────────────────────────────────────────

/**
 * GitHub OAuth callback. Exchanges an authorization code for an access token,
 * fetches the user profile, sets auth cookies, and returns the user profile.
 *
 * @route GET /api/v1/auth/github/callback
 * @param {string} req.query.code - The OAuth authorization code from GitHub.
 * @returns {200} `{ user: { id, name, email, role, avatar, workspaceId, workspaceName, workspaceRole } }`.
 * @returns {400} Missing code parameter.
 * @returns {401} Token exchange or profile fetch failed.
 * @returns {503} GitHub OAuth not configured on this server.
 */
router.get("/github/callback", async (req, res) => {
  const code  = req.query.code;
  if (!code) return res.status(400).json({ error: "Missing code parameter." });

  const clientId     = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({ error: "GitHub OAuth is not configured on this server." });
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      throw new Error(tokenData.error_description || "GitHub token exchange failed.");
    }

    // Fetch user profile
    const profileRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "Sentri-App" },
    });
    const profile = await profileRes.json();

    // Fetch primary email if not public
    let email = profile.email;
    if (!email) {
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "Sentri-App" },
      });
      const emails = await emailsRes.json();
      email = emails.find(e => e.primary && e.verified)?.email || emails[0]?.email;
    }
    if (!email) throw new Error("Could not retrieve a verified email from GitHub.");

    const user = await findOrCreateOAuthUser({
      provider: "github",
      providerId: String(profile.id),
      email: email.toLowerCase(),
      name: profile.name || profile.login,
      avatar: profile.avatar_url || null,
    });

    ensureUserWorkspace(user);

    // SEC-004: enforcement applies to OAuth too. OAuth-only users have no
    // password but still need MFA when the workspace policy demands it.
    if (applyMfaEnforcement(req, res, user, { method: "oauth", provider: "github" }, "OAuth login blocked: workspace requires MFA.")) return;

    // SEC-004 §5c: OAuth sessions are tagged amr=["oauth"]. They are NOT
    // MFA-asserted — workspace MFA enforcement applies above.
    const payload = buildJwtPayload(user, undefined, { amr: ["oauth"] });
    const token = signJwt(payload, getJwtSecret());
    const exp   = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;
    setAuthCookie(res, token, exp);
    logActivity({ type: "auth.login", req, userId: user.id, userName: user.name || user.email, workspaceId: payload.workspaceId });

    return res.json({ user: buildUserResponse(user) });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/github] ${err.message}`));
    return res.status(401).json({ error: err.message || "GitHub authentication failed." });
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────

/**
 * Google OAuth callback. Exchanges an authorization code for an access token,
 * fetches the user profile, sets auth cookies, and returns the user profile.
 *
 * @route GET /api/v1/auth/google/callback
 * @param {string} req.query.code - The OAuth authorization code from Google.
 * @returns {200} `{ user: { id, name, email, role, avatar, workspaceId, workspaceName, workspaceRole } }`.
 * @returns {400} Missing code parameter.
 * @returns {401} Token exchange or profile fetch failed.
 * @returns {503} Google OAuth not configured on this server.
 */
router.get("/google/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: "Missing code parameter." });

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_URL || "http://localhost:3000"}/login?provider=google`;

  if (!clientId || !clientSecret) {
    return res.status(503).json({ error: "Google OAuth is not configured on this server." });
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || "Google token exchange failed.");
    }

    // Fetch user info
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    if (!profile.email_verified) throw new Error("Google account email is not verified.");

    const user = await findOrCreateOAuthUser({
      provider: "google",
      providerId: profile.sub,
      email: profile.email.toLowerCase(),
      name: profile.name || profile.email.split("@")[0],
      avatar: profile.picture || null,
    });

    ensureUserWorkspace(user);

    // SEC-004: enforcement applies to OAuth too. OAuth-only users have no
    // password but still need MFA when the workspace policy demands it.
    if (applyMfaEnforcement(req, res, user, { method: "oauth", provider: "google" }, "OAuth login blocked: workspace requires MFA.")) return;

    // SEC-004 §5c: OAuth sessions are tagged amr=["oauth"]. They are NOT
    // MFA-asserted — workspace MFA enforcement applies above.
    const payload = buildJwtPayload(user, undefined, { amr: ["oauth"] });
    const token = signJwt(payload, getJwtSecret());
    const exp   = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;
    setAuthCookie(res, token, exp);
    logActivity({ type: "auth.login", req, userId: user.id, userName: user.name || user.email, workspaceId: payload.workspaceId });

    return res.json({ user: buildUserResponse(user) });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/google] ${err.message}`));
    return res.status(401).json({ error: err.message || "Google authentication failed." });
  }
});

// ─── Shared OAuth helper ──────────────────────────────────────────────────────

/**
 * Find an existing user by OAuth provider ID or email, or create a new one.
 * If a user with the same email exists (registered via a different provider),
 * the accounts are linked automatically.
 *
 * @param {Object} opts
 * @param {string} opts.provider   - OAuth provider name (e.g. `"github"`, `"google"`).
 * @param {string} opts.providerId - Provider-specific user ID.
 * @param {string} opts.email      - User's email (lowercased).
 * @param {string} opts.name       - Display name.
 * @param {string|null} opts.avatar - Avatar URL, or `null`.
 * @returns {Promise<User>}          The found or newly created user object.
 * @private
 */
async function findOrCreateOAuthUser({ provider, providerId, email, name, avatar }) {
  const key      = `${provider}:${providerId}`;
  let userId     = userRepo.getOAuthUserId(key);
  let user       = userId ? userRepo.getById(userId) : null;

  if (!user) {
    // Check if an account with this email exists (link providers)
    user = userRepo.getByEmail(email);
  }

  if (!user) {
    // Create new user
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    user      = { id, name, email, passwordHash: null, role: "user", avatar, createdAt: now, updatedAt: now };
    userRepo.create(user);
  }

  // Always keep OAuth provider link up to date
  userRepo.setOAuthLink(key, user.id);

  // SEC-001: If the user registered via email/password but hasn't verified yet,
  // auto-verify them now — the OAuth provider already verified the email.
  // This prevents the scenario where a user registers, then logs in via OAuth,
  // but can never use email/password login because emailVerified stays 0.
  const updates = {};
  if (user.emailVerified === 0) {
    updates.emailVerified = 1;
  }
  // Update avatar if missing
  if (!user.avatar && avatar) {
    updates.avatar = avatar;
    user.avatar = avatar;
  }
  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date().toISOString();
    userRepo.update(user.id, updates);
    if (updates.emailVerified) user.emailVerified = 1;
  }

  return user;
}


// ─── SEC-004: MFA management endpoints ───────────────────────────────────────

/**
 * Report whether the authenticated user has TOTP MFA enabled.
 * @route GET /api/v1/auth/mfa/status
 */
router.get("/mfa/status", requireAuth, (req, res) => {
  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });
    return res.json({ enabled: user.mfaEnabled === 1 });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/mfa/status] ${err.message}`));
    return res.status(500).json({ error: "Failed to fetch MFA status." });
  }
});

/**
 * Aggregate view of all second-factor state for the Settings UI — one
 * round trip instead of three (status + recovery count + passkey list).
 *
 * @route GET /api/v1/auth/mfa/factors
 * @returns {200} `{
 *   totp: boolean,
 *   recoveryCodesRemaining: number,
 *   webauthn: [{ id, deviceName, transports, createdAt, lastUsedAt }]
 * }`
 */
router.get("/mfa/factors", requireAuth, (req, res) => {
  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });

    let recoveryCodesRemaining = 0;
    if (user.mfaEnabled === 1 && user.mfaRecoveryCodes) {
      try {
        const codes = JSON.parse(user.mfaRecoveryCodes);
        if (Array.isArray(codes)) recoveryCodesRemaining = codes.length;
      } catch { /* malformed JSON — count as zero */ }
    }

    const credentials = webauthnRepo.listByUser(user.id).map((c) => ({
      id: c.id,
      deviceName: c.deviceName,
      transports: c.transports,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    }));

    return res.json({
      totp: user.mfaEnabled === 1,
      recoveryCodesRemaining,
      webauthn: credentials,
    });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/mfa/factors] ${err.message}`));
    return res.status(500).json({ error: "Failed to fetch MFA factors." });
  }
});

/**
 * Begin TOTP enrollment — generate a fresh secret + otpauth URL for the
 * user's authenticator app. The secret is encrypted at rest (AES-GCM via
 * `credentialEncryption.js`) and the user is NOT marked enabled until they
 * confirm a valid code via `/mfa/enable`.
 *
 * Refuses re-enrollment when MFA is already active (SEC-004 §2a) so a
 * stolen-cookie attacker cannot silently replace the legitimate user's
 * secret. Rate-limited (3 per IP per 15 min) to prevent secret-flooding.
 *
 * @route POST /api/v1/auth/mfa/enroll
 * @returns {200} `{ secret, otpauth }`
 * @returns {409} MFA already enabled.
 * @returns {429} Rate limit exceeded.
 */
router.post("/mfa/enroll", requireAuth, (req, res) => {
  const ip = req.ip || "unknown";
  const rate = checkRateLimit("mfaEnroll", ip);
  if (!rate.allowed) {
    res.setHeader("Retry-After", rate.retryAfterSec);
    return res.status(429).json({ error: `Too many enrollment attempts. Try again in ${Math.ceil(rate.retryAfterSec / 60)} minutes.` });
  }

  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.mfaEnabled === 1) {
      return res.status(409).json({ error: "MFA is already enabled. Disable it first to re-enroll." });
    }

    const secret = generateTotpSecret();
    const otpauth = `otpauth://totp/Sentri:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Sentri&algorithm=SHA1&digits=6&period=30`;
    userRepo.update(user.id, { mfaSecret: encryptString(secret), mfaEnabled: 0, updatedAt: new Date().toISOString() });

    logActivity({
      type: "auth.mfa.enroll_started",
      detail: "Started TOTP enrollment.",
      userId: user.id, userName: user.name || user.email,
      workspaceId: req.authUser.workspaceId,
      meta: { method: "totp" },
    });

    return res.json({ secret, otpauth });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/mfa/enroll] ${err.message}`));
    return res.status(500).json({ error: "Failed to start MFA enrollment." });
  }
});

/**
 * Finalize TOTP enrollment by verifying the user's first code. On success
 * marks MFA enabled and returns single-use recovery codes (shown once).
 *
 * @route POST /api/v1/auth/mfa/enable
 * @param {Object} req.body
 * @param {string} req.body.token - 6-digit code from authenticator app.
 * @returns {200} `{ ok: true, recoveryCodes }`
 * @returns {400} Enrollment not initialized or wrong code.
 */
router.post("/mfa/enable", requireAuth, (req, res) => {
  // SEC-004 §6: rate-limit the enable path — an attacker with a stolen session
  // cookie could brute-force the 6-digit TOTP space during enrollment (1M codes).
  // Reuse the mfaVerify bucket (5/15min) since the threat model is identical.
  const ip = req.ip || "unknown";
  const rate = checkRateLimit("mfaVerify", ip);
  if (!rate.allowed) {
    res.setHeader("Retry-After", rate.retryAfterSec);
    return res.status(429).json({ error: `Too many verification attempts. Try again in ${Math.ceil(rate.retryAfterSec / 60)} minutes.` });
  }

  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });
    // SEC-004 §2a: refuse to re-finalize when MFA is already on. Without
    // this, a stolen-cookie attacker (or even a confused legitimate user)
    // could call /enable a second time and silently replace the existing
    // recovery codes via mintRecoveryCodes() below — invalidating the codes
    // the user has already stored offline. /mfa/enroll has the same guard;
    // this is the symmetric check on the finalization step.
    if (user.mfaEnabled === 1) {
      return res.status(409).json({ error: "MFA is already enabled. Disable it first to re-enroll." });
    }
    const secret = decryptString(user.mfaSecret);
    if (!secret) return res.status(400).json({ error: "MFA enrollment is not initialized." });
    const token = sanitiseString(req.body?.token, 16).replace(/\s+/g, "");
    if (!verifyTotp(token, secret)) {
      logActivity({
        type: "auth.mfa.verify_failed",
        detail: "Invalid TOTP code during enable.",
        userId: user.id, userName: user.name || user.email,
        workspaceId: req.authUser.workspaceId,
        meta: { method: "totp", phase: "enable" },
      });
      return res.status(400).json({ error: "Invalid code." });
    }
    const recovery = mintRecoveryCodes();
    userRepo.update(user.id, { mfaEnabled: 1, mfaRecoveryCodes: JSON.stringify(recovery.hashed), updatedAt: new Date().toISOString() });

    logActivity({
      type: "auth.mfa.enabled",
      detail: "Enabled TOTP MFA.",
      userId: user.id, userName: user.name || user.email,
      workspaceId: req.authUser.workspaceId,
      meta: { method: "totp", recoveryCodesIssued: recovery.raw.length },
    });

    return res.json({ ok: true, recoveryCodes: recovery.raw });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/mfa/enable] ${err.message}`));
    return res.status(500).json({ error: "Failed to enable MFA." });
  }
});

/**
 * Verify the second factor during login. Accepts either a 6-digit TOTP code
 * or a single-use recovery code. On success, issues the auth cookie with an
 * MFA-asserted JWT (`amr: ["pwd","mfa"]`).
 *
 * Public route — authenticated by the `pendingToken` issued by `/login`.
 * Rate-limited per IP (5 attempts / 15 min) to bound brute force on the
 * 6-digit TOTP / recovery-code spaces. Recovery-code lookup uses a
 * constant-time scan (SEC-004 §5b) so timing does not leak which slot
 * matched.
 *
 * @route POST /api/v1/auth/mfa/verify
 * @param {Object} req.body
 * @param {string} req.body.pendingToken
 * @param {string} req.body.token
 * @returns {200} `{ user }`
 * @returns {400} Invalid code.
 * @returns {401} Pending token missing / expired.
 * @returns {429} Rate limit exceeded.
 */
router.post("/mfa/verify", async (req, res) => {
  const ip = req.ip || "unknown";
  const rate = checkRateLimit("mfaVerify", ip);
  if (!rate.allowed) {
    res.setHeader("Retry-After", rate.retryAfterSec);
    return res.status(429).json({ error: `Too many verification attempts. Try again in ${Math.ceil(rate.retryAfterSec / 60)} minutes.` });
  }

  try {
    // SEC-004: PEEK (don't consume) the pending token first so a wrong TOTP
    // or recovery code does not waste the user's MFA session. The token is
    // only consumed at the bottom of the success path. Matches the WebAuthn
    // flow at routes/webauthn.js: defer consume until verification passes,
    // letting the rate limiter (5/15min) absorb retries instead of forcing a
    // full re-login on every typo.
    const pendingTokenStr = sanitiseString(req.body?.pendingToken, 200);
    const pending = consumePendingMfaLogin(pendingTokenStr, { peek: true });
    if (!pending) return res.status(401).json({ error: "MFA session expired. Sign in again." });
    const user = userRepo.getById(pending.userId);
    // Return 401 (not 404) to avoid leaking whether the underlying user still
    // exists via a server-issued pendingToken. The token is short-lived so this
    // is low-severity, but defense-in-depth matches the expired-token path.
    if (!user) return res.status(401).json({ error: "MFA session expired. Sign in again." });
    const token = sanitiseString(req.body?.token, 16).replace(/\s+/g, "");

    // Attempt TOTP verification only when the secret is decryptable.
    // If the secret is corrupted / key-rotated, skip TOTP but still allow
    // the recovery-code path below — that's the entire purpose of recovery
    // codes (they're SHA-256 hashed independently of the AES-encrypted secret).
    const secret = decryptString(user.mfaSecret);
    let ok = false;
    let method = null;
    let updatedRecovery = null;
    let remaining = null;

    if (secret && token) {
      ok = verifyTotp(token, secret);
      if (ok) method = "totp";
    }

    if (!ok && token) {
      // Recovery-code path: constant-time scan to avoid leaking which slot
      // matched via the difference between Array.indexOf early-exit and full
      // scan timings.
      //
      // Normalise the candidate to lowercase before hashing. `mintRecoveryCodes`
      // emits lowercase hex (`crypto.randomBytes(4).toString("hex")`) but mobile
      // keyboards frequently auto-capitalize the first character and users
      // retyping from memory often use uppercase. Without this, "ABC123EF" and
      // "abc123ef" hash to different values and the user gets a generic 400
      // error with no clue why. SHA-256 is one-way so we cannot recover from
      // case at the storage end — normalise at compare time.
      const hashed = hashRecoveryCode(token.toLowerCase());
      // Tolerate malformed `mfaRecoveryCodes` JSON: a corrupted column should
      // produce a clean 400 "Invalid authentication code" (via the !ok branch
      // below), not a 500 from JSON.parse throwing into the outer try/catch.
      // The symmetric branch at /mfa/factors (~line 1454) and the
      // not-configured guard below already use the same try/catch shape.
      let codes = [];
      try {
        const parsed = JSON.parse(user.mfaRecoveryCodes || "[]");
        if (Array.isArray(parsed)) codes = parsed;
      } catch { /* malformed JSON — treat as no codes */ }
      const idx = findRecoveryCodeIndex(codes, hashed);
      if (idx >= 0) {
        codes.splice(idx, 1);
        updatedRecovery = JSON.stringify(codes);
        remaining = codes.length;
        ok = true;
        method = "recovery";
      }
    }

    // If BOTH the TOTP secret is undecryptable AND no recovery codes exist,
    // surface a clear error rather than the generic "Invalid authentication
    // code" — the user's MFA row is broken and they need admin help.
    // Parse the JSON rather than comparing the literal string "[]" — the
    // column could contain whitespace-variant JSON like "[ ]" or be null.
    if (!ok && !secret) {
      let hasRecoveryCodes = false;
      try {
        const parsed = JSON.parse(user.mfaRecoveryCodes || "[]");
        hasRecoveryCodes = Array.isArray(parsed) && parsed.length > 0;
      } catch { /* malformed JSON — treat as no codes */ }
      if (!hasRecoveryCodes) {
        return res.status(400).json({ error: "MFA is not configured. Contact an administrator." });
      }
    }

    if (!ok) {
      logActivity({
        type: "auth.mfa.verify_failed",
        detail: "Invalid MFA code during login.",
        userId: user.id, userName: user.name || user.email,
        workspaceId: pending.workspaceId,
        meta: { method: token ? "unknown" : "missing", phase: "login" },
      });
      // Token is intentionally NOT consumed here — the rate limiter bounds
      // brute force, and preserving the token lets the user retry without
      // re-entering email+password after a typo.
      return res.status(400).json({ error: "Invalid authentication code." });
    }

    // Verification passed — consume the token now, atomically. If a parallel
    // request raced and already consumed it, treat this as expired.
    if (!consumePendingMfaLogin(pendingTokenStr)) {
      return res.status(401).json({ error: "MFA session expired. Sign in again." });
    }

    if (updatedRecovery !== null) {
      userRepo.update(user.id, { mfaRecoveryCodes: updatedRecovery, updatedAt: new Date().toISOString() });
      logActivity({
        type: "auth.mfa.recovery_code_consumed",
        detail: "Consumed a recovery code during MFA login.",
        userId: user.id, userName: user.name || user.email,
        workspaceId: pending.workspaceId,
        meta: { remaining },
      });
    } else {
      logActivity({
        type: "auth.mfa.login_verified",
        detail: "MFA login verified.",
        userId: user.id, userName: user.name || user.email,
        workspaceId: pending.workspaceId,
        meta: { method },
      });
    }

    // SEC-004 §5c: MFA-asserted session — tag with both pwd (login flow
    // already proved the password) and mfa (second factor verified).
    //
    // NOTE: applyMfaEnforcement is intentionally NOT called here. The
    // invariant is: this branch is only reachable when the user has at
    // least one MFA factor (TOTP/recovery/passkey), and
    // evaluateMfaEnforcement returns "allow" the moment any factor is
    // present. If a future rule expands enforcement to require something
    // beyond "has any factor" (e.g. "factor must be a hardware key"), the
    // applyMfaEnforcement call must be added back here — leave this
    // comment as the contract reminder.
    const payload = buildJwtPayload(user, undefined, { amr: ["pwd", "mfa"] });
    const jwt = signJwt(payload, getJwtSecret());
    const exp = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;
    setAuthCookie(res, jwt, exp);

    return res.json({ user: buildUserResponse(user) });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/mfa/verify] ${err.message}`));
    return res.status(500).json({ error: "Failed to verify MFA." });
  }
});

/**
 * Regenerate the user's recovery codes. Invalidates the previous set and
 * returns a fresh batch (shown once — the client must save them immediately).
 * Requires password confirmation; OAuth-only users authenticate by session.
 *
 * Audit-logged so admins can correlate "I lost my codes" support tickets
 * with the regeneration event.
 *
 * @route POST /api/v1/auth/mfa/recovery-codes/regenerate
 * @param {Object} req.body
 * @param {string} req.body.password
 * @returns {200} `{ recoveryCodes: string[] }`
 * @returns {400} MFA not enabled.
 * @returns {403} Password confirmation failed.
 */
router.post("/mfa/recovery-codes/regenerate", requireAuth, async (req, res) => {
  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.mfaEnabled !== 1) {
      return res.status(400).json({ error: "MFA is not enabled. Enable MFA before regenerating recovery codes." });
    }
    const valid = await verifyAccountPassword(user, req.body?.password);
    if (!valid) return res.status(403).json({ error: "Password confirmation failed." });

    const recovery = mintRecoveryCodes();
    userRepo.update(user.id, {
      mfaRecoveryCodes: JSON.stringify(recovery.hashed),
      updatedAt: new Date().toISOString(),
    });

    logActivity({
      type: "auth.mfa.recovery_codes_regenerated",
      detail: "Regenerated MFA recovery codes.",
      userId: user.id, userName: user.name || user.email,
      workspaceId: req.authUser.workspaceId,
      meta: { count: recovery.raw.length },
    });

    // SEC-004: Regenerating recovery codes is the user's "panic button" — the
    // typical trigger is "my old codes leaked" or "I lost them and might've
    // exposed them". Revoke the current session so a parallel cookie on
    // another device (e.g. an attacker holding the one that triggered the
    // panic) cannot continue acting under the regenerated set. Matches the
    // industry baseline (Auth0, Clerk, Okta, GitHub all terminate sessions
    // on credential change).
    _internalRevokeCurrentSession(req, res, { reason: "mfa.recovery_codes_regenerated" });

    return res.json({ recoveryCodes: recovery.raw, sessionRevoked: true });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/mfa/recovery-codes/regenerate] ${err.message}`));
    return res.status(500).json({ error: "Failed to regenerate recovery codes." });
  }
});

/**
 * Disable MFA. Clears the encrypted secret and recovery codes. Requires
 * password confirmation (OAuth-only users authenticate by session — see
 * {@link verifyAccountPassword}).
 *
 * @route POST /api/v1/auth/mfa/disable
 * @param {Object} req.body
 * @param {string} req.body.password
 * @returns {200} `{ ok: true }`
 * @returns {403} Password confirmation failed.
 */
router.post("/mfa/disable", requireAuth, async (req, res) => {
  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });
    const valid = await verifyAccountPassword(user, req.body?.password);
    if (!valid) return res.status(403).json({ error: "Password confirmation failed." });

    // SEC-004: self-lockout guard. If TOTP is the user's only second factor
    // (no passkeys) and a workspace they belong to requires MFA, refuse the
    // disable — for BOTH "block" (past grace) AND "grace" (within grace).
    // Allowing the disable during grace would just defer the lockout: the
    // user drops to zero factors and walks into a 403 on day N+1. Mirror of
    // the guard in DELETE /webauthn/credentials/:id; passes
    // `skipWebauthnCheck: true` so a 0-passkey user is correctly seen as
    // factor-less (the live passkey count is already 0 here, so the flag
    // is defensive — it future-proofs against accidental reordering).
    const passkeyCount = webauthnRepo.countByUser(user.id);
    if (passkeyCount === 0) {
      const enforcement = evaluateMfaEnforcement({ ...user, mfaEnabled: 0 }, { skipWebauthnCheck: true });
      if (enforcement.state !== "allow") {
        const inGrace = enforcement.state === "grace";
        return res.status(400).json({
          error: inGrace
            ? `Cannot disable MFA — your workspace will require it in ${enforcement.gracePeriodDaysRemaining} day${enforcement.gracePeriodDaysRemaining === 1 ? "" : "s"}. Enroll a passkey first.`
            : "Cannot disable MFA — your workspace requires it. Enroll a passkey first, or ask an administrator to extend the grace window.",
          code: "MFA_LAST_FACTOR_PROTECTED",
          workspaceId: enforcement.workspaceId,
          gracePeriodDaysRemaining: enforcement.gracePeriodDaysRemaining,
        });
      }
    }

    userRepo.update(user.id, { mfaEnabled: 0, mfaSecret: null, mfaRecoveryCodes: null, updatedAt: new Date().toISOString() });

    logActivity({
      type: "auth.mfa.disabled",
      detail: "Disabled MFA.",
      userId: user.id, userName: user.name || user.email,
      workspaceId: req.authUser.workspaceId,
      meta: {},
    });

    // SEC-004: Disabling MFA is a security-posture downgrade — the user's
    // session is currently MFA-asserted (amr=["pwd","mfa"]) but after this
    // call the user no longer has a second factor. Revoking the current
    // session forces re-authentication so the new cookie reflects the new
    // posture (amr=["pwd"]). Matches the industry baseline for security-
    // impacting account changes.
    _internalRevokeCurrentSession(req, res, { reason: "mfa.disabled" });

    return res.json({ ok: true, sessionRevoked: true });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/mfa/disable] ${err.message}`));
    return res.status(500).json({ error: "Failed to disable MFA." });
  }
});

export default router;

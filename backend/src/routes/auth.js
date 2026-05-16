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
import { formatLogLine } from "../utils/logFormatter.js";
import { logActivity } from "../utils/activityLogger.js";
import { evaluateMfaEnforcement } from "../utils/mfaEnforcement.js";
import { encryptString, decryptString } from "../utils/credentialEncryption.js";
import { stopSchedule } from "../scheduler.js";
import { sendVerificationEmail } from "../utils/emailSender.js";
import { buildJwtPayload, buildUserResponse } from "../utils/authWorkspace.js";
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

const rateBuckets = {
  login:         { map: new Map(), max: 10 },  // 10 login attempts per IP per 15 min
  forgotPassword:{ map: new Map(), max: 5 },   // 5 reset requests per IP per 15 min
  resetPassword: { map: new Map(), max: 5 },   // 5 reset attempts per IP per 15 min
  // SEC-004: MFA-specific buckets — verify is the brute-force surface (only
  // 6 digits of entropy per attempt), enroll prevents secret-flooding abuse.
  mfaVerify:     { map: new Map(), max: 5 },   // 5 verify attempts per IP per 15 min
  mfaEnroll:     { map: new Map(), max: 3 },   // 3 enroll cycles per IP per 15 min
};

/**
 * Check rate limit for a specific bucket.
 * @param {string} bucket — key in rateBuckets (e.g. "login", "forgotPassword")
 * @param {string} ip
 * @returns {{ allowed: boolean, retryAfterSec: number }}
 */
function checkRateLimit(bucket, ip) {
  const { map, max } = rateBuckets[bucket];
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
  const key = base32Decode(secret);
  const step = 30;
  const now = Math.floor(Date.now() / 1000 / step);
  const tBuf = Buffer.from(t);
  let matched = false;
  for (let i = -w; i <= w; i++) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(now + i));
    const hmac = crypto.createHmac("sha1", key).update(counter).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) | ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
    const computed = String(code % 1_000_000).padStart(6, "0");
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
 * @param {string} userId
 * @returns {string} Opaque base64url token (24 bytes of entropy).
 * @private
 */
function createPendingMfaLogin(userId) {
  const token = crypto.randomBytes(24).toString("base64url");
  mfaPendingLogins.set(token, { userId, expiresAt: Date.now() + MFA_LOGIN_TTL_MS });
  return token;
}

/**
 * Atomically consume a pending-MFA token. Returns the entry on success and
 * deletes it (single-use). Returns null when missing, already consumed, or
 * expired.
 * @param {string} token
 * @returns {{ userId: string, expiresAt: number } | null}
 * @private
 */
function consumePendingMfaLogin(token) {
  const entry = mfaPendingLogins.get(token);
  if (!entry) return null;
  mfaPendingLogins.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
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

    if (user.mfaEnabled === 1 && user.mfaSecret) {
      const pendingToken = createPendingMfaLogin(user.id);
      return res.status(200).json({ mfaRequired: true, pendingToken });
    }

    // SEC-004: per-workspace MFA enforcement. If any workspace this user
    // belongs to has mfaRequired=1 and the user is past the grace window,
    // block login outright with an enrollment-required code. Within the
    // grace window, allow login but surface the remaining days as a header
    // so the frontend can render a banner.
    const enforcement = evaluateMfaEnforcement(user);
    if (enforcement.state === "block") {
      logActivity({
        type: "auth.mfa.enrollment_required",
        detail: "Login blocked: workspace requires MFA.",
        userId: user.id, userName: user.name || user.email,
        workspaceId: enforcement.workspaceId,
        meta: { method: "password" },
      });
      return res.status(403).json({
        error: "Your workspace requires multi-factor authentication. Enroll before signing in.",
        code: "MFA_ENROLLMENT_REQUIRED",
        workspaceId: enforcement.workspaceId,
        workspaceName: enforcement.workspaceName,
      });
    }
    if (enforcement.state === "grace") {
      res.setHeader("X-MFA-Grace-Period-Days-Remaining", String(enforcement.gracePeriodDaysRemaining));
      res.setHeader("X-MFA-Grace-Ends-At", enforcement.graceEndsAt);
    }

    // SEC-004 §5c: tag password-only sessions with amr=["pwd"] so future
    // step-up auth checks can require MFA-asserted sessions explicitly.
    const payload = buildJwtPayload(user, undefined, { amr: ["pwd"] });
    const token = signJwt(payload, getJwtSecret());
    const exp   = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;

    setAuthCookie(res, token, exp);

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

  // Revoke the old token
  const { jti: oldJti, exp: oldExp } = req.authUser;
  if (oldJti) revokedTokens.set(oldJti, oldExp);

  // Issue a fresh token with a new JTI (includes updated workspace context)
  const payload = buildJwtPayload(user, req.authUser.workspaceId);
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
    const enforcement = evaluateMfaEnforcement(user);
    if (enforcement.state === "block") {
      logActivity({
        type: "auth.mfa.enrollment_required",
        detail: "OAuth login blocked: workspace requires MFA.",
        userId: user.id, userName: user.name || user.email,
        workspaceId: enforcement.workspaceId,
        meta: { method: "oauth", provider: "github" },
      });
      return res.status(403).json({
        error: "Your workspace requires multi-factor authentication. Enroll before signing in.",
        code: "MFA_ENROLLMENT_REQUIRED",
        workspaceId: enforcement.workspaceId,
        workspaceName: enforcement.workspaceName,
      });
    }
    if (enforcement.state === "grace") {
      res.setHeader("X-MFA-Grace-Period-Days-Remaining", String(enforcement.gracePeriodDaysRemaining));
      res.setHeader("X-MFA-Grace-Ends-At", enforcement.graceEndsAt);
    }

    // SEC-004 §5c: OAuth sessions are tagged amr=["oauth"]. They are NOT
    // MFA-asserted — workspace MFA enforcement applies above.
    const payload = buildJwtPayload(user, undefined, { amr: ["oauth"] });
    const token = signJwt(payload, getJwtSecret());
    const exp   = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;
    setAuthCookie(res, token, exp);

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
    const enforcement = evaluateMfaEnforcement(user);
    if (enforcement.state === "block") {
      logActivity({
        type: "auth.mfa.enrollment_required",
        detail: "OAuth login blocked: workspace requires MFA.",
        userId: user.id, userName: user.name || user.email,
        workspaceId: enforcement.workspaceId,
        meta: { method: "oauth", provider: "google" },
      });
      return res.status(403).json({
        error: "Your workspace requires multi-factor authentication. Enroll before signing in.",
        code: "MFA_ENROLLMENT_REQUIRED",
        workspaceId: enforcement.workspaceId,
        workspaceName: enforcement.workspaceName,
      });
    }
    if (enforcement.state === "grace") {
      res.setHeader("X-MFA-Grace-Period-Days-Remaining", String(enforcement.gracePeriodDaysRemaining));
      res.setHeader("X-MFA-Grace-Ends-At", enforcement.graceEndsAt);
    }

    // SEC-004 §5c: OAuth sessions are tagged amr=["oauth"]. They are NOT
    // MFA-asserted — workspace MFA enforcement applies above.
    const payload = buildJwtPayload(user, undefined, { amr: ["oauth"] });
    const token = signJwt(payload, getJwtSecret());
    const exp   = Math.floor(Date.now() / 1000) + JWT_TTL_SEC;
    setAuthCookie(res, token, exp);

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
  try {
    const user = userRepo.getById(req.authUser.sub);
    if (!user) return res.status(404).json({ error: "User not found." });
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
    const pending = consumePendingMfaLogin(sanitiseString(req.body?.pendingToken, 200));
    if (!pending) return res.status(401).json({ error: "MFA session expired. Sign in again." });
    const user = userRepo.getById(pending.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    const token = sanitiseString(req.body?.token, 16).replace(/\s+/g, "");
    const secret = decryptString(user.mfaSecret);
    if (!secret) return res.status(400).json({ error: "MFA is not configured." });

    let ok = verifyTotp(token, secret);
    let method = ok ? "totp" : null;
    let updatedRecovery = null;
    let remaining = null;

    if (!ok && token) {
      // Recovery-code path: constant-time scan to avoid leaking which slot
      // matched via the difference between Array.indexOf early-exit and full
      // scan timings.
      const hashed = hashRecoveryCode(token);
      const codes = JSON.parse(user.mfaRecoveryCodes || "[]");
      const idx = findRecoveryCodeIndex(codes, hashed);
      if (idx >= 0) {
        codes.splice(idx, 1);
        updatedRecovery = JSON.stringify(codes);
        remaining = codes.length;
        ok = true;
        method = "recovery";
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
      return res.status(400).json({ error: "Invalid authentication code." });
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
    userRepo.update(user.id, { mfaEnabled: 0, mfaSecret: null, mfaRecoveryCodes: null, updatedAt: new Date().toISOString() });

    logActivity({
      type: "auth.mfa.disabled",
      detail: "Disabled MFA.",
      userId: user.id, userName: user.name || user.email,
      workspaceId: req.authUser.workspaceId,
      meta: {},
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(formatLogLine("error", null, `[auth/mfa/disable] ${err.message}`));
    return res.status(500).json({ error: "Failed to disable MFA." });
  }
});

export default router;

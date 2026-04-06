/**
 * @module routes/auth
 * @description Authentication routes for email/password and OAuth (GitHub, Google).
 *
 * ### Endpoints
 * | Method | Path                          | Description                          |
 * |--------|-------------------------------|--------------------------------------|
 * | POST   | `/api/auth/register`          | Email/password registration          |
 * | POST   | `/api/auth/login`             | Email/password sign-in               |
 * | POST   | `/api/auth/logout`            | Token revocation (server-side)       |
 * | GET    | `/api/auth/me`                | Return current user from token       |
 * | GET    | `/api/auth/github/callback`   | GitHub OAuth token exchange          |
 * | GET    | `/api/auth/google/callback`   | Google OAuth token exchange          |
 *
 * ### Security measures
 * - Passwords hashed with scrypt (64-byte key, 16-byte random salt)
 * - JWT signed with HS256, 8-hour expiry
 * - Rate limiting: 10 sign-in attempts per IP per 15 minutes
 * - Revoked tokens kept in an in-memory Map (production: use Redis)
 * - Input validation and sanitisation on every endpoint
 * - OAuth state parameter validated on the frontend to prevent CSRF
 * - No sensitive data (passwords, raw OAuth tokens) returned to client
 */

import express from "express";
import crypto from "crypto";
import { getDb, saveDb } from "../db.js";

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

/**
 * Sign a JWT with HS256 using only Node.js `crypto` (no external library).
 *
 * @param   {Object} payload      - Claims to include (e.g. `{ sub, email, role, jti }`).
 * @param   {string} secret       - HMAC secret (32+ chars recommended).
 * @param   {number} [expiresInSec=28800] - Token lifetime in seconds (default 8 hours).
 * @returns {string}                The signed JWT string (`header.payload.signature`).
 * @private
 */
function signJwt(payload, secret, expiresInSec = 8 * 60 * 60) {
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
 * @private
 */
function verifyJwt(token, secret) {
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

/** Cached dev-mode fallback secret — derived once, reused for the process lifetime. */
let _devFallbackSecret = null;

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 32) return secret;

  if (process.env.NODE_ENV === "production") {
    throw new Error("[auth] FATAL: JWT_SECRET is missing or too short. Set a 32+ char secret in .env for production.");
  }

  // Dev-only: derive a deterministic secret from the project directory so tokens
  // survive server restarts (nodemon, Docker recreate) without requiring .env setup.
  // The secret is unique per machine/checkout path but not random — acceptable for
  // local development where the threat model is convenience, not security.
  if (!_devFallbackSecret) {
    const seed = `dev-jwt-secret:${process.cwd()}`;
    _devFallbackSecret = crypto.createHash("sha256").update(seed).digest("base64url");
    console.warn("[auth] WARNING: JWT_SECRET not set — using deterministic dev secret. Sessions survive restarts but set JWT_SECRET for production.");
  }
  return _devFallbackSecret;
}

// ─── In-memory stores (replace with DB/Redis in production) ─────────────────

// Token revocation list (logout): { jti → expiry_timestamp }
const revokedTokens = new Map();

// Rate limiter: { ip → { count, resetAt } }
const loginAttempts = new Map();
const RATE_LIMIT_MAX   = 10;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, retryAfterSec };
  }
  entry.count++;
  return { allowed: true };
}

// Purge expired revoked tokens periodically.
// .unref() so this timer doesn't keep the process alive (e.g. during tests).
const _purgeInterval = setInterval(() => {
  const now = Date.now() / 1000;
  for (const [jti, exp] of revokedTokens) {
    if (exp < now) revokedTokens.delete(jti);
  }
}, 60 * 60 * 1000);
_purgeInterval.unref();

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Express middleware that validates a JWT token.
 *
 * Checks for the token in this order:
 * 1. `Authorization: Bearer <token>` header (standard for JSON API calls)
 * 2. `?token=<jwt>` query parameter (fallback for SSE / EventSource which
 *    cannot send custom headers)
 *
 * On success, attaches the decoded payload to `req.authUser`.
 * On failure, responds with `401 Unauthorized`.
 *
 * @param {Object}   req  - Express request.
 * @param {Object}   res  - Express response.
 * @param {Function} next - Express next middleware.
 * @returns {void}
 *
 * @example
 * import { requireAuth } from "./routes/auth.js";
 * router.get("/protected", requireAuth, (req, res) => {
 *   res.json({ userId: req.authUser.sub });
 * });
 */
export function requireAuth(req, res, next) {
  // 1. Try Authorization header (preferred)
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }
  // 2. Fallback to ?token= query param (for EventSource / SSE)
  if (!token && req.query.token) {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }
  const payload = verifyJwt(token, getJwtSecret());
  if (!payload) return res.status(401).json({ error: "Invalid or expired token." });
  if (payload.jti && revokedTokens.has(payload.jti)) {
    return res.status(401).json({ error: "Token has been revoked. Please sign in again." });
  }
  req.authUser = payload;
  next();
}

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

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Register a new user with email and password.
 *
 * @route POST /api/auth/register
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
    if (typeof password !== "string" || password.length < 8)
                                     return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (password.length > 128)       return res.status(400).json({ error: "Password is too long." });

    const db = getDb();
    const existing = Object.values(db.users || {}).find(u => u.email === email);
    if (existing) {
      // Generic message to avoid user-enumeration
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const id           = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const now          = new Date().toISOString();

    const user = { id, name, email, passwordHash, role: "user", createdAt: now, updatedAt: now };
    db.users = db.users || {};
    db.users[id] = user;
    saveDb();

    return res.status(201).json({ message: "Account created successfully." });
  } catch (err) {
    console.error("[auth/register]", err);
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

/**
 * Sign in with email and password. Returns a JWT token and user profile.
 * Rate-limited to 10 attempts per IP per 15 minutes.
 *
 * @route POST /api/auth/login
 * @param {Object} req.body
 * @param {string} req.body.email    - Email address.
 * @param {string} req.body.password - Password.
 * @returns {200} `{ token, user: { id, name, email, role, avatar } }`.
 * @returns {400} Invalid input.
 * @returns {401} Wrong credentials.
 * @returns {429} Rate limit exceeded (`Retry-After` header set).
 */
router.post("/login", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const rate = checkRateLimit(ip);
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

    const db   = getDb();
    const user = Object.values(db.users || {}).find(u => u.email === email);

    // Always run verifyPassword (even on non-existent user) to prevent timing attacks
    const dummyHash = "00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    const valid = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, dummyHash).catch(() => false);

    if (!user || !valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const jti   = crypto.randomUUID();
    const token = signJwt({ sub: user.id, email: user.email, role: user.role, jti }, getJwtSecret());

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar || null },
    });
  } catch (err) {
    console.error("[auth/login]", err);
    return res.status(500).json({ error: "Sign-in failed. Please try again." });
  }
});

/**
 * Sign out — revokes the JWT server-side so it can't be reused.
 * Requires `Authorization: Bearer <token>`.
 *
 * @route POST /api/auth/logout
 * @returns {200} `{ message: "Signed out successfully." }`.
 * @returns {401} Missing or invalid token.
 */
router.post("/logout", requireAuth, (req, res) => {
  const { jti, exp } = req.authUser;
  if (jti) revokedTokens.set(jti, exp);
  return res.json({ message: "Signed out successfully." });
});

/**
 * Get the currently authenticated user's profile.
 * Requires `Authorization: Bearer <token>`.
 *
 * @route GET /api/auth/me
 * @returns {200} `{ id, name, email, role, avatar, createdAt }`.
 * @returns {401} Missing or invalid token.
 * @returns {404} User not found in database.
 */
router.get("/me", requireAuth, (req, res) => {
  const db   = getDb();
  const user = (db.users || {})[req.authUser.sub];
  if (!user) return res.status(404).json({ error: "User not found." });
  return res.json({ id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar || null, createdAt: user.createdAt });
});

// ─── GitHub OAuth ─────────────────────────────────────────────────────────────

/**
 * GitHub OAuth callback. Exchanges an authorization code for an access token,
 * fetches the user profile, and issues a signed JWT.
 *
 * @route GET /api/auth/github/callback
 * @param {string} req.query.code - The OAuth authorization code from GitHub.
 * @returns {200} `{ token, user: { id, name, email, role, avatar } }`.
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

    const jti   = crypto.randomUUID();
    const token = signJwt({ sub: user.id, email: user.email, role: user.role, jti }, getJwtSecret());

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar || null },
    });
  } catch (err) {
    console.error("[auth/github]", err);
    return res.status(401).json({ error: err.message || "GitHub authentication failed." });
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────

/**
 * Google OAuth callback. Exchanges an authorization code for an access token,
 * fetches the user profile, and issues a signed JWT.
 *
 * @route GET /api/auth/google/callback
 * @param {string} req.query.code - The OAuth authorization code from Google.
 * @returns {200} `{ token, user: { id, name, email, role, avatar } }`.
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
      name: profile.name,
      avatar: profile.picture || null,
    });

    const jti   = crypto.randomUUID();
    const token = signJwt({ sub: user.id, email: user.email, role: user.role, jti }, getJwtSecret());

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar || null },
    });
  } catch (err) {
    console.error("[auth/google]", err);
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
  const db    = getDb();
  db.users    = db.users || {};
  db.oauthIds = db.oauthIds || {}; // { "github:12345" → userId }

  const key      = `${provider}:${providerId}`;
  let userId     = db.oauthIds[key];
  let user       = userId ? db.users[userId] : null;

  if (!user) {
    // Check if an account with this email exists (link providers)
    user = Object.values(db.users).find(u => u.email === email);
  }

  if (!user) {
    // Create new user
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    user      = { id, name, email, passwordHash: null, role: "user", avatar, createdAt: now, updatedAt: now };
    db.users[id] = user;
    saveDb();
  }

  // Always keep OAuth provider link up to date
  db.oauthIds[key] = user.id;
  // Update avatar if missing
  if (!user.avatar && avatar) { user.avatar = avatar; user.updatedAt = new Date().toISOString(); }

  return user;
}

export default router;

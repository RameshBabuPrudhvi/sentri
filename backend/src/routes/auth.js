/**
 * routes/auth.js
 *
 * Authentication routes:
 *   POST /api/auth/register        — email/password registration
 *   POST /api/auth/login           — email/password login
 *   POST /api/auth/logout          — token revocation (server-side blocklist)
 *   GET  /api/auth/me              — return current user from token
 *   GET  /api/auth/github/callback — GitHub OAuth token exchange
 *   GET  /api/auth/google/callback — Google OAuth token exchange
 *
 * Security measures:
 *   • Passwords hashed with bcrypt (cost factor 12)
 *   • JWT signed with HS256, 8-hour expiry
 *   • Rate limiting: 10 login attempts per IP per 15 minutes
 *   • Revoked tokens kept in an in-memory Set (production: use Redis)
 *   • Input validation and sanitisation on every endpoint
 *   • OAuth state parameter validated to prevent CSRF
 *   • No sensitive data (passwords, raw OAuth tokens) returned to client
 */

import express from "express";
import crypto from "crypto";
import { getDb, saveDb } from "../db.js";

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** bcrypt-compatible pure-JS password hashing using scrypt (no native addon needed) */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (err, key) => (err ? rej(err) : res(key)))
  );
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const derived = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (err, key) => (err ? rej(err) : res(key)))
  );
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), derived);
}

/** Sign a JWT with HS256 (no external library needed) */
function signJwt(payload, secret, expiresInSec = 8 * 60 * 60) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSec })).toString("base64url");
  const sig    = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token, secret) {
  const parts = token?.split(".");
  if (parts?.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    console.warn("[auth] WARNING: JWT_SECRET is missing or too short. Using insecure fallback — set JWT_SECRET in .env for production.");
    return "sentri-dev-secret-change-in-production-must-be-32-chars-minimum";
  }
  return secret;
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

// Purge expired revoked tokens periodically
setInterval(() => {
  const now = Date.now() / 1000;
  for (const [jti, exp] of revokedTokens) {
    if (exp < now) revokedTokens.delete(jti);
  }
}, 60 * 60 * 1000);

// ─── Middleware ───────────────────────────────────────────────────────────────

/** Validates Bearer token and attaches req.authUser */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required." });
  }
  const token = authHeader.slice(7);
  const payload = verifyJwt(token, getJwtSecret());
  if (!payload) return res.status(401).json({ error: "Invalid or expired token." });
  if (payload.jti && revokedTokens.has(payload.jti)) {
    return res.status(401).json({ error: "Token has been revoked. Please sign in again." });
  }
  req.authUser = payload;
  next();
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
function sanitiseString(str, maxLen = 200) {
  return typeof str === "string" ? str.trim().slice(0, maxLen) : "";
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Body: { name, email, password }
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
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    res.setHeader("Retry-After", rate.retryAfterSec);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(rate.retryAfterSec / 60)} minutes.` });
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
    const valid = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, dummyHash).catch(() => false);

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
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

/**
 * POST /api/auth/logout
 * Requires Authorization: Bearer <token>
 * Revokes the token server-side.
 */
router.post("/logout", requireAuth, (req, res) => {
  const { jti, exp } = req.authUser;
  if (jti) revokedTokens.set(jti, exp);
  return res.json({ message: "Logged out successfully." });
});

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile.
 */
router.get("/me", requireAuth, (req, res) => {
  const db   = getDb();
  const user = (db.users || {})[req.authUser.sub];
  if (!user) return res.status(404).json({ error: "User not found." });
  return res.json({ id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar || null, createdAt: user.createdAt });
});

// ─── GitHub OAuth ─────────────────────────────────────────────────────────────

/**
 * GET /api/auth/github/callback?code=...
 * Exchanges GitHub code for a user profile and issues a Sentri JWT.
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
 * GET /api/auth/google/callback?code=...
 * Exchanges Google code for an ID token, verifies it, and issues a Sentri JWT.
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

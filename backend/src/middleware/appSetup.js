/**
 * @module middleware/appSetup
 * @description Express app creation, global middleware, and static file serving.
 *
 * Extracted from `index.js` so the app instance can be imported by tests
 * or other modules without triggering side effects (DB init, listen).
 *
 * ### Exports
 * - {@link app} — The Express application instance.
 * - {@link ARTIFACTS_DIR} — Absolute path to the Playwright artifacts directory.
 *
 * @example
 * import { app, ARTIFACTS_DIR } from "./middleware/appSetup.js";
 */

import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// Load .env before reading any env vars below (CORS_ORIGIN, etc.).
// ESM imports execute before module-level code in index.js, so the
// dotenv.config() call there runs too late for this file.
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The Express application instance.
 * @type {Object}
 */
export const app = express();

// Trust the first hop's X-Forwarded-For header (set by nginx / load balancer).
// Without this, Express uses the raw socket IP instead of the real client IP,
// making per-IP rate limiting ineffective behind a reverse proxy.
// "1" = trust exactly one proxy hop — adjust if you have multiple hops.
app.set("trust proxy", 1);

// ─── Global middleware ────────────────────────────────────────────────────────

// Security headers: X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, etc.
// CSP is configured with a baseline policy that allows the SPA to function while
// blocking inline script injection (XSS mitigation). Tighten further in production
// by replacing 'unsafe-inline' with nonce-based or hash-based script allowlisting.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],   // needed by Vite in dev; replace with nonces in prod
      styleSrc:       ["'self'", "'unsafe-inline'"],   // inline styles used throughout the SPA
      imgSrc:         ["'self'", "data:", "blob:"],    // data: for canvas favicons, blob: for screenshots
      connectSrc:     ["'self'"],                      // API + SSE calls — same origin only
      fontSrc:        ["'self'", "data:"],
      frameSrc:       ["'self'"],                      // Playwright trace viewer iframes
      workerSrc:      ["'self'", "blob:"],             // Web Workers for PDF generation
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      frameAncestors: ["'none'"],                      // prevents clickjacking
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,   // required for Playwright trace viewer iframes
}));

// CORS — restrict origins in production, allow all in development.
// Set CORS_ORIGIN env var to the frontend URL (e.g. "https://sentri.example.com").
const corsOrigin = process.env.CORS_ORIGIN || "*";
if (corsOrigin === "*" && process.env.NODE_ENV === "production") {
  throw new Error(
    "CORS_ORIGIN must be set in production. " +
    "Set CORS_ORIGIN to your frontend URL(s) (comma-separated), e.g. CORS_ORIGIN=https://sentri.example.com"
  );
}
app.use(cors({
  origin: corsOrigin === "*" ? true : corsOrigin.split(",").map(o => o.trim()),
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));

// ─── Cookie parsing ───────────────────────────────────────────────────────────
// Parse the Cookie header into req.cookies without an external dependency.
// Handles quoted values and URL-encoded characters.
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (!header) return next();
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim();
    let val = part.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    try { req.cookies[key] = decodeURIComponent(val); } catch { req.cookies[key] = val; }
  }
  next();
});

// ─── CSRF double-submit cookie protection ─────────────────────────────────────
// Protects state-mutating endpoints (POST, PATCH, DELETE, PUT) against
// Cross-Site Request Forgery.
//
// Strategy: double-submit cookie pattern.
//   1. On every request the server checks for a `_csrf` cookie.
//      If missing, it creates one (a random 32-byte token) and sets it as
//      a Non-HttpOnly cookie so JavaScript can read it.
//   2. Every mutating fetch sends the same token in the `X-CSRF-Token` header.
//   3. The server compares cookie value ↔ header value. Mismatch → 403.
//
// This works because a cross-origin attacker can trigger a request with cookies
// (CORS allows credentialed requests to same-site) but cannot READ the cookie
// value to forge the matching header — that is blocked by the browser's
// Same-Origin Policy.
//
// Safe methods (GET, HEAD, OPTIONS) and the auth endpoints themselves are exempt.
// The /api/auth/login endpoint is also exempt because the user has no session yet.

const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE_NAME  = "_csrf";
const CSRF_HEADER_NAME  = "x-csrf-token";

// These paths receive mutations but are either public (login, register) or
// use the cookie as the auth mechanism itself (logout clears it on the server).
const CSRF_EXEMPT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",          // logout is safe — attacker gains nothing by logging you out
  "/api/auth/refresh",         // refresh reads cookie for auth — no CSRF risk
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/github/callback",
  "/api/auth/google/callback",
]);

export function csrfMiddleware(req, res, next) {
  // Step 1: Ensure the CSRF cookie exists on every response.
  // If the client doesn't have one yet, generate and set it.
  // Non-HttpOnly so frontend JS can read it. SameSite=Strict for defence-in-depth.
  let csrfToken = req.cookies[CSRF_COOKIE_NAME];
  if (!csrfToken) {
    csrfToken = crypto.randomBytes(32).toString("base64url");
    const secure = process.env.NODE_ENV === "production";
    // Session cookie (no Max-Age / Expires) — lives until the browser is closed.
    // This avoids a subtle bug where the CSRF cookie expires after a fixed TTL
    // while the JWT is refreshed indefinitely by the frontend. With a session
    // cookie the CSRF token can never expire before the auth session does.
    // The CSRF token is not a secret — it's Non-HttpOnly by design so JS can
    // read it for the double-submit header. A long-lived cookie is safe here.
    res.setHeader("Set-Cookie",
      `${CSRF_COOKIE_NAME}=${csrfToken}; Path=/; SameSite=Strict${secure ? "; Secure" : ""}`
    );
    req.cookies[CSRF_COOKIE_NAME] = csrfToken; // make it available for this request
  }

  // Step 2: Validate the header on mutating requests.
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();

  const headerToken = req.headers[CSRF_HEADER_NAME];
  if (!headerToken || headerToken !== csrfToken) {
    return res.status(403).json({ error: "CSRF token missing or invalid. Please refresh the page." });
  }
  next();
}

app.use(csrfMiddleware);

// ─── Serve Playwright artifacts ───────────────────────────────────────────────
// NOTE: /artifacts is intentionally NOT behind requireAuth. Screenshots, videos,
// and traces are referenced via <img>, <video>, and <a download> tags which
// cannot send Authorization headers. To add auth, implement ?token= query param
// validation here (same pattern as SSE/export endpoints) and update all frontend
// artifact URLs to append the token. For now, artifact filenames contain random
// run IDs which provide obscurity (not security).
/**
 * Absolute path to the Playwright artifacts directory (screenshots, videos, traces).
 * @type {string}
 */
export const ARTIFACTS_DIR = path.join(__dirname, "..", "..", "artifacts");
app.use("/artifacts", express.static(ARTIFACTS_DIR, {
  setHeaders(res, fp) {
    if (fp.endsWith(".webm")) res.setHeader("Content-Type", "video/webm");
    if (fp.endsWith(".zip"))  res.setHeader("Content-Type", "application/zip");
    if (fp.endsWith(".png"))  res.setHeader("Content-Type", "image/png");
    res.setHeader("Accept-Ranges", "bytes");
  },
}));
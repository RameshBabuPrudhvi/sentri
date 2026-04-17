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
import { rateLimit } from "express-rate-limit";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { AUTH_COOKIE } from "./authenticate.js";
import { redis, isRedisAvailable } from "../utils/redisClient.js";
import { formatLogLine } from "../utils/logFormatter.js";

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

// ─── Cross-origin cookie helper ──────────────────────────────────────────────
// When the frontend and backend live on different origins (e.g. GitHub Pages +
// Render), SameSite=Strict cookies are never sent on cross-site requests.
// Detect this at startup so cookie-setting code can use SameSite=None; Secure.
const _corsOrigins = corsOrigin === "*" ? [] : corsOrigin.split(",").map(o => o.trim());

/**
 * `true` when CORS_ORIGIN is set to a different origin than the backend.
 * In that case cookies must use `SameSite=None; Secure` to be sent cross-site.
 *
 * Compares against the backend's own origin (PORT-based), NOT APP_URL which is
 * the frontend URL. For GitHub Pages + Render deployments, CORS_ORIGIN is the
 * GitHub Pages URL and the backend runs on Render — these are always different
 * origins, so cookies must use SameSite=None; Secure.
 * @type {boolean}
 */
export const isCrossOrigin = _corsOrigins.length > 0 && (() => {
  try {
    // Use RENDER_EXTERNAL_URL (set by Render) or build from PORT, not APP_URL
    // which is the frontend URL and would incorrectly match CORS_ORIGIN.
    const port = process.env.PORT || "3001";
    const backendOrigin = process.env.RENDER_EXTERNAL_URL
      || process.env.BACKEND_URL
      || `http://localhost:${port}`;
    return _corsOrigins.some(o => new URL(o).origin !== new URL(backendOrigin).origin);
  } catch { return false; }
})();

/**
 * Build the SameSite + Secure suffix for a Set-Cookie header.
 * Cross-origin → `SameSite=None; Secure` (required by browsers).
 * Same-origin  → `SameSite=Strict` + Secure only in production.
 * @param {boolean} [httpOnly=false] - Not used for the suffix, but kept for symmetry.
 * @returns {string}
 */
export function cookieSameSite() {
  if (isCrossOrigin) return "; SameSite=None; Secure";
  const secure = process.env.NODE_ENV === "production";
  return `; SameSite=Strict${secure ? "; Secure" : ""}`;
}

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
  "/api/auth/resend-verification", // public endpoint — user may have stale auth cookie
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
    // Session cookie (no Max-Age / Expires) — lives until the browser is closed.
    // This avoids a subtle bug where the CSRF cookie expires after a fixed TTL
    // while the JWT is refreshed indefinitely by the frontend. With a session
    // cookie the CSRF token can never expire before the auth session does.
    // The CSRF token is not a secret — it's Non-HttpOnly by design so JS can
    // read it for the double-submit header. A long-lived cookie is safe here.
    res.setHeader("Set-Cookie",
      `${CSRF_COOKIE_NAME}=${csrfToken}; Path=/${cookieSameSite()}`
    );
    req.cookies[CSRF_COOKIE_NAME] = csrfToken; // make it available for this request
  }

  // Step 2: Validate the header on mutating requests.
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();
  // CSRF protection is only needed for cookie-based auth.  If the request
  // has no auth cookie at all, it must be using a non-cookie strategy
  // (Bearer token, trigger token, query param) which is immune to CSRF
  // because the browser cannot attach those credentials to a cross-origin
  // request.  This replaces the old manual regex carve-out for /trigger
  // and automatically covers any future non-cookie auth strategies added
  // to middleware/authenticate.js.
  if (!req.cookies?.[AUTH_COOKIE]) return next();

  const headerToken = req.headers[CSRF_HEADER_NAME];
  if (!headerToken || headerToken !== csrfToken) {
    return res.status(403).json({ error: "CSRF token missing or invalid. Please refresh the page." });
  }
  next();
}

app.use(csrfMiddleware);

// ─── Global API rate limiting (INF-002: Redis-backed when available) ──────────
// Applies to ALL /api/* routes. Separate tighter buckets are defined below for
// expensive operations (crawl, test run, AI generation) that consume significant
// server or third-party AI API resources.
//
// When REDIS_URL is set, rate-limit-redis shares counters across all instances
// so limits are enforced globally (not per-process).  When Redis is not
// available, the default in-memory store is used (single-instance only).

// Lazy-load rate-limit-redis only when Redis is configured.
// We check `redis !== null` (client created) rather than `isRedisAvailable()`
// (client connected) because the ioredis `connect` event fires asynchronously
// AFTER all synchronous module-level code runs, so `isRedisAvailable()` would
// always return `false` at import time. The RedisStore itself handles
// connection retries gracefully — commands are queued until the client connects.
const _require = createRequire(import.meta.url);
let _redisStore = undefined; // undefined = use default in-memory store
if (redis) {
  try {
    const { RedisStore } = _require("rate-limit-redis");
    _redisStore = new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "sentri:rl:",
    });
    console.log(formatLogLine("info", null, "[rate-limit] Using Redis-backed store for rate limiting"));
  } catch {
    console.warn(formatLogLine("warn", null, "[rate-limit] rate-limit-redis not installed — using in-memory store. Run `npm install rate-limit-redis` for shared rate limiting."));
  }
}

/**
 * General API rate limiter — 300 requests per 15 minutes per IP.
 * Applied to all /api/* routes as a DoS / abuse baseline.
 */
const generalApiLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,   // 15 minutes
  max:              300,               // 300 requests per window per IP
  standardHeaders:  "draft-7",         // Retry-After, X-RateLimit-* headers
  legacyHeaders:    false,
  skip:             (req) => req.method === "OPTIONS", // never block preflight
  ...(_redisStore ? { store: _redisStore } : {}),
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests. Please slow down and try again shortly.",
    });
  },
});

/**
 * Expensive operations limiter — 20 requests per hour per IP.
 * Applied to: POST /api/projects/:id/crawl, POST /api/projects/:id/run,
 *             POST /api/tests/:testId/run
 * These endpoints launch a browser instance and consume AI API quota.
 */
export const expensiveOpLimiter = rateLimit({
  windowMs:         60 * 60 * 1000,   // 1 hour
  max:              20,               // 20 crawl/run triggers per hour per IP
  standardHeaders:  "draft-7",
  legacyHeaders:    false,
  ...(_redisStore ? { store: _redisStore } : {}),
  handler: (_req, res) => {
    res.status(429).json({
      error: "Rate limit reached for test runs. You can trigger up to 20 runs per hour. Please wait before starting another.",
    });
  },
});

/**
 * AI generation limiter — 30 requests per hour per IP.
 * Applied to: POST /api/projects/:id/tests/generate
 * These endpoints make direct AI API calls (Claude / GPT / Gemini).
 */
export const aiGenerationLimiter = rateLimit({
  windowMs:         60 * 60 * 1000,   // 1 hour
  max:              30,               // 30 AI generation calls per hour per IP
  standardHeaders:  "draft-7",
  legacyHeaders:    false,
  ...(_redisStore ? { store: _redisStore } : {}),
  handler: (_req, res) => {
    res.status(429).json({
      error: "Rate limit reached for AI generation. You can trigger up to 30 AI requests per hour. Please wait before generating more tests.",
    });
  },
});

// Apply the general limiter to all /api/* routes.
// The tighter per-operation limiters are applied at the route level in
// routes/runs.js and routes/tests.js via the exported limiters above.
app.use("/api", generalApiLimiter);

// ─── Artifact signing helpers ─────────────────────────────────────────────────
// Screenshots, videos, and Playwright traces are served as static files.
// <img>, <video>, and <a download> tags cannot send Authorization headers, so
// we use short-lived HMAC-signed query-param tokens instead.
//
// Token format:  ?token=<hmac-sha256(artifactPath + exp, ARTIFACT_SECRET)>&exp=<unix-ms>
// Default TTL:   1 hour (ARTIFACT_TOKEN_TTL_MS env var to override)
//
// ARTIFACT_SECRET must be set in production.  In development a random per-
// process secret is derived so artifacts still work without configuration.
// Generate a production value with:
//   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

const ARTIFACT_SECRET = process.env.ARTIFACT_SECRET ||
  (() => {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ARTIFACT_SECRET must be set in production. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
      );
    }
    // Development fallback: stable per-process random — fine for local use.
    return crypto.randomBytes(48).toString("hex");
  })();

const ARTIFACT_TOKEN_TTL_MS = parseInt(process.env.ARTIFACT_TOKEN_TTL_MS ?? "", 10) || 60 * 60 * 1000; // 1 hour

/**
 * Generate a short-lived HMAC-signed token for an artifact path.
 *
 * @param {string} artifactPath - The URL path, e.g. `/artifacts/screenshots/foo.png`
 * @returns {string} The full artifact URL with `?token=…&exp=…` appended.
 */
export function signArtifactUrl(artifactPath) {
  const exp = Date.now() + ARTIFACT_TOKEN_TTL_MS;
  const mac = crypto
    .createHmac("sha256", ARTIFACT_SECRET)
    .update(`${artifactPath}:${exp}`)
    .digest("base64url");
  return `${artifactPath}?token=${mac}&exp=${exp}`;
}

/**
 * Deep-clone a run object and sign all artifact paths so the frontend receives
 * fresh, non-expired URLs.  Call this at **read time** (API responses, SSE
 * events) — never persist signed URLs to the database.
 *
 * Handles: `run.tracePath`, `run.videoPath`, `run.videoSegments[]`,
 *          `run.results[].screenshotPath`, `run.results[].videoPath`.
 *
 * @param {Object} run - The run object from the database.
 * @returns {Object} A shallow clone with all artifact paths signed.
 */
export function signRunArtifacts(run) {
  if (!run) return run;
  const signed = { ...run };

  if (signed.tracePath) signed.tracePath = signArtifactUrl(signed.tracePath);
  if (signed.videoPath) signed.videoPath = signArtifactUrl(signed.videoPath);
  if (Array.isArray(signed.videoSegments)) {
    signed.videoSegments = signed.videoSegments.map(s => signArtifactUrl(s));
  }
  if (Array.isArray(signed.results)) {
    signed.results = signed.results.map(r => {
      const sr = { ...r };
      if (sr.screenshotPath) sr.screenshotPath = signArtifactUrl(sr.screenshotPath);
      if (sr.videoPath) sr.videoPath = signArtifactUrl(sr.videoPath);
      return sr;
    });
  }
  return signed;
}

/**
 * Validate an incoming artifact request's `?token=` and `?exp=` query params.
 * Returns `true` when the token is valid and not expired; `false` otherwise.
 *
 * @param {string} artifactPath - The URL path without query string.
 * @param {string|undefined} token
 * @param {string|undefined} exp
 * @returns {boolean}
 */
function isValidArtifactToken(artifactPath, token, exp) {
  if (!token || !exp) return false;
  const expMs = parseInt(exp, 10);
  if (isNaN(expMs) || Date.now() > expMs) return false;
  const expected = crypto
    .createHmac("sha256", ARTIFACT_SECRET)
    .update(`${artifactPath}:${expMs}`)
    .digest("base64url");
  // Constant-time comparison to prevent timing attacks.
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    // Buffers are different lengths — definitively invalid.
    return false;
  }
}

// ─── Serve Playwright artifacts ───────────────────────────────────────────────
// Protected by HMAC-signed ?token= query params generated by signArtifactUrl().
// <img>, <video>, and <a download> tags cannot send Authorization headers, so
// the signed URL pattern is the correct approach for browser-native media tags.

/**
 * Absolute path to the Playwright artifacts directory (screenshots, videos, traces).
 * @type {string}
 */
export const ARTIFACTS_DIR = path.join(__dirname, "..", "..", "artifacts");

app.use("/artifacts", (req, res, next) => {
  const artifactPath = "/artifacts" + req.path;
  const { token, exp } = req.query;

  if (!isValidArtifactToken(artifactPath, token, exp)) {
    return res.status(401).json({ error: "Invalid or expired artifact token." });
  }
  next();
}, express.static(ARTIFACTS_DIR, {
  setHeaders(res, fp) {
    if (fp.endsWith(".webm")) res.setHeader("Content-Type", "video/webm");
    if (fp.endsWith(".zip"))  res.setHeader("Content-Type", "application/zip");
    if (fp.endsWith(".png"))  res.setHeader("Content-Type", "image/png");
    res.setHeader("Accept-Ranges", "bytes");
    // Prevent browsers from caching artifact URLs — they contain expiring tokens.
    res.setHeader("Cache-Control", "private, no-store");
  },
}));
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

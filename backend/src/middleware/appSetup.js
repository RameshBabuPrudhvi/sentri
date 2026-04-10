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

// ─── Global middleware ────────────────────────────────────────────────────────

// Security headers: X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security, etc.
// CSP is relaxed for the SPA — tighten in production once asset hashes are known.
app.use(helmet({
  contentSecurityPolicy: false,       // SPA serves its own CSP via meta tag or nginx
  crossOriginEmbedderPolicy: false,   // required for Playwright trace viewer iframes
}));

// CORS — restrict origins in production, allow all in development.
// Set CORS_ORIGIN env var to the frontend URL (e.g. "https://sentri.example.com").
const corsOrigin = process.env.CORS_ORIGIN || "*";
if (corsOrigin === "*" && process.env.NODE_ENV === "production") {
  console.warn(
    "[Sentri] ⚠️  CORS_ORIGIN is not set — all origins are allowed. " +
    "Set CORS_ORIGIN to your frontend URL(s) in production (comma-separated)."
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

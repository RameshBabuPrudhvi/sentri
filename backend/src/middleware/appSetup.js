/**
 * appSetup.js — Express app creation, global middleware, and static file serving.
 *
 * Extracted from index.js so the app instance can be imported by tests
 * or other modules without triggering side effects (DB init, listen).
 *
 * Usage:
 *   import { app, ARTIFACTS_DIR } from "./middleware/appSetup.js";
 */

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

// ─── Global middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Serve Playwright artifacts ───────────────────────────────────────────────
export const ARTIFACTS_DIR = path.join(__dirname, "..", "..", "artifacts");
app.use("/artifacts", express.static(ARTIFACTS_DIR, {
  setHeaders(res, fp) {
    if (fp.endsWith(".webm")) res.setHeader("Content-Type", "video/webm");
    if (fp.endsWith(".zip"))  res.setHeader("Content-Type", "application/zip");
    if (fp.endsWith(".png"))  res.setHeader("Content-Type", "image/png");
    res.setHeader("Accept-Ranges", "bytes");
  },
}));

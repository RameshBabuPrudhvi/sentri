/**
 * config.js — Runner environment configuration & artifact directory setup
 *
 * Centralises all env-driven constants used by the test runner pipeline so
 * they are defined in one place and importable by any sub-module.
 *
 * Artifact directories are created eagerly on import (idempotent).
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Browser / viewport ────────────────────────────────────────────────────────
export const BROWSER_HEADLESS   = process.env.BROWSER_HEADLESS !== "false";
export const VIEWPORT_WIDTH     = parseInt(process.env.VIEWPORT_WIDTH, 10) || 1280;
export const VIEWPORT_HEIGHT    = parseInt(process.env.VIEWPORT_HEIGHT, 10) || 720;
export const NAVIGATION_TIMEOUT = parseInt(process.env.NAVIGATION_TIMEOUT, 10) || 60000;

// ── Artifact paths ────────────────────────────────────────────────────────────
export const ARTIFACTS_DIR = path.join(__dirname, "..", "..", "artifacts");
export const VIDEOS_DIR    = path.join(ARTIFACTS_DIR, "videos");
export const TRACES_DIR    = path.join(ARTIFACTS_DIR, "traces");
export const SHOTS_DIR     = path.join(ARTIFACTS_DIR, "screenshots");

[ARTIFACTS_DIR, VIDEOS_DIR, TRACES_DIR, SHOTS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/**
 * config.js — Runner environment configuration & artifact directory setup
 *
 * Centralises all env-driven constants used by the test runner pipeline so
 * they are defined in one place and importable by any sub-module.
 *
 * Also provides {@link launchBrowser} — the single place to launch Chromium
 * with the shared config (headless, args, executablePath). All modules that
 * need a browser (crawlBrowser, stateExplorer, testRunner) use this instead
 * of calling `chromium.launch()` directly.
 *
 * Artifact directories are created eagerly on import (idempotent).
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Browser / viewport ────────────────────────────────────────────────────────
export const BROWSER_HEADLESS   = process.env.BROWSER_HEADLESS !== "false";
export const VIEWPORT_WIDTH     = parseInt(process.env.VIEWPORT_WIDTH, 10) || 1280;
export const VIEWPORT_HEIGHT    = parseInt(process.env.VIEWPORT_HEIGHT, 10) || 720;
export const NAVIGATION_TIMEOUT = parseInt(process.env.NAVIGATION_TIMEOUT, 10) || 30000;
export const API_TEST_TIMEOUT  = parseInt(process.env.API_TEST_TIMEOUT, 10) || 30000;
// Per-test timeout guard — if a single browser test exceeds this, it is
// forcibly aborted so it doesn't block the worker slot indefinitely.
// Defaults to 120s (generous enough for complex flows, strict enough to
// prevent runaway tests from hanging overnight runs).
export const BROWSER_TEST_TIMEOUT = parseInt(process.env.BROWSER_TEST_TIMEOUT, 10) || 120000;

// ── Shared Chromium launch args ───────────────────────────────────────────────
// Centralised so crawlBrowser, stateExplorer, and testRunner all use the same
// config. Avoids drift when adding new flags (e.g. --disable-gpu).
export const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

/**
 * Launch a Chromium browser with the shared config.
 * All modules that need a browser should call this instead of `chromium.launch()`
 * directly, so launch args and env overrides stay in one place.
 *
 * @param {Object} [overrides] — Playwright LaunchOptions merged on top
 * @returns {Promise<Object>} Playwright Browser instance
 */
export async function launchBrowser(overrides = {}) {
  return chromium.launch({
    headless: BROWSER_HEADLESS,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: BROWSER_ARGS,
    ...overrides,
  });
}

// ── Parallel execution ────────────────────────────────────────────────────────
// Default number of concurrent browser contexts for test execution.
// Overridden per-run by Test Dials `parallelWorkers` setting.
// 1 = sequential (legacy behaviour), max 10.
export const DEFAULT_PARALLEL_WORKERS = Math.max(1, Math.min(10,
  parseInt(process.env.PARALLEL_WORKERS, 10) || 1
));

// ── Artifact paths ────────────────────────────────────────────────────────────
export const ARTIFACTS_DIR = path.join(__dirname, "..", "..", "artifacts");
export const VIDEOS_DIR    = path.join(ARTIFACTS_DIR, "videos");
export const TRACES_DIR    = path.join(ARTIFACTS_DIR, "traces");
export const SHOTS_DIR     = path.join(ARTIFACTS_DIR, "screenshots");

[ARTIFACTS_DIR, VIDEOS_DIR, TRACES_DIR, SHOTS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

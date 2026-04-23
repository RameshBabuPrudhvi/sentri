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
import { chromium, devices } from "playwright";

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

// ── Conversation limits ───────────────────────────────────────────────────────
// Maximum number of user↔assistant turn pairs to keep in the AI chat context
// window. When the conversation exceeds this, older turns in the middle are
// trimmed — keeping the first message (initial context) and the most recent
// turns. This prevents unbounded token growth without extra LLM calls.
export const MAX_CONVERSATION_TURNS = parseInt(process.env.MAX_CONVERSATION_TURNS, 10) || 20;

// ── Artifact paths ────────────────────────────────────────────────────────────
export const ARTIFACTS_DIR = path.join(__dirname, "..", "..", "artifacts");
export const VIDEOS_DIR    = path.join(ARTIFACTS_DIR, "videos");
export const TRACES_DIR    = path.join(ARTIFACTS_DIR, "traces");
export const SHOTS_DIR     = path.join(ARTIFACTS_DIR, "screenshots");
export const BASELINES_DIR = path.join(ARTIFACTS_DIR, "baselines");
export const DIFFS_DIR     = path.join(ARTIFACTS_DIR, "diffs");

[ARTIFACTS_DIR, VIDEOS_DIR, TRACES_DIR, SHOTS_DIR, BASELINES_DIR, DIFFS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── DIF-001: Visual regression ────────────────────────────────────────────────
// Pixel difference threshold above which a step is flagged as a visual regression.
// Expressed as a fraction of total pixels (0.02 = 2%). Per-pixel match tolerance
// is governed by VISUAL_DIFF_PIXEL_TOLERANCE (pixelmatch `threshold` arg, 0..1).
// Parse a float env var with a default, accepting `0` (which `|| default`
// would reject) but rejecting `NaN` from non-numeric strings (which would
// silently disable regression detection because `diffRatio > NaN` is always
// false).
function parseFloatEnv(raw, def) {
  if (raw == null || raw === "") return def;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}
export const VISUAL_DIFF_THRESHOLD       = parseFloatEnv(process.env.VISUAL_DIFF_THRESHOLD, 0.02);
export const VISUAL_DIFF_PIXEL_TOLERANCE = parseFloatEnv(process.env.VISUAL_DIFF_PIXEL_TOLERANCE, 0.1);

// ── DIF-003: Device emulation ─────────────────────────────────────────────────
// Playwright ships 50+ device profiles. We expose a curated subset for the
// run config dropdown plus accept any name from `playwright.devices`.

/**
 * Curated device profiles for the UI dropdown.
 * Each entry maps a display label to its Playwright `devices` key.
 * @type {Array<{label: string, value: string}>}
 */
export const DEVICE_PRESETS = [
  { label: "Desktop (default)",       value: "" },
  { label: "iPhone 14",              value: "iPhone 14" },
  { label: "iPhone 14 Pro Max",      value: "iPhone 14 Pro Max" },
  { label: "iPhone 12",              value: "iPhone 12" },
  { label: "iPad (gen 7)",           value: "iPad (gen 7)" },
  { label: "iPad Pro 11",            value: "iPad Pro 11" },
  { label: "Galaxy S9+",             value: "Galaxy S9+" },
  { label: "Pixel 7",               value: "Pixel 7" },
  { label: "Pixel 5",               value: "Pixel 5" },
  { label: "Galaxy Tab S4",         value: "Galaxy Tab S4" },
  { label: "Desktop Chrome HiDPI",  value: "Desktop Chrome HiDPI" },
  { label: "Desktop Firefox HiDPI", value: "Desktop Firefox HiDPI" },
];

/**
 * Resolve a device name to a Playwright device descriptor.
 * Returns `null` for empty/unknown names (caller should use default context).
 *
 * @param {string} deviceName - A key from `playwright.devices` (e.g. `"iPhone 14"`).
 * @returns {Object|null} Playwright device descriptor with viewport, userAgent, etc.
 */
export function resolveDevice(deviceName) {
  if (!deviceName) return null;
  const descriptor = devices[deviceName];
  if (!descriptor) return null;
  return descriptor;
}


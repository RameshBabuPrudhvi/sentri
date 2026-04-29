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
import { chromium, firefox, webkit, devices } from "playwright";

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

// ── DIF-002: Cross-browser support ────────────────────────────────────────────
// Centralised browser selector. Accepts `"chromium"`, `"firefox"`, or `"webkit"`.
// Invalid or empty values fall back to chromium — the safe default, since it's
// the only browser with guaranteed CDP / screencast / shadow-DOM support
// (used by the crawler, live browser view, and recorder).
//
// Per-run override flows through `runTests({ browser })` → `launchBrowser({ browser })`,
// mirroring how `device` / `locale` / `timezoneId` are already threaded.
export const BROWSER_PRESETS = [
  { label: "Chromium (default)", value: "chromium" },
  { label: "Firefox",            value: "firefox"  },
  { label: "WebKit (Safari)",    value: "webkit"   },
];
const BROWSER_ENGINES = { chromium, firefox, webkit };
export const DEFAULT_BROWSER = (() => {
  const raw = (process.env.BROWSER_DEFAULT || "chromium").toLowerCase();
  return BROWSER_ENGINES[raw] ? raw : "chromium";
})();

/**
 * Resolve a browser name string to a Playwright BrowserType.
 * Unknown values fall back to chromium so a typo doesn't crash a run.
 * Non-string truthy inputs (numbers, objects, booleans) are treated as
 * unknown rather than throwing — the route layer can pass `req.body.browser`
 * straight through without a `typeof` guard.
 *
 * @param {*} [name] - One of `"chromium"`, `"firefox"`, `"webkit"`. Case-insensitive. Non-string values fall back to chromium.
 * @returns {{ engine: Object, name: string }} The Playwright BrowserType and its canonical name.
 */
export function resolveBrowser(name) {
  const key = typeof name === "string" ? name.toLowerCase() : "";
  if (BROWSER_ENGINES[key]) return { engine: BROWSER_ENGINES[key], name: key };
  return { engine: BROWSER_ENGINES[DEFAULT_BROWSER], name: DEFAULT_BROWSER };
}

// ── Shared Chromium launch args ───────────────────────────────────────────────
// Only applied when launching chromium — firefox and webkit reject these
// flags. Centralised so crawlBrowser, stateExplorer, and testRunner all use
// the same config when they do launch chromium.
export const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

/**
 * Launch a browser with the shared config.
 * All modules that need a browser should call this instead of
 * `chromium.launch()` / `firefox.launch()` / `webkit.launch()` directly, so
 * launch args, env overrides, and the cross-browser selector stay in one
 * place.
 *
 * The browser-specific `executablePath` env var is only applied when its
 * engine is selected — e.g. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` has no
 * effect when launching firefox, where Playwright bundles its own binary.
 *
 * @param {Object} [overrides]        — Playwright LaunchOptions merged on top
 * @param {string} [overrides.browser] — `"chromium" | "firefox" | "webkit"`
 * @returns {Promise<Object>} Playwright Browser instance
 */
export async function launchBrowser(overrides = {}) {
  const { browser: browserName, ...playwrightOpts } = overrides;
  const { engine, name } = resolveBrowser(browserName);
  const launchOpts = {
    headless: BROWSER_HEADLESS,
    ...playwrightOpts,
  };
  // Chromium-specific: sandbox / shm flags + env executable path.
  // Firefox and webkit reject `--no-sandbox` and have their own bundled
  // binaries so we don't expose PLAYWRIGHT_*_EXECUTABLE_PATH for them here.
  if (name === "chromium") {
    launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    launchOpts.args = playwrightOpts.args || BROWSER_ARGS;
  }
  return engine.launch(launchOpts);
}

// ── Parallel execution ────────────────────────────────────────────────────────
// Default number of concurrent browser contexts for test execution.
// Overridden per-run by Test Dials `parallelWorkers` setting.
// 1 = sequential (legacy behaviour), max 10.
export const DEFAULT_PARALLEL_WORKERS = Math.max(1, Math.min(10,
  parseInt(process.env.PARALLEL_WORKERS, 10) || 1
));

// Automatic test retry budget (AUTO-005).
// Value is the number of retries after the first attempt.
// Parse explicitly so `MAX_TEST_RETRIES=0` (disable retries) is honoured —
// `parseInt(...) || 2` would treat 0 as falsy and silently fall back to 2.
export const MAX_TEST_RETRIES = (() => {
  const raw = process.env.MAX_TEST_RETRIES;
  const n = raw == null || raw === "" ? NaN : parseInt(raw, 10);
  const v = Number.isFinite(n) ? n : 2;
  return Math.max(0, Math.min(10, v));
})();

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

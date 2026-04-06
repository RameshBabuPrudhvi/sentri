/**
 * @module utils/testDialsStorage
 * @description Pure logic helpers for Test Dials — no React dependency.
 *
 * Handles `localStorage` persistence and active-dial counting.
 * Prompt building is handled server-side (`backend/src/testDials.js`) so the
 * backend controls what text reaches the AI.
 *
 * ### Exports
 * - {@link loadSavedConfig} — Load saved config from localStorage.
 * - {@link saveConfig} — Persist config to localStorage.
 * - {@link countActiveDials} — Count how many dials are active (non-default).
 */

import { DEFAULT_CONFIG } from "../config/testDialsConfig.js";

// ─── Storage helpers ───────────────────────────────────────────────────────────

/**
 * Load the saved Test Dials config from localStorage.
 * Falls back to `DEFAULT_CONFIG` if nothing is saved or parsing fails.
 *
 * @returns {Object} The merged config object.
 */
export function loadSavedConfig() {
  try {
    const s = localStorage.getItem("app_test_dials");
    if (!s) return { ...DEFAULT_CONFIG };
    const saved = JSON.parse(s);
    // Deep-merge options object so new toggle keys get their defaults
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      options: { ...DEFAULT_CONFIG.options, ...(saved.options || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Persist a Test Dials config to localStorage.
 * @param {Object} cfg - The config object to save.
 */
export function saveConfig(cfg) {
  try { localStorage.setItem("app_test_dials", JSON.stringify(cfg)); } catch {}
}

// ─── Count active dials ────────────────────────────────────────────────────────

/**
 * Count how many dials are active (contribute non-default signal to the AI prompt).
 *
 * @param {Object|null} cfg - The config object.
 * @returns {number} Number of active dials.
 */
export function countActiveDials(cfg) {
  if (!cfg) return 0;
  let n = 0;
  if (cfg.approach)              n++;   // approach is always set, always counts
  if (cfg.perspectives?.length)  n++;
  if (cfg.quality?.length)       n++;
  if (cfg.format)                n++;   // format always set
  if (cfg.testCount && cfg.testCount !== "ai_decides") n++;
  if (cfg.exploreMode && cfg.exploreMode !== "crawl") n++;
  if (cfg.options) {
    n += Object.values(cfg.options).filter(Boolean).length;
  }
  return n;
}

/**
 * testDialsStorage.js
 *
 * Pure logic helpers for Test Dials — no React dependency.
 * Handles localStorage persistence and active-dial counting.
 *
 * Prompt building is handled server-side (backend/src/testDials.js) so the
 * backend controls what text reaches the AI. The frontend sends the raw
 * structured config object and never constructs prompt strings.
 */

import { DEFAULT_CONFIG } from "../config/testDialsConfig.js";

// ─── Storage helpers ───────────────────────────────────────────────────────────

export function loadSavedConfig() {
  try {
    const s = localStorage.getItem("sentri_testdials");
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

export function saveConfig(cfg) {
  try { localStorage.setItem("sentri_testdials", JSON.stringify(cfg)); } catch {}
}

// ─── Count active dials ────────────────────────────────────────────────────────
// An "active" dial is one that contributes non-default signal to the AI prompt.

export function countActiveDials(cfg) {
  if (!cfg) return 0;
  let n = 0;
  if (cfg.approach)              n++;   // approach is always set, always counts
  if (cfg.perspectives?.length)  n++;
  if (cfg.quality?.length)       n++;
  if (cfg.format)                n++;   // format always set
  if (cfg.testCount && cfg.testCount !== "ai_decides") n++;
  if (cfg.options) {
    n += Object.values(cfg.options).filter(Boolean).length;
  }
  return n;
}

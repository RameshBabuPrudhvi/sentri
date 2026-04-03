/**
 * testDialsPrompt.js
 *
 * Pure logic helpers for Test Dials — no React dependency.
 *
 * Prompt building is handled server-side (backend/src/testDials.js) so the
 * backend controls what text reaches the AI.  The frontend sends the raw
 * structured config object and never constructs prompt strings.
 *
 * Exports:
 *   countActiveDials(cfg)     — count how many dial sections are active
 *   loadSavedConfig()         — read persisted config from localStorage
 *   saveConfig(cfg)           — persist config to localStorage
 */

import {
  DEFAULT_CONFIG,
} from "./testDialsData.js";

// ─── Storage helpers ───────────────────────────────────────────────────────────

export function loadSavedConfig() {
  try {
    const s = localStorage.getItem("sentri_testdials");
    return s ? { ...DEFAULT_CONFIG, ...JSON.parse(s) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg) {
  try { localStorage.setItem("sentri_testdials", JSON.stringify(cfg)); } catch {}
}

// ─── Count active dials ────────────────────────────────────────────────────────

export function countActiveDials(cfg) {
  if (!cfg) return 0;
  let n = 0;
  if (cfg.strategy) n++;
  if (cfg.workflow?.length > 0) n++;
  if (cfg.quality?.length > 0) n++;
  if (cfg.format) n++;
  return n;
}

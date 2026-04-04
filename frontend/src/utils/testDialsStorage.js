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

// ─── Migration maps for renamed IDs & fields (v1 → v2) ────────────────────────
// Old localStorage entries may contain stale IDs or field names. We migrate them
// in-place before merging with DEFAULT_CONFIG so the user's choices aren't lost.

const ID_MIGRATIONS = {
  format:    { verbose: "step_by_step", concise: "checklist" },
  testCount: { single: "one", few: "small", moderate: "medium", comprehensive: "large", auto: "ai_decides" },
  approach:  { happy_path: "positive_only", sad_path: "errors_and_edges", edge_cases: "errors_and_edges", comprehensive: "full_coverage", regression: "stability_check" },
};

const PERSPECTIVE_MIGRATION = {
  e2e: "full_journey", component: "single_component", interruptions: "interrupted_flows",
};

function migrateSaved(saved) {
  // Migrate renamed top-level field names (old key → new key)
  if (saved.strategy && !saved.approach)       saved.approach = saved.strategy;
  if (saved.workflow && !saved.perspectives)    saved.perspectives = saved.workflow;
  if (saved.preset && !saved.profile)           saved.profile = saved.preset;
  if (saved.customModifier && !saved.customInstructions) saved.customInstructions = saved.customModifier;

  // Migrate automationHooks → options.selectorHints
  if (saved.automationHooks === true && !saved.options) {
    saved.options = { selectorHints: true };
  }

  // Remove stale keys so they don't pollute the merged config
  delete saved.strategy;
  delete saved.workflow;
  delete saved.preset;
  delete saved.customModifier;
  delete saved.automationHooks;

  // Migrate renamed option IDs
  for (const [key, map] of Object.entries(ID_MIGRATIONS)) {
    if (saved[key] && map[saved[key]]) saved[key] = map[saved[key]];
  }

  // Migrate perspective IDs inside the array
  if (Array.isArray(saved.perspectives)) {
    saved.perspectives = saved.perspectives.map(id => PERSPECTIVE_MIGRATION[id] || id);
  }
}

export function loadSavedConfig() {
  try {
    const s = localStorage.getItem("sentri_testdials");
    if (!s) return { ...DEFAULT_CONFIG };
    const saved = JSON.parse(s);
    migrateSaved(saved);
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

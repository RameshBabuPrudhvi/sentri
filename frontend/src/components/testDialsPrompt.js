/**
 * testDialsPrompt.js
 *
 * Pure logic helpers for Test Dials — no React dependency.
 *
 * Exports:
 *   buildTestDialsPrompt(cfg) — serialise config → prompt string for AI
 *   countActiveDials(cfg)     — count how many dial sections are active
 *   loadSavedConfig()         — read persisted config from localStorage
 *   saveConfig(cfg)           — persist config to localStorage
 */

import {
  STRATEGY_OPTIONS,
  WORKFLOW_OPTIONS,
  QUALITY_OPTIONS,
  FORMAT_OPTIONS,
  LANGUAGES,
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

// ─── Prompt builder ────────────────────────────────────────────────────────────

export function buildTestDialsPrompt(cfg) {
  if (!cfg) return "";

  const strategy = STRATEGY_OPTIONS.find(s => s.id === cfg.strategy);
  const format   = FORMAT_OPTIONS.find(f => f.id === cfg.format);
  const workflows = WORKFLOW_OPTIONS.filter(w => cfg.workflow.includes(w.id));
  const qualities = QUALITY_OPTIONS.filter(q => cfg.quality.includes(q.id));

  const lines = [
    `TEST GENERATION CONFIGURATION:`,
    strategy  ? `- Strategy: ${strategy.label}` : "",
    workflows.length ? `- Perspectives: ${workflows.map(w => w.label).join(", ")}` : "",
    qualities.length ? `- Quality checks: ${qualities.map(q => q.label).join(", ")}` : "",
    format    ? `- Output format: ${format.label}` : "",
    cfg.language !== "en-US" ? `- Output language: ${LANGUAGES.find(l => l.code === cfg.language)?.label}` : "",
    cfg.automationHooks ? `- Include automation element ID hooks (data-testid attributes)` : "",
    cfg.customModifier?.trim() ? `- Additional requirements: ${cfg.customModifier.trim()}` : "",
  ].filter(Boolean).join("\n");

  return lines;
}

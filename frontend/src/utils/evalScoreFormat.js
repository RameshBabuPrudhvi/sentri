/**
 * @module utils/evalScoreFormat
 * @description AUTO-022 — pure score-display helpers extracted from
 * `EvalPanel.jsx` so they can be unit-tested against `node:assert/strict`
 * (matching the frontend test convention — no Vitest / no RTL).
 *
 * `formatScore` turns a [0,1] score into "85.0%" for display; `getScoreClass`
 * picks the colour-tier CSS class. Both are intentionally side-effect-free
 * so the test file can import them directly without a DOM environment.
 *
 * Industry-standard tiering: ≥0.8 healthy, ≥0.5 needs-attention, <0.5 broken.
 * Matches the green/amber/red bands used by `dash-env-rate--good/warn/bad` in
 * `dashboard.css` (DIF-012) so a future Pass Rate / Eval Quality split-view
 * stays visually consistent.
 */

/**
 * Format a [0, 1] score as a one-decimal percentage string. Returns `"—"`
 * for nullish or NaN inputs so the panel can render a placeholder without
 * a conditional at every callsite.
 *
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatScore(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Resolve the colour-tier CSS class for a score. Mirrors the threshold
 * pattern used by the DIF-012 Environments panel — green ≥ 0.8, amber 0.5–
 * 0.79, red < 0.5, grey for null/missing.
 *
 * @param {number|null|undefined} value
 * @returns {"dash-eval-score--good" | "dash-eval-score--warn" | "dash-eval-score--bad" | "dash-eval-score--none"}
 */
export function getScoreClass(value) {
  if (value == null || Number.isNaN(value)) return "dash-eval-score--none";
  if (value >= 0.8) return "dash-eval-score--good";
  if (value >= 0.5) return "dash-eval-score--warn";
  return "dash-eval-score--bad";
}

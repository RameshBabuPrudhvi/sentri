/**
 * @module utils/a11y
 * @description Shared helpers for rendering accessibility (axe-core) violations.
 *
 * Used by:
 *  - frontend/src/components/crawl/AccessibilityViolationsPanel.jsx
 *  - frontend/src/pages/Dashboard.jsx (top offenders rollup)
 */

/** Map axe-core impact levels to CSS variable colour tokens. */
export const SEVERITY_COLOR_BY_IMPACT = {
  critical: "var(--red)",
  serious: "var(--amber)",
  moderate: "var(--blue)",
  minor: "var(--text3)",
};

/**
 * Look up the colour token for an axe-core impact level.
 *
 * @param {string|null|undefined} impact
 * @param {string} fallback - colour to use when impact is missing/unknown
 * @returns {string}
 */
export function severityColor(impact, fallback = "var(--text2)") {
  return SEVERITY_COLOR_BY_IMPACT[impact] || fallback;
}

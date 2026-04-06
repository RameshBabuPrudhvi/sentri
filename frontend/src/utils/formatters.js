/**
 * @module utils/formatters
 * @description Shared date, time, and duration formatters used across pages.
 */

/**
 * Relative date — `"3m ago"`, `"5h ago"`, or `"Jan 12"`.
 *
 * @param {string|null} iso       - ISO 8601 timestamp.
 * @param {string}      [fallback="—"] - Returned when `iso` is falsy.
 * @returns {string}
 */
export function fmtRelativeDate(iso, fallback = "—") {
  if (!iso) return fallback;
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60000)    return "just now";
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Short date — `"Jan 12"` (no relative component).
 *
 * @param {string|null} iso - ISO 8601 timestamp.
 * @returns {string}
 */
export function fmtShortDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Duration between two ISO timestamps — `"1.2s"`, `"3m 12s"`, etc.
 *
 * @param {string|null} startedAt  - Start ISO timestamp.
 * @param {string|null} finishedAt - End ISO timestamp.
 * @returns {string}
 */
export function fmtDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return "—";
  return fmtDurationMs(new Date(finishedAt) - new Date(startedAt));
}

/**
 * Duration from raw milliseconds — `"1.2s"`, `"3m 12s"`, etc.
 *
 * @param {number|null} ms            - Duration in milliseconds.
 * @param {string}      [fallback="—"] - Returned when `ms` is falsy or zero.
 * @returns {string}
 */
export function fmtDurationMs(ms, fallback = "—") {
  if (!ms) return fallback;
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Pass-rate colour based on threshold.
 *
 * @param {number|null} rate - Pass rate percentage (0–100).
 * @returns {string} CSS colour variable (`"var(--green)"`, `"var(--amber)"`, `"var(--red)"`, or `"var(--text3)"`).
 */
export function passRateColor(rate) {
  if (rate == null) return "var(--text3)";
  if (rate >= 80) return "var(--green)";
  if (rate >= 50) return "var(--amber)";
  return "var(--red)";
}

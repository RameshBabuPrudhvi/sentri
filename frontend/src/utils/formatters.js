/**
 * @module utils/formatters
 * @description Shared date, time, and duration formatters used across pages.
 */

/**
 * Format milliseconds into a compact duration string.
 * Used by StepResultsView, TestDetail, and network tables.
 *
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function fmtMs(ms) {
  if (!ms && ms !== 0) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format bytes into a human-readable size string.
 *
 * @param {number|null|undefined} b
 * @returns {string}
 */
export function fmtBytes(b) {
  if (!b && b !== 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format an ISO date string as a long date (e.g. "April 8, 2026").
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Format an ISO date string as a relative/short datetime.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "less than a minute ago";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

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
 * Medium date+time — `"Apr 8, 2026, 3:45 PM"`.
 * Used by TokenManager for created/lastUsed columns.
 *
 * @param {string|null|undefined} iso - ISO 8601 timestamp.
 * @returns {string}
 */
export function fmtDateTimeMedium(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Future-relative time — `"in 5m"`, `"in 3h"`, `"in 2d"`, `"soon"`.
 * Used by ScheduleManager and ProjectHeader for next-run display.
 *
 * @param {string|null|undefined} iso - ISO 8601 timestamp (expected to be in the future).
 * @param {string} [fallback="Not scheduled"] - Returned when `iso` is falsy.
 * @returns {string}
 */
export function fmtFutureRelative(iso, fallback = "Not scheduled") {
  if (!iso) return fallback;
  const diff = new Date(iso) - Date.now();
  if (diff <= 0) return "soon";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(diff / 3_600_000);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(diff / 86_400_000);
  return `in ${days}d`;
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

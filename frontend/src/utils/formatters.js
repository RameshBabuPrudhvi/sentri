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
 * Long-form relative time — `"just now"`, `"3 minutes ago"`, `"5 hours ago"`,
 * `"2 days ago"`, `"3 months ago"`, `"1 year ago"`.
 *
 * Uses {@link Intl.RelativeTimeFormat} so the output is automatically
 * localised (Sentri ships English-only today, but switching to another
 * locale flips this for free). Differs from {@link fmtRelativeDate}, which
 * returns a fixed-format short string and falls back to a date for anything
 * older than ~24 hours — this one keeps the relative phrasing all the way
 * up to "X years ago".
 *
 * Used by Tests.jsx (run-time column) and ReviewQueue.jsx (Generated row in
 * the detail sidebar). Both pages previously inlined this logic; this is
 * the shared single-source export.
 *
 * @param {string|null|undefined} iso - ISO 8601 timestamp.
 * @param {string} [fallback="—"]     - Returned when `iso` is falsy.
 * @returns {string}
 */
const RELATIVE_TIME_UNITS = [
  { max: 60,       divisor: 1,        unit: "second" },
  { max: 3600,     divisor: 60,       unit: "minute" },
  { max: 86400,    divisor: 3600,     unit: "hour"   },
  { max: 2592000,  divisor: 86400,    unit: "day"    },
  { max: 31536000, divisor: 2592000,  unit: "month"  },
  { max: Infinity, divisor: 31536000, unit: "year"   },
];

export function fmtRelativeTimeFull(iso, fallback = "—") {
  if (!iso) return fallback;
  const diffSec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diffSec < 10) return "just now";
  for (const { max, divisor, unit } of RELATIVE_TIME_UNITS) {
    if (diffSec < max) {
      const val = Math.floor(diffSec / divisor);
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-val, unit);
    }
  }
  return fallback;
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
 * SEC-007: compliance-grade audit timestamp.
 *
 * Renders an ISO 8601 instant in UTC with second precision, e.g.
 * `"2026-05-16 13:45:22 UTC"`. Used by the AuditLog feed because SOC 2 /
 * ISO 27001 / PCI-DSS 10.3.3 require absolute, time-zone-anchored
 * timestamps on every event — relative phrasing like "5m ago" is
 * unacceptable for a compliance trail (an auditor reviewing the log
 * months later cannot correlate "5m ago" to a specific instant).
 *
 * Matches the rendering convention used by Splunk, AWS CloudTrail,
 * GitHub Audit Log, and Datadog so SIEM-importing reviewers see a
 * familiar shape.
 *
 * Why UTC, not local time:
 *   - PCI-DSS 10.6 mandates time-sync to an authoritative source.
 *     UTC is the only timezone every system agrees on.
 *   - Multi-tenant deployments have admins in many timezones; rendering
 *     in local time means two reviewers comparing the same row see two
 *     different timestamps, which an auditor will (correctly) flag.
 *
 * Format: `YYYY-MM-DD HH:MM:SS UTC` — fixed-width, sortable as text,
 * matches ISO 8601 with a space separator (which is RFC 3339 §5.6's
 * permitted human-readable variant).
 *
 * @param {string|null|undefined} iso - ISO 8601 timestamp.
 * @returns {string}
 */
export function fmtAuditTimestamp(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Use UTC getters (NOT toLocaleString) so the output is identical for
  // every reviewer regardless of browser locale or timezone.
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date} ${time} UTC`;
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

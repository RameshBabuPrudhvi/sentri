/**
 * Settings — shared formatters
 *
 * Single source of truth for the date / cost / uptime helpers previously
 * duplicated across the Settings.jsx god-file (GAP-002). Pure functions —
 * no React, no DOM, no network. Safe to import from any settings section.
 */

/** Human-readable uptime: "12s" / "3m 14s" / "2h 17m". */
export function fmtUptime(seconds) {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** "Mar 15, 2026" — used by RecycleBin + passkey list. Falls back to "—". */
export function fmtDeletedDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Mar 15, 02:17:43" — compact timestamp used by audit / request log rows. */
export function fmtAuditTimestamp(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return iso; }
}

/** Per-call AI cost. `null/NaN → "—"`, `0 → "$0"`, small values render at 5dp. */
export function fmtCost(n) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(4)}`;
}

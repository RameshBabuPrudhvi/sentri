/**
 * @module utils/runLogger
 * @description Shared logging and SSE helpers for pipeline modules.
 *
 * Appends timestamped entries to `run.logs`, prints to stdout, and broadcasts
 * via SSE for real-time frontend updates.
 *
 * ### Level-specific helpers
 * | Function        | Level   | Icon | UI colour |
 * |-----------------|---------|------|-----------|
 * | `log(run, msg)` | `info`  | —    | gray      |
 * | `logWarn`        | `warn`  | ⚠️   | amber     |
 * | `logError`       | `error` | ❌   | red       |
 * | `logSuccess`     | `info`  | ✅   | green     |
 *
 * ### Exports
 * - {@link log}, {@link logWarn}, {@link logError}, {@link logSuccess}
 * - {@link emitRunEvent} — Lazy-loaded SSE emitter (avoids circular imports).
 * - {@link ICON} — Centralised icon prefix constants.
 */

import { formatTimestamp, formatLogLine, shouldLog } from "./logFormatter.js";

// ── Centralised icon prefixes (single source of truth) ────────────────────
const ICON = {
  warn:    "⚠️ ",
  error:   "❌",
  success: "✅",
  abort:   "⛔",
};
export { ICON };

// SSE emitter — now imported directly from routes/sse.js (no circular dependency)
let _emitRunEvent = null;
export async function emitRunEvent(...args) {
  if (!_emitRunEvent) {
    try { ({ emitRunEvent: _emitRunEvent } = await import("../routes/sse.js")); } catch { return; }
  }
  _emitRunEvent?.(...args);
}

// ── Core log function ─────────────────────────────────────────────────────

/**
 * Append a timestamped log entry to the run, print to stdout, and
 * broadcast via SSE so the frontend live-log updates in real time.
 *
 * The entry stored in run.logs (and sent to the frontend) uses a compact
 * format:  [timestamp] message  (timestamp format driven by LOG_DATE_FORMAT)
 *
 * The server stdout line uses the full formatLogLine() output which
 * includes log level, run ID, and respects LOG_JSON mode:
 *   [2025-04-03T12:34:56.789Z] [INFO ] [RUN-42] Starting crawl
 *   — or in JSON mode —
 *   {"ts":"...","level":"info","runId":"RUN-42","msg":"Starting crawl"}
 *
 * @param {object} run   — mutable run record (must have .id and .logs[])
 * @param {string} msg   — human-readable log message
 * @param {"debug"|"info"|"warn"|"error"} [level="info"] — severity level
 */
export function log(run, msg, level = "info") {
  if (!shouldLog(level)) return;

  const ts = formatTimestamp();
  const entry = `[${ts}] ${msg}`;
  run.logs.push(entry);
  console.log(formatLogLine(level, run.id, msg));
  emitRunEvent(run.id, "log", { message: entry });
}

// ── Level-specific helpers ────────────────────────────────────────────────
// Centralise the emoji prefix so callers never hard-code icons.
// If the icon convention changes, update ICON above — all callers benefit.

/** Log a warning — prefixes with ⚠️, level "warn". */
export function logWarn(run, msg) {
  log(run, `${ICON.warn} ${msg}`, "warn");
}

/** Log an error — prefixes with ❌, level "error". */
export function logError(run, msg) {
  log(run, `${ICON.error} ${msg}`, "error");
}

/** Log a success — prefixes with ✅, level "info". */
export function logSuccess(run, msg) {
  log(run, `${ICON.success} ${msg}`);
}

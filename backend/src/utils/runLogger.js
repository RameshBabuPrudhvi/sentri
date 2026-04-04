/**
 * runLogger.js — Shared logging & SSE helpers for pipeline modules
 *
 * Extracts the duplicated lazy-import emitRunEvent wrapper and log()
 * function that were copy-pasted across crawler.js and testRunner.js.
 *
 * Timestamp format, log level, and output mode (human / JSON) are
 * controlled via .env — see logFormatter.js for details:
 *   LOG_LEVEL, LOG_DATE_FORMAT, LOG_TIMEZONE, LOG_JSON
 *
 * ── Level-specific helpers ────────────────────────────────────────────────
 *
 * Instead of passing raw emoji + level strings at every call-site, use the
 * dedicated helpers so icon conventions are centralised here:
 *
 *   log(run, msg)           — INFO  (no prefix, gray in UI)
 *   logWarn(run, msg)       — WARN  (⚠️  prefix, amber in UI)
 *   logError(run, msg)      — ERROR (❌ prefix, red in UI)
 *   logSuccess(run, msg)    — INFO  (✅ prefix, green in UI)
 *
 * If an icon change is needed in future (e.g. swap ❌ → 🔴), update the
 * single constant below — every caller benefits automatically.
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

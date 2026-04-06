/**
 * @module utils/logFormatter
 * @description Centralised log formatting with `.env`-driven configuration.
 *
 * ### Environment variables
 * | Variable          | Default  | Description                                    |
 * |-------------------|----------|------------------------------------------------|
 * | `LOG_LEVEL`       | `"info"` | Minimum severity: `debug` / `info` / `warn` / `error` |
 * | `LOG_DATE_FORMAT` | `"iso"`  | Timestamp format: `iso` / `utc` / `local` / `epoch`   |
 * | `LOG_TIMEZONE`    | system   | IANA timezone for `local` format               |
 * | `LOG_JSON`        | `"false"`| `"true"` to emit structured JSON lines         |
 *
 * ### Exports
 * - {@link formatTimestamp} — Produce a formatted timestamp string.
 * - {@link formatLogLine} — Format a complete log line for stdout.
 * - {@link shouldLog} — Check if a level should be printed.
 * - {@link LOG_LEVEL} — Configured minimum log level (numeric).
 */

// ─── Log levels ───────────────────────────────────────────────────────────────
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
export const LOG_LEVEL = LEVELS[configuredLevel] ?? LEVELS.info;

/**
 * Returns true if the given level should be printed based on LOG_LEVEL.
 * @param {"debug"|"info"|"warn"|"error"} level
 */
export function shouldLog(level) {
  return (LEVELS[level] ?? LEVELS.info) >= LOG_LEVEL;
}

// ─── Timestamp formatting ─────────────────────────────────────────────────────
const dateFormat = (process.env.LOG_DATE_FORMAT || "iso").toLowerCase();
const timezone = process.env.LOG_TIMEZONE || undefined; // undefined = system default

/**
 * Produce a formatted timestamp string according to LOG_DATE_FORMAT.
 *
 * @param {Date} [date] — defaults to now
 * @returns {string}
 */
export function formatTimestamp(date) {
  const d = date || new Date();
  switch (dateFormat) {
    case "epoch":
      return String(d.getTime());
    case "utc":
      return d.toUTCString();
    case "local":
      try {
        return d.toLocaleString("en-US", {
          timeZone: timezone,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false, fractionalSecondDigits: 3,
        });
      } catch {
        // Invalid timezone — fall through to ISO
        return d.toISOString();
      }
    case "iso":
    default:
      return d.toISOString();
  }
}

// ─── Structured log line ──────────────────────────────────────────────────────
const jsonMode = (process.env.LOG_JSON || "false").toLowerCase() === "true";

/**
 * Format a complete log line for server stdout.
 *
 * When LOG_JSON=true, emits a single-line JSON object:
 *   {"ts":"...","level":"info","runId":"RUN-42","msg":"Starting crawl"}
 *
 * Otherwise emits the human-readable format:
 *   [2025-04-03T12:34:56.789Z] [INFO] [RUN-42] Starting crawl
 *
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} runId
 * @param {string} msg
 * @returns {string}
 */
export function formatLogLine(level, runId, msg) {
  const ts = formatTimestamp();
  if (jsonMode) {
    return JSON.stringify({ ts, level, runId: runId || undefined, msg });
  }
  const tag = level.toUpperCase().padEnd(5);
  const rid = runId ? ` [${runId}]` : "";
  return `[${ts}] [${tag}]${rid} ${msg}`;
}

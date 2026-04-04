/**
 * runLogger.js — Shared logging & SSE helpers for pipeline modules
 *
 * Extracts the duplicated lazy-import emitRunEvent wrapper and log()
 * function that were copy-pasted across crawler.js and testRunner.js.
 */

// Lazy SSE emitter — avoids circular-import issues with index.js
let _emitRunEvent = null;
export async function emitRunEvent(...args) {
  if (!_emitRunEvent) {
    try { ({ emitRunEvent: _emitRunEvent } = await import("../index.js")); } catch { return; }
  }
  _emitRunEvent?.(...args);
}

/**
 * Append a timestamped log entry to the run, print to stdout, and
 * broadcast via SSE so the frontend live-log updates in real time.
 *
 * The entry stored in run.logs (and sent to the frontend) uses a compact
 * format:  [ISO-timestamp] message
 *
 * The server stdout line includes the run ID so concurrent runs are
 * distinguishable in aggregated server logs:
 *   [ISO-timestamp] [RUN-42] message
 */
export function log(run, msg) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${msg}`;
  run.logs.push(entry);
  console.log(`[${ts}] [${run.id}] ${msg}`);
  emitRunEvent(run.id, "log", { message: entry });
}

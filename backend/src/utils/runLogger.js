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
 */
export function log(run, msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  run.logs.push(entry);
  console.log(entry);
  emitRunEvent(run.id, "log", { message: entry });
}

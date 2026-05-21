/**
 * @module utils/structuredLog
 * @description INF-007 / MNT-013 — Semantic lifecycle events with OTel span
 * context + per-request correlation ID.
 *
 * Split out from `logFormatter.js` per NEXT.md INF-007 "Files to change". The
 * separation reflects two distinct logging concerns:
 *
 * - **`logFormatter.js`** — free-form human/JSON log lines (timestamps, levels,
 *   runId, requestId). One call per emitted message.
 * - **`structuredLog.js`** (this file) — *semantic* lifecycle events with
 *   stable event names (`run.start`, `pipeline.classify`, `crawl.complete`)
 *   that can be filtered by log aggregators, indexed by APMs, and joined to
 *   trace spans via `traceId` / `spanId` attributes.
 *
 * Every event automatically carries the active OTel span context when the
 * SDK is running. This is the trace ↔ log correlation pivot that lets
 * operators jump from a slow span in Jaeger straight to its log lines in
 * Loki / Datadog Logs / ELK.
 *
 * ### Output modes
 * - `LOG_JSON=true` → single-line JSON object suitable for ingestion:
 *   `{"ts":"…","event":"run.start","requestId":"…","traceId":"…","spanId":"…","runId":"RUN-42","tests":5}`
 * - `LOG_JSON=false` (default) → KV-style human line:
 *   `[2026-05-16T12:34:56.789Z] [EVENT] run.start requestId=… traceId=… spanId=… runId=RUN-42 tests=5`
 *
 * Undefined / null property values are stripped from both outputs so the
 * "no OTel" case doesn't produce noisy `traceId=undefined spanId=undefined`
 * lines (verified by `backend/tests/observability.test.js`).
 *
 * ### Re-export
 * `logFormatter.js` re-exports `structuredLog` from this module so the ~50
 * existing call sites that import from there keep working unchanged — no
 * mass rename was needed when extracting the function.
 */

import { formatTimestamp, shouldLog } from "./logFormatter.js";
import { getRequestId, getSpanContext } from "./observability.js";

const jsonMode = (process.env.LOG_JSON || "false").toLowerCase() === "true";

/**
 * Emit a structured lifecycle event to stdout.
 *
 * Use this for machine-filterable lifecycle events (run start/end, browser
 * launch, pipeline stage transitions). Use `formatLogLine()` from
 * `logFormatter.js` for free-form human-readable messages.
 *
 * @param {string} event - Semantic event name (e.g. `"run.start"`, `"crawl.complete"`).
 * @param {Object} [props] - Structured key-value pairs to include alongside
 *   the auto-injected `requestId` / `traceId` / `spanId`.
 */
export function structuredLog(event, props = {}) {
  if (!shouldLog("info")) return;
  const ts = formatTimestamp();
  const span = getSpanContext();
  const requestId = getRequestId() || undefined;
  if (jsonMode) {
    // `JSON.stringify` drops undefined keys natively, so the OTel-disabled
    // path emits a clean object without `traceId: undefined` noise.
    console.log(JSON.stringify({
      ts,
      event,
      requestId,
      traceId: span?.traceId,
      spanId: span?.spanId,
      ...props,
    }));
  } else {
    const merged = {
      requestId,
      traceId: span?.traceId,
      spanId: span?.spanId,
      ...props,
    };
    const kvPairs = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    console.log(`[${ts}] [EVENT] ${event}${kvPairs ? " " + kvPairs : ""}`);
  }
}

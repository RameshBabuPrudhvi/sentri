/**
 * @module hooks/useRunSSE
 * @description SSE (Server-Sent Events) hook for real-time run monitoring.
 *
 * Opens a stream at `GET /api/runs/:runId/events` and dispatches events
 * to the caller. Reconnects with exponential backoff; falls back to polling
 * after 5 consecutive failures.
 *
 * ### Side-effects
 * - Updates the page favicon to ⏳/✅/❌ to reflect run state.
 *
 * ### Exports
 * - {@link useRunSSE} — The hook itself.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { API_BASE } from "../utils/apiBase.js";

/** localStorage key — must match AuthContext.jsx and api.js */
const TOKEN_KEY = "app_auth_token";

/** Read the stored JWT token for SSE and polling requests. */
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

// ── Favicon badge ─────────────────────────────────────────────────────────────

function setFaviconStatus(status) {
  try {
    const emoji = status === "running"   ? "⏳"
                : status === "completed" ? "✅"
                : "❌";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d");
    ctx.font = "24px serif";
    ctx.fillText(emoji, 2, 26);
    const link = document.querySelector('link[rel="icon"]') ||
                 Object.assign(document.createElement("link"), { rel: "icon" });
    if (!link.parentNode) document.head.appendChild(link);
    link.href = canvas.toDataURL();
  } catch { /* non-fatal */ }
}

function resetFavicon() {
  try {
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = "/favicon.ico";
  } catch { /* non-fatal */ }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS   = 30000;
const MAX_SSE_RETRIES  = 5;

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Hook that opens an SSE stream for real-time run monitoring.
 *
 * Pass `initialStatus` (e.g. `"completed"` / `"failed"`) to skip SSE entirely
 * for runs that are already finished — prevents spurious "done" events
 * when reopening a historical run.
 *
 * @param {string|null}    runId         - The run ID to monitor (e.g. `"RUN-1"`).
 * @param {Function}       onEvent       - Callback: `({ type, ...payload }) => void`.
 * @param {string|undefined} initialStatus - Initial run status; `undefined` = still loading.
 * @returns {{ sseDown: boolean }} `sseDown` is `true` when in polling fallback mode.
 */
export function useRunSSE(runId, onEvent, initialStatus) {
  const onEventRef    = useRef(onEvent);
  const doneRef       = useRef(false);
  const esRef         = useRef(null);
  const retryTimer    = useRef(null);
  const pollTimer     = useRef(null);
  const retryCount    = useRef(0);
  const [sseDown, setSseDown] = useState(false);
  const [retryIn, setRetryIn] = useState(null);  // seconds until next reconnect attempt
  const countdownRef  = useRef(null);

  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  // ── Polling fallback ──────────────────────────────────────────────────────
  const startPolling = useCallback(() => {
    setSseDown(true);
    const poll = async () => {
      if (doneRef.current) return;
      try {
        const headers = {};
        const tk = getToken();
        if (tk) headers["Authorization"] = `Bearer ${tk}`;
        const res = await fetch(`${API_BASE}/api/runs/${runId}`, { headers });
        if (res.ok) {
          const run = await res.json();
          onEventRef.current?.({ type: "snapshot", run });
          if (run.status !== "running") {
            doneRef.current = true;
            setFaviconStatus(run.status);
            onEventRef.current?.({ type: "done", status: run.status, passed: run.passed, failed: run.failed, testsGenerated: run.testsGenerated });
            return;
          }
        }
      } catch { /* network error — retry next interval */ }
      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
  }, [runId]);

  // ── SSE connect with exponential backoff ──────────────────────────────────
  const connect = useCallback(() => {
    if (!runId || doneRef.current) return;

    // EventSource cannot send custom headers, so pass the JWT as a query param.
    // The backend requireAuth middleware accepts ?token= as a fallback.
    const tk = getToken();
    const sseUrl = `${API_BASE}/api/runs/${runId}/events${tk ? `?token=${encodeURIComponent(tk)}` : ""}`;
    const es = new EventSource(sseUrl);
    esRef.current = es;

    es.onmessage = (e) => {
      let parsed;
      try { parsed = JSON.parse(e.data); } catch { return; }

      retryCount.current = 0;
      setSseDown(false);
      setRetryIn(null);
      clearInterval(countdownRef.current);

      onEventRef.current?.(parsed);

      if (parsed.type === "snapshot" && parsed.run?.status === "running") {
        setFaviconStatus("running");
      }

      if (parsed.type === "done") {
        doneRef.current = true;
        es.close();
        setFaviconStatus(parsed.status ?? "completed");
      }
    };

    es.onerror = (evt) => {
      es.close();
      if (doneRef.current) return;

      retryCount.current += 1;

      // Log SSE disconnect so ECONNRESET-style failures are visible in devtools
      // without confusing the user — this is expected during long AI operations.
      console.debug(`[useRunSSE] SSE disconnected (attempt ${retryCount.current}/${MAX_SSE_RETRIES}), reconnecting…`);

      if (retryCount.current > MAX_SSE_RETRIES) {
        startPolling();
        return;
      }

      // Exponential backoff: 1.5 s, 3 s, 6 s, 12 s … capped at 30 s
      const delay = Math.min(1500 * Math.pow(2, retryCount.current - 1), MAX_BACKOFF_MS);
      // Start a visible countdown so the user knows when reconnection will be attempted
      let remaining = Math.ceil(delay / 1000);
      setRetryIn(remaining);
      clearInterval(countdownRef.current);
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) { clearInterval(countdownRef.current); setRetryIn(null); }
        else setRetryIn(remaining);
      }, 1000);
      retryTimer.current = setTimeout(connect, delay);
    };
  }, [runId, startPolling]);

  useEffect(() => {
    if (!runId) return;

    // Wait until the caller has resolved the initial run status before deciding
    // whether to open an SSE connection. When initialStatus is undefined the
    // initial fetch hasn't completed yet — connecting now would bypass the
    // "already done" guard and fire spurious "done" events for historical runs.
    if (initialStatus === undefined) return;

    // If the run is already finished, skip SSE/polling entirely.
    // This prevents spurious "done" events every time the user navigates
    // back to a historical run detail page.
    const alreadyDone = initialStatus && initialStatus !== "running";
    if (alreadyDone) {
      doneRef.current = true;
      setFaviconStatus(initialStatus);
      return () => { resetFavicon(); };
    }

    doneRef.current    = false;
    retryCount.current = 0;
    setSseDown(false);
    setFaviconStatus("running");
    connect();

    return () => {
      doneRef.current = true;
      clearTimeout(retryTimer.current);
      clearTimeout(pollTimer.current);
      clearInterval(countdownRef.current);
      esRef.current?.close();
      resetFavicon();
    };
  }, [connect, runId, initialStatus]);

  return { sseDown, retryIn };
}

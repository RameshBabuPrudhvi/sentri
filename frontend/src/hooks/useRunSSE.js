import { useEffect, useRef, useCallback, useState } from "react";

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

// ── Browser notification ──────────────────────────────────────────────────────

export async function requestNotifPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function sendRunCompleteNotification(passed, failed) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification("Run complete", {
      body: `${passed ?? 0} passed · ${failed ?? 0} failed`,
      icon: "/favicon.ico",
    });
  } catch { /* non-fatal */ }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS   = 30000;
const MAX_SSE_RETRIES  = 5;

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useRunSSE(runId, onEvent, initialStatus)
 *
 * Opens an SSE stream at GET /api/runs/:runId/events.
 * Fires onEvent({ type, ...payload }) for every event.
 *
 * Pass `initialStatus` (e.g. "completed" / "failed") to skip SSE entirely
 * for runs that are already finished — prevents spurious "Run complete"
 * browser notifications when reopening a historical run.
 *
 * Resilience:
 *   - Reconnects with exponential backoff (1.5s → 3s → 6s … capped at 30s)
 *   - After MAX_SSE_RETRIES consecutive failures, falls back to polling every 5s
 *   - Returns { sseDown } — true when in polling fallback mode
 *
 * Side-effects:
 *   - Updates the page favicon to ⏳/✅/❌ to reflect run state
 *   - Fires a browser Notification on the "done" event (if permission granted)
 */
export function useRunSSE(runId, onEvent, initialStatus) {
  const onEventRef    = useRef(onEvent);
  const doneRef       = useRef(false);
  const esRef         = useRef(null);
  const retryTimer    = useRef(null);
  const pollTimer     = useRef(null);
  const retryCount    = useRef(0);
  const [sseDown, setSseDown] = useState(false);

  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  // ── Polling fallback ──────────────────────────────────────────────────────
  const startPolling = useCallback(() => {
    setSseDown(true);
    const poll = async () => {
      if (doneRef.current) return;
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (res.ok) {
          const run = await res.json();
          onEventRef.current?.({ type: "snapshot", run });
          if (run.status !== "running") {
            doneRef.current = true;
            setFaviconStatus(run.status);
            sendRunCompleteNotification(run.passed, run.failed);
            onEventRef.current?.({ type: "done", status: run.status, passed: run.passed, failed: run.failed });
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

    const es = new EventSource(`/api/runs/${runId}/events`);
    esRef.current = es;

    es.onmessage = (e) => {
      let parsed;
      try { parsed = JSON.parse(e.data); } catch { return; }

      retryCount.current = 0;
      setSseDown(false);

      onEventRef.current?.(parsed);

      if (parsed.type === "snapshot" && parsed.run?.status === "running") {
        setFaviconStatus("running");
      }

      if (parsed.type === "done") {
        doneRef.current = true;
        es.close();
        setFaviconStatus(parsed.status ?? "completed");
        sendRunCompleteNotification(parsed.passed, parsed.failed);
      }
    };

    es.onerror = () => {
      es.close();
      if (doneRef.current) return;

      retryCount.current += 1;

      if (retryCount.current > MAX_SSE_RETRIES) {
        startPolling();
        return;
      }

      // Exponential backoff: 1.5 s, 3 s, 6 s, 12 s … capped at 30 s
      const delay = Math.min(1500 * Math.pow(2, retryCount.current - 1), MAX_BACKOFF_MS);
      retryTimer.current = setTimeout(connect, delay);
    };
  }, [runId, startPolling]);

  useEffect(() => {
    if (!runId) return;

    // Wait until the caller has resolved the initial run status before deciding
    // whether to open an SSE connection. When initialStatus is undefined the
    // initial fetch hasn't completed yet — connecting now would bypass the
    // "already done" guard and fire spurious browser notifications for
    // historical runs.
    if (initialStatus === undefined) return;

    // If the run is already finished, skip SSE/polling entirely.
    // This prevents a spurious "Run complete" browser notification every time
    // the user navigates back to a historical run detail page.
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
      esRef.current?.close();
      resetFavicon();
    };
  }, [connect, runId, initialStatus]);

  return { sseDown };
}

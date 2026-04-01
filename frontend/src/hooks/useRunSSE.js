import { useEffect, useRef, useCallback } from "react";

/**
 * useRunSSE(runId, onEvent)
 *
 * Opens a Server-Sent Event stream at GET /api/runs/:runId/events.
 * Calls onEvent({ type, ...payload }) for every event received.
 *
 * Reconnect strategy:
 *   - On unexpected close (network blip) the hook waits 1.5 s then reopens.
 *   - Once a "done" event arrives the stream is closed and no reconnect occurs.
 *   - When the component unmounts the stream is closed cleanly.
 */
export function useRunSSE(runId, onEvent) {
  const esRef       = useRef(null);
  const onEventRef  = useRef(onEvent);
  const doneRef     = useRef(false);
  const retryTimer  = useRef(null);

  // Keep the callback ref fresh without tearing down the connection
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  const connect = useCallback(() => {
    if (!runId || doneRef.current) return;

    const es = new EventSource(`/api/runs/${runId}/events`);
    esRef.current = es;

    es.onmessage = (e) => {
      let parsed;
      try { parsed = JSON.parse(e.data); } catch { return; }

      onEventRef.current?.(parsed);

      if (parsed.type === "done") {
        doneRef.current = true;
        es.close();
      }
    };

    es.onerror = () => {
      es.close();
      if (doneRef.current) return;
      // Reconnect after 1.5 s
      retryTimer.current = setTimeout(connect, 1500);
    };
  }, [runId]);

  useEffect(() => {
    doneRef.current = false;
    connect();

    return () => {
      doneRef.current = true; // prevent reconnect on unmount
      clearTimeout(retryTimer.current);
      esRef.current?.close();
    };
  }, [connect]);
}

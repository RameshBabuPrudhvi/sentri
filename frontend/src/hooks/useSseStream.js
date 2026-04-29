/**
 * @module hooks/useSseStream
 * @description Low-level SSE consumer that dispatches parsed events to a
 * caller-supplied handler. Designed for components that subscribe to the
 * backend's `data:`-only SSE channel (no `event:` field) where the event
 * type is encoded INSIDE the JSON payload as `{ type, ... }`.
 *
 * The recorder's earlier `addEventListener("frame", ...)` pattern silently
 * swallowed every frame because the server never emits a named "frame"
 * event — it sends generic `data:` lines. Centralising the parse path here
 * makes that bug structurally impossible: callers receive already-parsed
 * objects.
 *
 * Callers that need favicon updates, polling fallback, or "Run complete"
 * notifications should use {@link useRunSSE} instead — it wraps additional
 * lifecycle policy on top of this primitive's parse-and-dispatch.
 *
 * @example
 * useSseStream(`${API_PATH}/runs/${sid}/events`, (event) => {
 *   if (event.type === "frame") setFrames([event.data]);
 * }, Boolean(sid));
 */

import { useEffect, useRef } from "react";

/**
 * Subscribe to an SSE endpoint and dispatch parsed JSON events.
 *
 * @param {string|null|undefined} url      - Full SSE URL. Falsy → no connection.
 * @param {(event: Object) => void} onEvent - Called once per parsed event.
 * @param {boolean} [enabled=true]         - When false, no connection is opened.
 * @returns {void}
 */
export function useSseStream(url, onEvent, enabled = true) {
  // Mirror the latest callback in a ref so the effect closure always sees
  // the current handler without re-opening the connection on every render.
  const handlerRef = useRef(onEvent);
  useEffect(() => { handlerRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    if (!enabled || !url) return undefined;
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (ev) => {
      let parsed;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      handlerRef.current?.(parsed);
    };
    // Keep failures silent here — EventSource auto-reconnects, and callers
    // that need user-facing reconnection state should use useRunSSE.
    es.onerror = () => {};
    return () => {
      try { es.close(); } catch { /* already closed */ }
    };
  }, [url, enabled]);
}

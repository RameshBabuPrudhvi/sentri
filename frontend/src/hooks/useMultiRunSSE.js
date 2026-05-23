/**
 * @module hooks/useMultiRunSSE
 * @description Multi-run SSE subscription manager — G9 (parallel runs).
 *
 * Sibling of `useRunSSE` for the parallel-runs case. `useRunSSE` mounts
 * one EventSource per call and is called once per render — it can't be
 * looped, so it can't scale to N concurrent runs. This hook manages an
 * internal `Map<runId, EventSource>` and exposes a subscribe/unsubscribe
 * API the parent can call imperatively from an effect.
 *
 * ### Contract
 *
 *   const sse = useMultiRunSSE();
 *
 *   useEffect(() => {
 *     if (!runId) return;
 *     const handle = sse.subscribe(runId, {
 *       status: "running",
 *       onEvent: (evt) => { … },        // snapshot | update | log | agent_event | done
 *       onConnectionChange: ({ sseDown, retryIn }) => { … },
 *     });
 *     return () => handle.unsubscribe();
 *   }, [runId]);
 *
 * ### Connection-pool cap
 *
 * Browsers cap concurrent SSE connections at ~6 per origin. This hook
 * doesn't enforce its own cap — it trusts the caller to limit how many
 * runs are simultaneously attached (TestLab's drawer caps at 4 visible
 * runs; the Queue tab opens any remaining runs in REST-only mode).
 *
 * ### Polling fallback — deliberately NOT here
 *
 * `useRunSSE` falls back to REST polling when SSE is unavailable for
 * >5s. Multi-run UI doesn't need this: if SSE is down, ALL N runs are
 * equally broken and the right answer is one page-level "live updates
 * unavailable" banner, not N parallel poll loops hammering the server.
 * The hook surfaces `sseDown: true` via `onConnectionChange` so the
 * parent can render that banner once.
 *
 * ### `done` cleanup
 *
 * The hook closes the underlying EventSource when the SSE `done` event
 * fires (the run is terminal — no more updates), but does NOT call
 * `unsubscribe` for the caller. The parent decides whether a completed
 * run should stay in the drawer (dismissable) or vanish immediately.
 * The `done` event still flows through `onEvent`; only the network
 * connection closes.
 */
import { useEffect, useRef, useState, useCallback } from "react";
// ── Configuration ────────────────────────────────────────────────────────────
/** Initial reconnect delay (ms). Doubles up to `MAX_RECONNECT_MS`. */
const RECONNECT_BASE_MS = 1000;
/** Reconnect ceiling — beyond this we keep retrying at the ceiling rate
 *  and the parent's `sseDown: true` banner stays visible until the
 *  connection recovers. */
const MAX_RECONNECT_MS = 30_000;
// ── Per-subscription internal record ─────────────────────────────────────────
//
// Stored in `subscriptionsRef.current: Map<runId, Subscription>`. Never
// surfaced to React state — the hook's only state-driven output is the
// `activeRunIds` array below, which is recomputed from the Map on every
// mutation.
//
// Each record carries its own EventSource + timer + status flags. The
// callbacks (`onEvent` / `onConnectionChange`) are stored verbatim from
// the caller's `subscribe()` invocation; we never reach into React state
// from the hook so the callbacks are the parent's only escape hatch.
// ── Public handle ────────────────────────────────────────────────────────────
class SubscriptionHandle {
  constructor(unsubscribe) {
    this.unsubscribe = unsubscribe;
  }
}
// ── The hook ─────────────────────────────────────────────────────────────────
/**
 * @returns {{
 *   subscribe: (runId: string, opts: {
 *     status?: string,
 *     onEvent: (event: Object) => void,
 *     onConnectionChange?: (state: { sseDown: boolean, retryIn: number|null }) => void,
 *   }) => SubscriptionHandle,
 *   activeRunIds: string[],
 * }}
 */
export function useMultiRunSSE() {
  const subscriptionsRef = useRef(new Map());
  const [activeRunIds, setActiveRunIds] = useState([]);
  // Recompute the public `activeRunIds` array from the live Map. Called
  // after every subscribe/unsubscribe. Wrapped so React's reference
  // equality only triggers a re-render when the SET of runIds changes,
  // not on every internal event delivery.
  const refreshActiveRunIds = useCallback(() => {
    setActiveRunIds(prev => {
      const next = Array.from(subscriptionsRef.current.keys());
      if (prev.length !== next.length) return next;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] !== next[i]) return next;
      }
      return prev;
    });
  }, []);
  // ── Close + clear timers on a subscription, but keep the record ──────
  // Called from both the user-initiated `unsubscribe()` path and the
  // `done`-event auto-close path. Idempotent: safe to call twice.
  const teardownConnection = useCallback((sub) => {
    if (sub._heartbeatTimer) {
      clearTimeout(sub._heartbeatTimer);
      sub._heartbeatTimer = null;
    }
    if (sub._reconnectTimer) {
      clearTimeout(sub._reconnectTimer);
      sub._reconnectTimer = null;
    }
    if (sub._es) {
      try { sub._es.close(); } catch { /* already closed */ }
      sub._es = null;
    }
  }, []);
  // ── Schedule a reconnect with exponential backoff ────────────────────
  // Called from the `error` event handler. Doubles the delay each
  // attempt up to MAX_RECONNECT_MS. The countdown is delivered to the
  // consumer via `onConnectionChange({ sseDown: true, retryIn: <seconds> })`
  // so the UI can render "Reconnecting in Ns…" if it wants.
  const scheduleReconnect = useCallback((sub) => {
    if (sub._terminated) return;
    // Tear down current connection (EventSource auto-reconnects on its
    // own, but its reconnect cadence is browser-controlled and we want
    // our own backoff for visibility/observability).
    teardownConnection(sub);
    const delayMs = Math.min(sub._reconnectDelay, MAX_RECONNECT_MS);
    // Surface to the consumer. retryIn is in SECONDS (matches the
    // pattern useRunSSE uses for its banner timer).
    if (sub.onConnectionChange) {
      try {
        sub.onConnectionChange({
          sseDown: true,
          retryIn: Math.ceil(delayMs / 1000),
        });
      } catch { /* consumer threw — never let that break the pool */ }
    }
    sub._reconnectTimer = setTimeout(() => {
      sub._reconnectTimer = null;
      sub._reconnectDelay = Math.min(sub._reconnectDelay * 2, MAX_RECONNECT_MS);
      openEventSource(sub);
    }, delayMs);
  }, [teardownConnection]);
  // ── Open the EventSource for a subscription ──────────────────────────
  const openEventSource = useCallback((sub) => {
    if (sub._terminated) return;
    if (sub._es) return; // already connected
    // Short-circuit when the caller declared the run is already terminal.
    // Synthesize a `done` event so the consumer's handler still fires
    // (mirrors what useRunSSE does for stale runs — caller can't tell
    // the difference between "we connected, got snapshot, got done" and
    // "we never connected because the run was already done").
    if (sub.status && sub.status !== "running" && sub.status !== "queued") {
      try {
        sub.onEvent({ type: "done", status: sub.status });
      } catch { /* swallow */ }
      sub._terminated = true;
      return;
    }
    // EventSource URL mirrors useRunSSE. Auth flows via the same cookie
    // the rest of the app uses (same-origin GET — the browser attaches
    // it automatically). `withCredentials: true` is the explicit signal
    // that we want cookies even on a CORS path, defensive but harmless
    // on same-origin.
    const url = `/api/v1/runs/${encodeURIComponent(sub.runId)}/events`;
    let es;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch (err) {
      // EventSource constructor can throw on malformed URL or DOM-detach
      // race (rare). Schedule a retry rather than crash.
      scheduleReconnect(sub);
      return;
    }
    sub._es = es;
    // ── open: signal recovery to the consumer ──
    // Resets the backoff so the next disconnect starts fresh.
    es.onopen = () => {
      if (sub._terminated) {
        // Race: consumer unsubscribed between EventSource constructor
        // and onopen. Tear down and bail.
        teardownConnection(sub);
        return;
      }
      sub._reconnectDelay = RECONNECT_BASE_MS;
      if (sub.onConnectionChange) {
        try {
          sub.onConnectionChange({ sseDown: false, retryIn: null });
        } catch { /* swallow */ }
      }
    };
    // ── message: parse JSON and forward to consumer ──
    es.onmessage = (raw) => {
      if (sub._terminated) return;
      let event;
      try {
        event = JSON.parse(raw.data);
      } catch {
        // Malformed payload. Don't reconnect — the connection itself is
        // healthy, only this one frame is bad. Skip and wait for the
        // next message.
        return;
      }
      // Deliver to consumer first. If the consumer's handler throws,
      // we still want to honour the `done` cleanup below.
      try {
        sub.onEvent(event);
      } catch (err) {
        // Consumer error. Log via console (no formatter import to keep
        // the hook dependency-free). Continue — do not let one bad
        // consumer crash sibling subscriptions.
        // eslint-disable-next-line no-console
        console.warn(`[useMultiRunSSE] onEvent threw for runId=${sub.runId}:`, err);
      }
      // Terminal event — close the connection but keep the subscription
      // record alive so the parent can read the final state. The parent
      // is responsible for calling unsubscribe() when it's done with
      // the run (e.g. user dismisses the drawer card).
      if (event && event.type === "done") {
        sub._terminated = true;
        teardownConnection(sub);
      }
    };
    // ── error: schedule a reconnect ──
    // The browser's built-in EventSource reconnect fires here too, but
    // we take over to enforce our own backoff cadence + give the
    // consumer a `retryIn` countdown.
    es.onerror = () => {
      if (sub._terminated) return;
      // EventSource fires `error` on transient disconnects too. We close
      // and schedule our own reconnect rather than let the browser's
      // (uncontrolled) one fight ours.
      scheduleReconnect(sub);
    };
  }, [scheduleReconnect, teardownConnection]);
  // ── unsubscribe: idempotent cleanup ──────────────────────────────────
  // Declared BEFORE `subscribe` so the latter can reference it inside
  // its closure body without a TDZ violation and without an ESLint
  // `react-hooks/exhaustive-deps` warning. Pre-fix the order was
  // subscribe → unsubscribe, which works in practice (closures resolve
  // at call time, not capture time) but the linter flags it and a
  // future change to `teardownConnection` or `refreshActiveRunIds`'
  // dep arrays would silently flip `unsubscribe`'s identity per-render,
  // leaving `subscribe`'s captured reference stale. Hoisting eliminates
  // the invariant.
  //
  // Safe to call after `done` has already auto-closed the connection —
  // the record is just removed from the Map.
  const unsubscribe = useCallback((runId) => {
    const sub = subscriptionsRef.current.get(runId);
    if (!sub) return;
    sub._terminated = true;
    teardownConnection(sub);
    subscriptionsRef.current.delete(runId);
    refreshActiveRunIds();
  }, [teardownConnection, refreshActiveRunIds]);

  // ── subscribe: caller-facing API ─────────────────────────────────────
  const subscribe = useCallback((runId, opts = {}) => {
    if (!runId) {
      // Defensive: caller passed a falsy runId. Return a no-op handle so
      // the caller's `return () => handle.unsubscribe()` doesn't crash.
      return new SubscriptionHandle(() => {});
    }
    if (typeof opts.onEvent !== "function") {
      // Hard error — the hook is useless without an event handler. Throw
      // synchronously so misuse surfaces in dev, not at first event.
      throw new Error("useMultiRunSSE.subscribe: opts.onEvent is required");
    }
    // If the same runId is already subscribed, return a handle to the
    // existing subscription. This handles React StrictMode's double-
    // invoke without opening duplicate EventSources. The second
    // unsubscribe() call no-ops because `_terminated` will be set.
    const existing = subscriptionsRef.current.get(runId);
    if (existing && !existing._terminated) {
      return new SubscriptionHandle(() => unsubscribe(runId));
    }
    const sub = {
      runId,
      status: opts.status || "running",
      onEvent: opts.onEvent,
      onConnectionChange: opts.onConnectionChange || null,
      _es: null,
      _reconnectTimer: null,
      _heartbeatTimer: null,
      _reconnectDelay: RECONNECT_BASE_MS,
      _terminated: false,
    };
    subscriptionsRef.current.set(runId, sub);
    refreshActiveRunIds();
    openEventSource(sub);
    return new SubscriptionHandle(() => unsubscribe(runId));
  }, [openEventSource, refreshActiveRunIds, unsubscribe]);
  // ── Cleanup on hook unmount ──────────────────────────────────────────
  // The hook itself unmounts when the parent component unmounts. Tear
  // down every live EventSource in the pool so we don't leak.
  useEffect(() => {
    // Capture the ref so the cleanup uses the same Map even if a future
    // implementation swaps refs.
    const subs = subscriptionsRef.current;
    return () => {
      for (const sub of subs.values()) {
        sub._terminated = true;
        if (sub._heartbeatTimer) clearTimeout(sub._heartbeatTimer);
        if (sub._reconnectTimer) clearTimeout(sub._reconnectTimer);
        if (sub._es) {
          try { sub._es.close(); } catch { /* already closed */ }
        }
      }
      subs.clear();
    };
  }, []);
  return { subscribe, activeRunIds };
}

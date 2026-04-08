/**
 * @module hooks/useProjectRunMonitor
 * @description Project-detail run monitor that wires run status bootstrap with
 * `useRunSSE` transport (including polling fallback managed by the SSE hook).
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../api.js";
import { useRunSSE } from "./useRunSSE.js";

/**
 * Monitor an active run from the project page using SSE with polling fallback.
 * Calls `onSettled` once when the run transitions out of running state.
 *
 * @param {string|null} activeRunId
 * @param {(run: object) => void} [onSettled]
 * @returns {{ sseDown: boolean, retryIn: number|null, initialStatus: string|undefined }}
 */
export default function useProjectRunMonitor(activeRunId, onSettled) {
  const [initialStatus, setInitialStatus] = useState(undefined);
  // Use a ref for onSettled so the initial-fetch effect doesn't re-run when
  // the callback identity changes (it's rebuilt on every render via useCallback
  // in the parent, but its semantic meaning is stable).
  const onSettledRef = useRef(onSettled);
  useEffect(() => { onSettledRef.current = onSettled; }, [onSettled]);

  useEffect(() => {
    let alive = true;
    if (!activeRunId) {
      setInitialStatus(undefined);
      return;
    }
    api.getRun(activeRunId)
      .then((run) => {
        if (!alive) return;
        const status = run?.status || "running";
        setInitialStatus(status);
        // If the run already finished before SSE connects, fire onSettled
        // immediately — useRunSSE skips connecting for done runs, so
        // handleEvent would never be invoked.
        if (status !== "running") {
          onSettledRef.current?.(run);
        }
      })
      .catch(() => { if (alive) setInitialStatus("running"); });
    return () => { alive = false; };
  }, [activeRunId]);

  const handleEvent = useCallback((evt) => {
    if (!evt) return;
    if (evt.type === "snapshot" && evt.run?.status && evt.run.status !== "running") {
      onSettled?.(evt.run);
      return;
    }
    if (evt.type === "done") {
      onSettled?.(evt);
    }
  }, [onSettled]);

  const { sseDown, retryIn } = useRunSSE(activeRunId, handleEvent, initialStatus);

  return { sseDown, retryIn, initialStatus };
}

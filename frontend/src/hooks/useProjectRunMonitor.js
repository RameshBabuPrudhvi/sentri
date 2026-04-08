/**
 * @module hooks/useProjectRunMonitor
 * @description Project-detail run monitor that wires run status bootstrap with
 * `useRunSSE` transport (including polling fallback managed by the SSE hook).
 */

import { useEffect, useState, useCallback } from "react";
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

  useEffect(() => {
    let alive = true;
    if (!activeRunId) {
      setInitialStatus(undefined);
      return;
    }
    api.getRun(activeRunId)
      .then((run) => { if (alive) setInitialStatus(run?.status || "running"); })
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

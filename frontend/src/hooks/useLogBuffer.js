/**
 * @module hooks/useLogBuffer
 * @description Accumulates log lines from a run object so fast-running pipeline
 * steps that complete between SSE polls are never silently dropped.
 */

import { useRef, useState, useEffect } from "react";

/**
 * Hook that buffers run log lines and returns the current accumulated array.
 * Resets automatically when the run ID changes (e.g. navigating between runs).
 *
 * @param {Object|null} run - The run object (must have `.id` and `.logs[]`).
 * @returns {string[]} The current log buffer.
 */
export default function useLogBuffer(run) {
  const bufferRef = useRef([]);
  const runIdRef = useRef(null);
  const [logs, setLogs] = useState([]);

  // Reset the buffer when the run identity changes (e.g. navigating
  // from one run page to another) so stale logs from the previous
  // run are not shown.
  const runId = run?.id ?? null;
  useEffect(() => {
    if (runIdRef.current !== runId) {
      runIdRef.current = runId;
      bufferRef.current = [];
      setLogs([]);
    }
  }, [runId]);

  useEffect(() => {
    const incoming = run?.logs || [];
    // Use !== instead of > so the buffer resets when navigating to a run
    // with fewer logs (e.g. a new re-run). The > check caused stale logs
    // from the previous run to persist when the new run had fewer entries.
    if (incoming.length !== bufferRef.current.length) {
      bufferRef.current = incoming;
      setLogs([...incoming]);
    }
  }, [run?.logs?.length]);

  return logs;
}

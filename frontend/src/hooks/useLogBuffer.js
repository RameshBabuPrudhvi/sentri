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
    // Use !== (not >) so the buffer stays in sync when a same-id refresh
    // returns fewer logs than currently buffered — e.g. a manual Refresh
    // during an active run where the DB-backed `run_logs` hasn't caught up
    // with recently-streamed SSE tokens. Cross-run navigation (including
    // re-runs, which have a new runId) is already handled by the
    // runIdRef reset effect above.
    if (incoming.length !== bufferRef.current.length) {
      bufferRef.current = incoming;
      setLogs([...incoming]);
    }
  }, [run?.logs?.length]);

  return logs;
}

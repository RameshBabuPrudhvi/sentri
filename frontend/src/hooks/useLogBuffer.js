import { useRef, useState, useEffect } from "react";

/**
 * useLogBuffer(run)
 *
 * Accumulates log lines from a run object so fast-running pipeline steps
 * that complete between SSE polls are never silently dropped.
 *
 * Returns the current log buffer array.
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
    if (incoming.length > bufferRef.current.length) {
      bufferRef.current = incoming;
      setLogs([...incoming]);
    }
  }, [run?.logs?.length]);

  return logs;
}

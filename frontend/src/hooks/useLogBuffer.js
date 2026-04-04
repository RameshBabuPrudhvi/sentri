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
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    const incoming = run?.logs || [];
    if (incoming.length > bufferRef.current.length) {
      bufferRef.current = incoming;
      setLogs([...incoming]);
    }
  }, [run?.logs?.length]);

  return logs;
}

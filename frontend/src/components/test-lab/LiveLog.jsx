/**
 * @module components/test-lab/LiveLog
 * @description Terminal-style log view for the Test Lab live-run pane.
 *   Auto-scrolls to bottom on each new entry, renders the last 40 lines
 *   (the parent caps the full buffer at `LOG_CAP = 200` in
 *   `frontend/src/utils/testLabPersistence.js`), and offers a copy-to-
 *   clipboard button pinned to the top-right that emits the FULL buffer
 *   so users can share complete logs when triaging.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 * decomposition (audit §3.1). Pure presentational — no SSE wiring, no
 * persistence; the parent owns the log array.
 */
import React, { useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";

/**
 * @param {{ lines: string[] }} props
 */
export default function LiveLog({ lines }) {
  const endRef = useRef(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  // Copy the *full* buffer (not just the visible -40 slice) so the user can
  // share the complete log when triaging an issue. `navigator.clipboard`
  // requires HTTPS or localhost; the catch keeps the button silent on
  // unsupported origins instead of throwing into the console.
  function handleCopy() {
    const text = lines.join("\n");
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => { /* clipboard unavailable — non-fatal */ });
  }

  return (
    <div className="tl-live-log">
      {/* Icon-only copy button pinned to the top-right of the log surface.
          `tl-log-copy` is absolutely positioned against the non-scrolling
          `.tl-live-log` wrapper so it stays in view as the user scrolls
          through `.tl-live-log-scroll` below. Disabled when the buffer is
          empty so users can't no-op-copy a blank log. */}
      <button
        type="button"
        className={`tl-log-copy${copied ? " tl-log-copy--copied" : ""}`}
        onClick={handleCopy}
        disabled={lines.length === 0}
        title={copied ? "Copied to clipboard" : "Copy log to clipboard"}
        aria-label="Copy log to clipboard"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {/* Inner scroll surface — the absolutely-positioned copy button above
          stayed visually pinned only when the scroll happened on a separate
          element. Co-locating `overflow-y: auto` on the parent caused the
          button to scroll *with* the log content (absolute children of a
          scroll container participate in its scroll). */}
      <div className="tl-live-log-scroll">
        {lines.slice(-40).map((line, i) => {
          // Backend emits lines as `[ISO timestamp] <emoji> <message>` (see
          // `backend/src/utils/runLogger.js` and `backend/src/crawler.js`), so
          // we can't anchor the classifier at index 0 — the leading bracketed
          // timestamp pushes the emoji past the start. Scan for the first
          // recognisable marker anywhere in the line; first match wins.
          let cls = "tl-log-dim";
          if (/[✅✓]/.test(line) || /\bPASSED\b/.test(line))           cls = "tl-log-ok";
          else if (/[❌✗]/.test(line) || /\b(FAILED|ERROR)\b/i.test(line)) cls = "tl-log-error";
          else if (/[⚠️]/.test(line) || /\bWARN(ING)?\b/i.test(line))     cls = "tl-log-warn";
          else if (/[🏁🚀🕷️🔍🤖→▶]/.test(line))                          cls = "tl-log-info";
          return <div key={i} className={cls}>{line}</div>;
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

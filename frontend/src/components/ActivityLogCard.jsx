import React, { useRef } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Shared collapsible Activity Log card used by CrawlView and GenerateView.
 *
 * Props:
 *   logs        — array of log strings
 *   isRunning   — whether the run is still in progress
 *   emptyLabel  — placeholder text when no logs (default: "No log entries.")
 */
export default function ActivityLogCard({ logs = [], isRunning, emptyLabel = "No log entries." }) {
  const [open, setOpen] = React.useState(!!isRunning);
  const logRef = useRef(null);

  // Open while running, collapse when done
  React.useEffect(() => {
    setOpen(!!isRunning);
  }, [isRunning]);

  // Auto-scroll to bottom while running
  React.useEffect(() => {
    if (isRunning && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs.length, isRunning]);

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          padding: "12px 16px",
          borderBottom: open ? "1px solid var(--border)" : "none",
          display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>Activity Log</span>
          {isRunning && (
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.72rem", color: "var(--blue)" }}>
              <RefreshCw size={9} style={{ animation: "spin 1s linear infinite" }} />
              Updating
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>{logs.length} entries</span>
          <span style={{ fontSize: "0.72rem", color: "var(--accent)", fontWeight: 600 }}>
            {open ? "▲ Hide" : "▼ Show"}
          </span>
        </div>
      </button>

      {open && (
        <div ref={logRef} style={{ background: "#0d1117", padding: "10px 14px", maxHeight: 340, overflowY: "auto", overflowX: "hidden" }}>
          {logs.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "#475569", fontSize: "0.78rem" }}>
              {isRunning ? emptyLabel : "No log entries."}
            </div>
          ) : (
            logs.map((l, i) => {
              // Color classification — matches the ICON prefixes centralised in
              // backend/src/utils/runLogger.js (ICON.error = "❌", ICON.warn = "⚠️",
              // ICON.success = "✅", ICON.abort = "⛔").
              // If those icons change, update the markers here to match.
              // Priority: error > warning > success > info (gray default).
              const isError   = l.includes("❌") || l.includes("FAILED");
              const isWarn    = !isError && (l.includes("⚠") || l.includes("⛔"));
              const isSuccess = !isError && !isWarn && (l.includes("✅") || l.includes("PASSED") || l.includes("🟢"));
              const color     = isError ? "#f87171" : isWarn ? "#fbbf24" : isSuccess ? "#4ade80" : "#94a3b8";
              return (
                <div key={i} style={{
                  fontFamily: "var(--font-mono)", fontSize: "0.71rem",
                  color, lineHeight: 1.95,
                  borderBottom: "1px solid rgba(255,255,255,0.025)",
                  wordBreak: "break-word", overflowWrap: "anywhere",
                }}>
                  <span style={{ color: "#1e293b", marginRight: 10, userSelect: "none", fontVariantNumeric: "tabular-nums" }}>
                    {String(i + 1).padStart(3, "0")}
                  </span>
                  {l}
                </div>
              );
            })
          )}
          {isRunning && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 10, color: "#334155", fontSize: "0.71rem", fontFamily: "var(--font-mono)" }}>
              <RefreshCw size={9} style={{ animation: "spin 1s linear infinite" }} />
              waiting for next update…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

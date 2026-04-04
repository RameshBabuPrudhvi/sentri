import React from "react";
import { RefreshCw } from "lucide-react";

/**
 * Shared right-hand sidebar for CrawlView and GenerateView.
 * Renders a "Results" stats card and a "Run Info" card.
 *
 * Props:
 *   stats       — array of { label, val, color } rows
 *   run         — the run object
 *   isRunning   — whether the run is still in progress
 *   failLabel   — error fallback text (default: "Operation failed — check logs for details.")
 *   children    — optional extra content rendered below Run Info (e.g. generate input)
 */
export default function RunSidebar({ stats = [], run, isRunning, failLabel, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Results stats card */}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>
          {isRunning ? "Live Results" : "Results"}
        </div>
        {stats.map((s, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "9px 0",
            borderBottom: i < stats.length - 1 ? "1px solid var(--border)" : "none",
          }}>
            <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>{s.label}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "0.95rem", color: s.val != null ? s.color : "var(--text3)", display: "flex", alignItems: "center" }}>
              {s.val != null ? s.val : isRunning
                ? <RefreshCw size={11} style={{ animation: "spin 1.2s linear infinite", color: "var(--border)" }} />
                : <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>—</span>
              }
            </span>
          </div>
        ))}
      </div>

      {/* Run info card */}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>
          Run Info
        </div>
        {[
          {
            label: "Status",
            val: (
              <span className={`badge ${isRunning ? "badge-blue" : run?.status === "completed" ? "badge-green" : "badge-red"}`}>
                {isRunning
                  ? <><RefreshCw size={9} style={{ animation: "spin 1s linear infinite" }} /> Running</>
                  : run?.status}
              </span>
            ),
          },
          {
            label: "Started",
            val: <span style={{ fontSize: "0.78rem", color: "var(--text2)", fontFamily: "var(--font-mono)" }}>
              {run?.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "—"}
            </span>,
          },
          {
            label: "Duration",
            val: <span style={{ fontSize: "0.78rem", color: "var(--text2)", fontFamily: "var(--font-mono)" }}>
              {run?.duration ? `${(run.duration / 1000).toFixed(1)}s` : isRunning ? "…" : "—"}
            </span>,
          },
        ].map((row, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 0",
            borderBottom: i < 2 ? "1px solid var(--border)" : "none",
          }}>
            <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>{row.label}</span>
            {row.val}
          </div>
        ))}

        {/* Extra content slot (e.g. generate input context) */}
        {children}

        {!isRunning && run?.status === "failed" && (
          <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--red-bg)", borderRadius: 8, fontSize: "0.78rem", color: "var(--red)" }}>
            {run.error || failLabel || "Operation failed — check logs for details."}
          </div>
        )}
      </div>
    </div>
  );
}

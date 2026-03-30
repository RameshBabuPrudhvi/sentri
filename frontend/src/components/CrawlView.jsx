import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, RefreshCw } from "lucide-react";

// Each stage maps to a 1-based step index set authoritatively by the
// backend via run.currentStep. No fragile log-string scraping needed.
const PIPELINE_STAGES = [
  { label: "Crawl & Snapshot Pages",      icon: "🔍", step: 1 },
  { label: "Filter Elements",             icon: "🧹", step: 2 },
  { label: "Classify Intents & Journeys", icon: "🧠", step: 3 },
  { label: "Generate Tests via AI",       icon: "⚡", step: 4 },
  { label: "Deduplicate Tests",           icon: "🚫", step: 5 },
  { label: "Enhance Assertions",          icon: "✨", step: 6 },
  { label: "Validate Tests",             icon: "✅", step: 7 },
  { label: "Done",                        icon: "🎉", step: 8 },
];

export default function CrawlView({ run, isRunning }) {
  const [logsOpen, setLogsOpen] = React.useState(!!isRunning);
  const logRef = useRef(null);

  // Accumulate all log lines seen across polls so fast-running steps that
  // complete between two 1500ms polls are never silently dropped.
  // We key by line content so duplicate entries from re-renders are idempotent.
  const logBufferRef = useRef([]);
  const [logBuffer, setLogBuffer] = React.useState([]);

  React.useEffect(() => {
    const incoming = run?.logs || [];
    if (incoming.length > logBufferRef.current.length) {
      logBufferRef.current = incoming;
      setLogBuffer([...incoming]);
    }
  }, [run?.logs?.length]);

  // Open logs while running, collapse when done
  React.useEffect(() => {
    setLogsOpen(!!isRunning);
  }, [isRunning]);

  // Auto-scroll logs to bottom while running
  React.useEffect(() => {
    if (isRunning && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logBuffer.length, isRunning]);

  const logs = logBuffer;
  const ps = run?.pipelineStats || {};

  // Use the authoritative currentStep set by the backend at each stage
  // transition. Fall back to 0 (nothing started) if not yet set.
  const currentStep = run?.currentStep ?? 0;

  const stages = PIPELINE_STAGES.map((s) => {
    // When running: steps before currentStep are done, currentStep is active.
    // When finished successfully: all steps are done.
    // When failed: steps *before* currentStep are done (currentStep itself failed).
    const done = isRunning
      ? s.step < currentStep
      : run?.status === "completed"
      ? true
      : run?.status === "failed"
      ? s.step < currentStep
      : s.step <= currentStep;
    const active = isRunning && s.step === currentStep;
    return { ...s, done, active };
  });

  const completedCount = isRunning
      ? Math.max(0, currentStep - 1)
      : run?.status === "completed"
      ? PIPELINE_STAGES.length
      : run?.status === "failed"
      ? Math.max(0, currentStep - 1)
      : 0;

  const stats = [
    {
      label: "Pages Found",
      val: run?.pagesFound ?? ps.pagesFound,
      color: "var(--accent)",
    },
    {
      label: "Tests Generated",
      val: run?.testsGenerated ?? ps.rawTestsGenerated,
      color: "var(--green)",
    },
    {
      label: "Duplicates Removed",
      val: ps.duplicatesRemoved,
      color: "var(--amber)",
    },
    {
      label: "Journeys Detected",
      val: ps.journeysDetected,
      color: "#a855f7",
    },
    {
      label: "Assertions Enhanced",
      val: ps.assertionsEnhanced,
      color: "var(--blue)",
    },
    {
      label: "Validation Rejected",
      val: ps.validationRejected,
      color: "var(--red)",
    },
    {
      label: "Avg Quality Score",
      val:
        ps.averageQuality != null ? `${ps.averageQuality}/100` : null,
      color:
        (ps.averageQuality || 0) >= 60 ? "var(--green)" : "var(--amber)",
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 300px",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* ── LEFT: Pipeline + Logs ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Pipeline card */}
        <div className="card" style={{ overflow: "hidden" }}>
          {/* Header */}
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>
                Pipeline Progress
              </span>
              {isRunning && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: "0.72rem",
                    color: "var(--blue)",
                  }}
                >
                  <RefreshCw
                    size={10}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                  Live
                </span>
              )}
            </div>
            <span
              style={{
                fontSize: "0.75rem",
                color: "var(--text3)",
                fontWeight: 500,
              }}
            >
              {completedCount} / {stages.length} steps
            </span>
          </div>

          {/* Progress bar */}
          <div
            style={{ padding: "10px 18px 0", background: "var(--bg2)" }}
          >
            <div
              style={{
                height: 4,
                background: "var(--bg3)",
                borderRadius: 99,
                overflow: "hidden",
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  height: "100%",
                  borderRadius: 99,
                  background:
                    run?.status === "completed"
                      ? "var(--green)"
                      : "var(--accent)",
                  width: `${Math.round(
                    (completedCount / stages.length) * 100
                  )}%`,
                  transition: "width 0.6s ease",
                }}
              />
            </div>
          </div>

          {/* Stage list */}
          <div style={{ padding: "2px 18px 16px", background: "var(--bg2)" }}>
            {stages.map((stage, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "9px 0",
                  borderBottom:
                    i < stages.length - 1
                      ? "1px solid var(--border)"
                      : "none",
                }}
              >
                {/* Status icon */}
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: stage.done
                      ? "var(--green-bg)"
                      : stage.active
                      ? "var(--blue-bg)"
                      : "var(--bg3)",
                    border: `2px solid ${
                      stage.done
                        ? "var(--green)"
                        : stage.active
                        ? "var(--blue)"
                        : "var(--border)"
                    }`,
                    transition: "all 0.3s",
                  }}
                >
                  {stage.done ? (
                    <CheckCircle2 size={13} color="var(--green)" />
                  ) : stage.active ? (
                    <RefreshCw
                      size={11}
                      color="var(--blue)"
                      style={{ animation: "spin 0.8s linear infinite" }}
                    />
                  ) : (
                    <Clock size={11} color="var(--text3)" />
                  )}
                </div>

                {/* Label */}
                <div style={{ position: "relative", flex: 1 }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span style={{ fontSize: "1rem" }}>{stage.icon}</span>
                    <span
                      style={{
                        fontSize: "0.84rem",
                        fontWeight: stage.active
                          ? 700
                          : stage.done
                          ? 500
                          : 400,
                        color: stage.done
                          ? "var(--text)"
                          : stage.active
                          ? "var(--blue)"
                          : "var(--text3)",
                        transition: "color 0.3s",
                      }}
                    >
                      {stage.label}
                    </span>
                    {stage.active && (
                      <span
                        style={{
                          fontSize: "0.65rem",
                          fontWeight: 700,
                          padding: "1px 7px",
                          borderRadius: 99,
                          background: "var(--blue-bg)",
                          color: "var(--blue)",
                          border: "1px solid #bfdbfe",
                          animation: "pulse 1.5s ease-in-out infinite",
                        }}
                      >
                        In progress
                      </span>
                    )}
                    {stage.done && i === stages.length - 1 && !isRunning && (
                      <span
                        style={{
                          fontSize: "0.65rem",
                          fontWeight: 700,
                          padding: "1px 7px",
                          borderRadius: 99,
                          background: "var(--green-bg)",
                          color: "var(--green)",
                          border: "1px solid #86efac",
                        }}
                      >
                        Complete
                      </span>
                    )}
                  </div>
                </div>

                {/* Step number */}
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.65rem",
                    fontWeight: 700,
                    background: "var(--bg3)",
                    color: "var(--text3)",
                  }}
                >
                  {i + 1}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Logs card */}
        <div className="card" style={{ overflow: "hidden" }}>
          <button
            onClick={() => setLogsOpen((o) => !o)}
            style={{
              width: "100%",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "12px 16px",
              borderBottom: logsOpen ? "1px solid var(--border)" : "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              textAlign: "left",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                Activity Log
              </span>
              {isRunning && (
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: "0.72rem",
                    color: "var(--blue)",
                  }}
                >
                  <RefreshCw
                    size={9}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                  Updating
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                {logs.length} entries
              </span>
              <span
                style={{
                  fontSize: "0.72rem",
                  color: "var(--accent)",
                  fontWeight: 600,
                }}
              >
                {logsOpen ? "▲ Hide" : "▼ Show"}
              </span>
            </div>
          </button>

          {logsOpen && (
            <div
              ref={logRef}
              style={{
                background: "#0d1117",
                padding: "10px 14px",
                maxHeight: 340,
                overflowY: "auto",
              }}
            >
              {logs.length === 0 ? (
                <div
                  style={{
                    padding: 20,
                    textAlign: "center",
                    color: "#475569",
                    fontSize: "0.78rem",
                  }}
                >
                  {isRunning ? "Starting crawl…" : "No log entries."}
                </div>
              ) : (
                logs.map((l, i) => {
                  const isError =
                    l.includes("❌") ||
                    l.toLowerCase().includes("error") ||
                    l.toLowerCase().includes("failed");
                  const isSuccess =
                    l.includes("✅") ||
                    l.includes("🎉") ||
                    l.toLowerCase().includes("done") ||
                    l.includes("🟢");
                  const isWarn = l.includes("⚠") || l.includes("0 ");
                  const color = isError
                    ? "#f87171"
                    : isSuccess
                    ? "#4ade80"
                    : isWarn
                    ? "#fbbf24"
                    : "#94a3b8";
                  return (
                    <div
                      key={i}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.71rem",
                        color,
                        lineHeight: 1.95,
                        borderBottom: "1px solid rgba(255,255,255,0.025)",
                      }}
                    >
                      <span
                        style={{
                          color: "#1e293b",
                          marginRight: 10,
                          userSelect: "none",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {String(i + 1).padStart(3, "0")}
                      </span>
                      {l}
                    </div>
                  );
                })
              )}
              {isRunning && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    paddingTop: 10,
                    color: "#334155",
                    fontSize: "0.71rem",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <RefreshCw
                    size={9}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                  waiting for next update…
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── RIGHT: Stats + Run Info ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Results stats card */}
        <div className="card" style={{ padding: 16 }}>
          <div
            style={{
              fontSize: "0.72rem",
              fontWeight: 700,
              color: "var(--text3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 14,
            }}
          >
            {isRunning ? "Live Results" : "Results"}
          </div>
          {stats.map((s, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "9px 0",
                borderBottom:
                  i < stats.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                {s.label}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontSize: "0.95rem",
                  color: s.val != null ? s.color : "var(--text3)",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {s.val != null ? (
                  s.val
                ) : isRunning ? (
                  <RefreshCw
                    size={11}
                    style={{
                      animation: "spin 1.2s linear infinite",
                      color: "var(--border)",
                    }}
                  />
                ) : (
                  <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>
                    —
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>

        {/* Run info card */}
        <div className="card" style={{ padding: 16 }}>
          <div
            style={{
              fontSize: "0.72rem",
              fontWeight: 700,
              color: "var(--text3)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 14,
            }}
          >
            Run Info
          </div>
          {[
            {
              label: "Status",
              val: (
                <span
                  className={`badge ${
                    isRunning
                      ? "badge-blue"
                      : run?.status === "completed"
                      ? "badge-green"
                      : "badge-red"
                  }`}
                >
                  {isRunning ? (
                    <>
                      <RefreshCw
                        size={9}
                        style={{ animation: "spin 1s linear infinite" }}
                      />{" "}
                      Running
                    </>
                  ) : (
                    run?.status
                  )}
                </span>
              ),
            },
            {
              label: "Started",
              val: (
                <span
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--text2)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {run?.startedAt
                    ? new Date(run.startedAt).toLocaleTimeString()
                    : "—"}
                </span>
              ),
            },
            {
              label: "Duration",
              val: (
                <span
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--text2)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {run?.duration
                    ? `${(run.duration / 1000).toFixed(1)}s`
                    : isRunning
                    ? "…"
                    : "—"}
                </span>
              ),
            },
          ].map((row, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: i < 2 ? "1px solid var(--border)" : "none",
              }}
            >
              <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                {row.label}
              </span>
              {row.val}
            </div>
          ))}

          {!isRunning && run?.status === "failed" && (
            <div
              style={{
                marginTop: 12,
                padding: "8px 12px",
                background: "var(--red-bg)",
                borderRadius: 8,
                fontSize: "0.78rem",
                color: "var(--red)",
              }}
            >
              {run.error || "Crawl failed — check logs for details."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
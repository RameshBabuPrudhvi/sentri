import React, { useEffect, useRef } from "react";
import { CheckCircle2, Clock, RefreshCw } from "lucide-react";

const PIPELINE_STAGES = [
  {
    label: "Crawl & Snapshot Pages",
    icon: "🔍",
    check: (run) =>
      (run.pagesFound || 0) > 0 ||
      (run.logs || []).some(
        (l) => l.includes("smart crawl done") || l.includes("Visiting")
      ),
  },
  {
    label: "Filter Elements",
    icon: "🧹",
    check: (run) =>
      (run.logs || []).some((l) => l.includes("ilter") || l.includes("noise")),
  },
  {
    label: "Classify Intents & Journeys",
    icon: "🧠",
    check: (run) =>
      (run.logs || []).some(
        (l) =>
          l.includes("lassif") ||
          l.includes("Journey") ||
          l.includes("journey") ||
          l.includes("intent")
      ),
  },
  {
    label: "Generate Tests via AI",
    icon: "⚡",
    check: (run) =>
      (run.logs || []).some(
        (l) => l.includes("enerating") || l.includes("Raw tests")
      ),
  },
  {
    label: "Deduplicate Tests",
    icon: "🚫",
    check: (run) =>
      (run.logs || []).some(
        (l) =>
          l.includes("edup") ||
          l.includes("duplicate") ||
          l.includes("unique tests")
      ),
  },
  {
    label: "Enhance Assertions",
    icon: "✨",
    check: (run) =>
      (run.logs || []).some(
        (l) =>
          l.includes("nhanc") ||
          l.includes("assertion") ||
          l.includes("strengthened")
      ),
  },
  {
    label: "Done",
    icon: "🎉",
    check: (run) => run.status === "completed" || run.status === "failed",
  },
];

export default function CrawlView({ run, isRunning }) {
  const [logsOpen, setLogsOpen] = React.useState(!!isRunning);
  const logRef = useRef(null);

  // Open logs while running, collapse when done
  React.useEffect(() => {
    setLogsOpen(!!isRunning);
  }, [isRunning]);

  // Auto-scroll logs to bottom while running
  React.useEffect(() => {
    if (isRunning && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [run?.logs?.length, isRunning]);

  const logs = run?.logs || [];
  const ps = run?.pipelineStats || {};

  const stages = PIPELINE_STAGES.map((s, i, arr) => {
    const done = s.check(run);
    const prevDone = i === 0 ? true : arr[i - 1].check(run);
    const active = !!isRunning && prevDone && !done;
    return { ...s, done, active };
  });

  const completedCount = stages.filter((s) => s.done).length;

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

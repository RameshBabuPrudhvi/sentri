import React, { useEffect, useRef } from "react";
import { CheckCircle2, Clock, RefreshCw, SkipForward } from "lucide-react";

// Pipeline stages matching the backend's generateSingleTest step numbers.
// Steps 1-2 are skipped (Crawl & Filter) since we have title + description.
const PIPELINE_STAGES = [
  { label: "Crawl",                        icon: "🔍", step: 1, skipped: true },
  { label: "Filter",                       icon: "🧹", step: 2, skipped: true },
  { label: "Classify Intent",              icon: "🧠", step: 3 },
  { label: "Generate Tests via AI",        icon: "⚡", step: 4 },
  { label: "Deduplicate",                  icon: "🚫", step: 5 },
  { label: "Enhance Assertions",           icon: "✨", step: 6 },
  { label: "Validate",                     icon: "✅", step: 7 },
  { label: "Done",                         icon: "🎉", step: 8 },
];

/**
 * Compact pipeline progress view for the CreateTestModal.
 * Same step-tracking logic as CrawlView but in a more compact layout
 * suitable for embedding inside a modal.
 *
 * Props:
 *   run       — the run object from GET /api/runs/:runId
 *   isRunning — true while run.status === "running"
 */
export default function GenerateView({ run, isRunning }) {
  const logRef = useRef(null);

  // Auto-scroll logs
  useEffect(() => {
    if (isRunning && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [run?.logs?.length, isRunning]);

  const currentStep = run?.currentStep ?? 0;
  const logs = run?.logs || [];
  const ps = run?.pipelineStats || {};

  const stages = PIPELINE_STAGES.map((s) => {
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Progress bar */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text2)" }}>
            Pipeline Progress
          </span>
          <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
            {completedCount} / {PIPELINE_STAGES.length} steps
          </span>
        </div>
        <div style={{ height: 4, background: "var(--bg3)", borderRadius: 99, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 99,
            background: run?.status === "completed" ? "var(--green)" : run?.status === "failed" ? "var(--red)" : "var(--accent)",
            width: `${Math.round((completedCount / PIPELINE_STAGES.length) * 100)}%`,
            transition: "width 0.5s ease",
          }} />
        </div>
      </div>

      {/* Stage list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {stages.map((stage, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "7px 0",
            borderBottom: i < stages.length - 1 ? "1px solid var(--border)" : "none",
            opacity: stage.skipped && !stage.done && !stage.active ? 0.5 : 1,
          }}>
            {/* Status icon */}
            <div style={{
              width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: stage.done ? "var(--green-bg)"
                : stage.active ? "var(--blue-bg)"
                : "var(--bg3)",
              border: `2px solid ${stage.done ? "var(--green)" : stage.active ? "var(--blue)" : "var(--border)"}`,
              transition: "all 0.3s",
            }}>
              {stage.done ? (
                stage.skipped ? <SkipForward size={10} color="var(--green)" />
                  : <CheckCircle2 size={10} color="var(--green)" />
              ) : stage.active ? (
                <RefreshCw size={9} color="var(--blue)" style={{ animation: "spin 0.8s linear infinite" }} />
              ) : (
                <Clock size={9} color="var(--text3)" />
              )}
            </div>

            {/* Label */}
            <span style={{ fontSize: "1rem", flexShrink: 0 }}>{stage.icon}</span>
            <span style={{
              fontSize: "0.8rem", flex: 1,
              fontWeight: stage.active ? 700 : stage.done ? 500 : 400,
              color: stage.skipped && stage.done ? "var(--text3)"
                : stage.done ? "var(--text)"
                : stage.active ? "var(--blue)"
                : "var(--text3)",
            }}>
              {stage.label}
              {stage.skipped && stage.done && (
                <span style={{ fontSize: "0.68rem", color: "var(--text3)", marginLeft: 6, fontWeight: 400 }}>skipped</span>
              )}
            </span>

            {stage.active && (
              <span style={{
                fontSize: "0.62rem", fontWeight: 700, padding: "1px 6px", borderRadius: 99,
                background: "var(--blue-bg)", color: "var(--blue)", border: "1px solid #bfdbfe",
                animation: "pulse 1.5s ease-in-out infinite",
              }}>
                In progress
              </span>
            )}
            {stage.done && i === stages.length - 1 && !isRunning && (
              <span style={{
                fontSize: "0.62rem", fontWeight: 700, padding: "1px 6px", borderRadius: 99,
                background: "var(--green-bg)", color: "var(--green)", border: "1px solid #86efac",
              }}>
                Complete
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Compact stats — shown only when pipeline finishes */}
      {run?.status === "completed" && ps.rawTestsGenerated != null && (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8,
          padding: "10px 12px", background: "var(--bg2)", borderRadius: 8,
          border: "1px solid var(--border)",
        }}>
          {[
            { label: "Generated", val: ps.rawTestsGenerated, color: "var(--accent)" },
            { label: "Validated", val: (ps.rawTestsGenerated || 0) - (ps.validationRejected || 0) - (ps.duplicatesRemoved || 0), color: "var(--green)" },
            { label: "Rejected", val: (ps.validationRejected || 0) + (ps.duplicatesRemoved || 0), color: "var(--red)" },
          ].map((s, i) => (
            <div key={i} style={{ textAlign: "center" }}>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: s.color }}>{s.val}</div>
              <div style={{ fontSize: "0.65rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Compact log viewer */}
      {logs.length > 0 && (
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text3)", marginBottom: 6 }}>
            Activity Log ({logs.length})
          </div>
          <div
            ref={logRef}
            style={{
              background: "#0d1117", borderRadius: 6, padding: "8px 10px",
              maxHeight: 140, overflowY: "auto",
            }}
          >
            {logs.map((l, i) => {
              const isError = l.includes("❌") || l.toLowerCase().includes("error");
              const isSuccess = l.includes("✅") || l.includes("🎉");
              const color = isError ? "#f87171" : isSuccess ? "#4ade80" : "#94a3b8";
              return (
                <div key={i} style={{
                  fontFamily: "var(--font-mono)", fontSize: "0.65rem",
                  color, lineHeight: 1.8,
                }}>
                  {l}
                </div>
              );
            })}
            {isRunning && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, paddingTop: 4, color: "#334155", fontSize: "0.65rem", fontFamily: "var(--font-mono)" }}>
                <RefreshCw size={8} style={{ animation: "spin 1s linear infinite" }} />
                waiting…
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error state */}
      {run?.status === "failed" && (
        <div style={{
          padding: "8px 12px", background: "var(--red-bg)", borderRadius: 6,
          fontSize: "0.8rem", color: "var(--red)",
        }}>
          {run.error || "Generation failed — check logs for details."}
        </div>
      )}
    </div>
  );
}

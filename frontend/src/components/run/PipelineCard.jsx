import React from "react";
import { CheckCircle2, Clock, RefreshCw, SkipForward } from "lucide-react";

/**
 * Shared pipeline progress card used by CrawlView and GenerateView.
 *
 * Props:
 *   stages         — array of { label, icon, step, skipped? }
 *   currentStep    — run.currentStep (1-based index of the active stage)
 *   status         — run.status ("running" | "completed" | "failed" | …)
 *   isRunning      — shorthand for status === "running"
 */
export default function PipelineCard({ stages: rawStages, currentStep = 0, status, isRunning }) {
  const isCompleted = status === "completed" || status === "completed_empty";

  const stages = rawStages.map((s) => {
    let done, active;
    if (s.skipped) {
      done = true;
      active = false;
    } else {
      done = isRunning
        ? s.step < currentStep
        : isCompleted
        ? true
        : status === "failed"
        ? s.step < currentStep
        : s.step <= currentStep;
      active = isRunning && s.step === currentStep;
    }
    return { ...s, done, active };
  });

  const completedCount = isRunning
    ? Math.max(0, currentStep - 1)
    : isCompleted
    ? rawStages.length
    : status === "failed"
    ? Math.max(0, currentStep - 1)
    : rawStages.filter(s => s.skipped).length || 0;

  const barColor = isCompleted ? (status === "completed_empty" ? "var(--amber)" : "var(--green)")
    : status === "failed" ? "var(--red)"
    : "var(--accent)";

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        padding: "14px 18px", borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>Pipeline Progress</span>
          {isRunning && (
            <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.72rem", color: "var(--blue)" }}>
              <RefreshCw size={10} style={{ animation: "spin 1s linear infinite" }} />
              Live
            </span>
          )}
        </div>
        <span style={{ fontSize: "0.75rem", color: "var(--text3)", fontWeight: 500 }}>
          {completedCount} / {rawStages.length} steps
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ padding: "10px 18px 0", background: "var(--bg2)" }}>
        <div style={{ height: 4, background: "var(--bg3)", borderRadius: 99, overflow: "hidden", marginBottom: 14 }}>
          <div style={{
            height: "100%", borderRadius: 99,
            background: barColor,
            width: `${Math.round((completedCount / rawStages.length) * 100)}%`,
            transition: "width 0.6s ease",
          }} />
        </div>
      </div>

      {/* Stage list */}
      <div style={{ padding: "2px 18px 16px", background: "var(--bg2)" }}>
        {stages.map((stage, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "9px 0",
            borderBottom: i < stages.length - 1 ? "1px solid var(--border)" : "none",
            opacity: stage.skipped ? 0.6 : 1,
          }}>
            {/* Status icon */}
            <div style={{
              width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: stage.done ? "var(--green-bg)" : stage.active ? "var(--blue-bg)" : "var(--bg3)",
              border: `2px solid ${stage.done ? "var(--green)" : stage.active ? "var(--blue)" : "var(--border)"}`,
              transition: "all 0.3s",
            }}>
              {stage.done ? (
                stage.skipped
                  ? <SkipForward size={11} color="var(--green)" />
                  : <CheckCircle2 size={13} color="var(--green)" />
              ) : stage.active ? (
                <RefreshCw size={11} color="var(--blue)" style={{ animation: "spin 0.8s linear infinite" }} />
              ) : (
                <Clock size={11} color="var(--text3)" />
              )}
            </div>

            {/* Label */}
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "1rem" }}>{stage.icon}</span>
                <span style={{
                  fontSize: "0.84rem",
                  fontWeight: stage.active ? 700 : stage.done ? 500 : 400,
                  color: stage.skipped && stage.done
                    ? "var(--text3)"
                    : stage.done ? "var(--text)"
                    : stage.active ? "var(--blue)"
                    : "var(--text3)",
                  transition: "color 0.3s",
                }}>
                  {stage.label}
                </span>

                {stage.skipped && stage.done && (
                  <span style={{
                    fontSize: "0.62rem", fontWeight: 600, padding: "1px 7px",
                    borderRadius: 99, background: "var(--bg3)", color: "var(--text3)",
                    border: "1px solid var(--border)",
                  }}>
                    skipped
                  </span>
                )}

                {stage.active && (
                  <span style={{
                    fontSize: "0.65rem", fontWeight: 700, padding: "1px 7px",
                    borderRadius: 99, background: "var(--blue-bg)", color: "var(--blue)",
                    border: "1px solid #bfdbfe", animation: "pulse 1.5s ease-in-out infinite",
                  }}>
                    In progress
                  </span>
                )}

                {stage.done && !stage.skipped && i === stages.length - 1 && !isRunning && (
                  <span style={{
                    fontSize: "0.65rem", fontWeight: 700, padding: "1px 7px",
                    borderRadius: 99, background: "var(--green-bg)", color: "var(--green)",
                    border: "1px solid #86efac",
                  }}>
                    Complete
                  </span>
                )}
              </div>
            </div>

            {/* Step number */}
            <span style={{
              width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "0.65rem", fontWeight: 700, background: "var(--bg3)", color: "var(--text3)",
            }}>
              {i + 1}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

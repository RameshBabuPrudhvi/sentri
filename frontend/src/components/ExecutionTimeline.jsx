import { cleanTestName } from "../utils/testName.js";

/**
 * ExecutionTimeline — Gantt-style horizontal timeline
 *
 * Shows each test case as a proportional bar spanning from its relative
 * start to end within the total run duration.
 *
 * When result.startedAt is present (absolute ms), bars are positioned
 * accurately. Otherwise falls back to sequential cumulative layout.
 *
 * Props:
 *   results  — array of result objects from run.results[]
 *   onSelect — callback(result) when a bar is clicked
 */
export default function ExecutionTimeline({ results = [], onSelect }) {
  if (!results.length) return null;

  const hasAbsoluteTimings = results.every(r => r.startedAt != null);

  // Build layout entries with left% and width%
  let entries;
  if (hasAbsoluteTimings) {
    const runStart = Math.min(...results.map(r => r.startedAt));
    const runEnd   = Math.max(...results.map(r => r.startedAt + (r.durationMs ?? 0)));
    const span     = Math.max(runEnd - runStart, 1);
    entries = results.map(r => ({
      ...r,
      left:  ((r.startedAt - runStart) / span) * 100,
      width: Math.max(((r.durationMs ?? 0) / span) * 100, 0.4),
    }));
  } else {
    // Sequential fallback — cumulative positioning
    const total = results.reduce((s, r) => s + (r.durationMs ?? 0), 0) || 1;
    let cursor = 0;
    entries = results.map(r => {
      const left  = (cursor / total) * 100;
      const width = Math.max(((r.durationMs ?? 0) / total) * 100, 0.4);
      cursor += r.durationMs ?? 0;
      return { ...r, left, width };
    });
  }

  const ROW_H  = 32;
  const LABEL_W = 140; // px reserved for name labels on the left

  function barColor(status) {
    if (status === "passed")  return { bg: "var(--green)",  border: "#4ade8088" };
    if (status === "failed")  return { bg: "var(--red)",    border: "#f87171aa" };
    if (status === "warning") return { bg: "var(--amber)",  border: "#fbbf24aa" };
    return                           { bg: "var(--text3)",  border: "transparent" };
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Execution Timeline
        </span>
        <span style={{ fontSize: "0.68rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
          {results.length} test{results.length !== 1 ? "s" : ""}
          {" · "}
          {((results.reduce((s, r) => s + (r.durationMs ?? 0), 0)) / 1000).toFixed(1)}s total
        </span>
      </div>

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {/* Column headers */}
        <div style={{
          display: "flex", alignItems: "center",
          padding: "6px 12px 6px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
        }}>
          <div style={{ width: LABEL_W, flexShrink: 0, fontSize: "0.65rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Test
          </div>
          <div style={{ flex: 1, fontSize: "0.65rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Duration
          </div>
        </div>

        {/* Rows */}
        <div style={{ overflowX: "auto" }}>
          {entries.map((r, i) => {
            const { bg, border } = barColor(r.status);
            const isLast = i === entries.length - 1;

            return (
              <div
                key={i}
                onClick={() => onSelect?.(r)}
                style={{
                  display: "flex", alignItems: "center",
                  height: ROW_H,
                  borderBottom: isLast ? "none" : "1px solid var(--border)",
                  cursor: onSelect ? "pointer" : "default",
                  transition: "background 0.1s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--bg)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
              >
                {/* Name label */}
                <div style={{
                  width: LABEL_W, flexShrink: 0,
                  padding: "0 12px",
                  fontSize: "0.72rem", color: "var(--text2)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  fontWeight: 500,
                }}>
                  {cleanTestName(r.testName || r.name) || `Test ${i + 1}`}
                </div>

                {/* Timeline track */}
                <div style={{ flex: 1, position: "relative", height: ROW_H, minWidth: 200, paddingRight: 12 }}>
                  {/* Bar */}
                  <div
                    title={`${cleanTestName(r.testName) || "Test"} — ${r.durationMs ?? 0}ms — ${r.status}`}
                    style={{
                      position: "absolute",
                      top: "50%", transform: "translateY(-50%)",
                      left: `${r.left}%`,
                      width: `${r.width}%`,
                      height: 18,
                      background: bg,
                      border: `1px solid ${border}`,
                      borderRadius: 4,
                      opacity: 0.88,
                      display: "flex", alignItems: "center",
                      paddingLeft: 5,
                      overflow: "hidden",
                      boxSizing: "border-box",
                      minWidth: 4,
                      transition: "opacity 0.1s",
                    }}
                  >
                    {r.width > 8 && (
                      <span style={{
                        fontSize: "0.6rem", color: "#fff",
                        whiteSpace: "nowrap", overflow: "hidden",
                        textOverflow: "ellipsis",
                        fontWeight: 600,
                        textShadow: "0 1px 2px rgba(0,0,0,0.4)",
                      }}>
                        {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : ""}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

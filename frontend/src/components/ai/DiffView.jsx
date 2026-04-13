/**
 * DiffView — side-by-side line-level diff of Playwright code
 *
 * Uses a built-in Myers diff so no external `diff` package is required.
 * The output matches the spec's +/- visual style exactly.
 *
 * Props:
 *   before — original code string (playwrightCodePrev)
 *   after  — new code string (playwrightCode)
 */

// ── Minimal Myers LCS-based line diff ─────────────────────────────────────────

function diffLines(a, b) {
  const aLines = (a ?? "").split("\n");
  const bLines = (b ?? "").split("\n");
  const result = [];

  // Build LCS table
  const m = aLines.length, n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);

  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      result.push({ type: "equal",   value: aLines[i] }); i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      result.push({ type: "added",   value: bLines[j] }); j++;
    } else {
      result.push({ type: "removed", value: aLines[i] }); i++;
    }
  }
  return result;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DiffView({ before, after }) {
  if (!before && !after) return null;

  const chunks = diffLines(before, after);

  const added   = chunks.filter(c => c.type === "added").length;
  const removed = chunks.filter(c => c.type === "removed").length;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", minWidth: 0 }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "7px 12px",
        background: "var(--bg)",
        borderBottom: "1px solid var(--border)",
        fontSize: "0.72rem",
      }}>
        <span style={{ fontWeight: 700, color: "var(--text2)" }}>Code diff</span>
        {added > 0 && (
          <span style={{ color: "var(--green)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
            +{added}
          </span>
        )}
        {removed > 0 && (
          <span style={{ color: "var(--red)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
            -{removed}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "var(--text3)" }}>
          {chunks.length} line{chunks.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Diff body */}
      <div style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.71rem",
        lineHeight: 1.65,
        overflowX: "auto",
        background: "#0d1117",
        maxHeight: 480,
        overflowY: "auto",
      }}>
        {chunks.map((chunk, i) => {
          const isAdded   = chunk.type === "added";
          const isRemoved = chunk.type === "removed";

          const bg     = isAdded   ? "rgba(46,160,67,0.15)"
                       : isRemoved ? "rgba(248,81,73,0.15)"
                       : "transparent";
          const color  = isAdded   ? "#56d364"
                       : isRemoved ? "#f85149"
                       : "#8b949e";
          const prefix = isAdded   ? "+"
                       : isRemoved ? "-"
                       : " ";
          const borderLeft = isAdded   ? "3px solid #238636"
                           : isRemoved ? "3px solid #da3633"
                           : "3px solid transparent";

          return (
            <div
              key={i}
              style={{
                display: "flex",
                background: bg,
                borderLeft,
                color,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                padding: "0 0 0 0",
                minWidth: 0,
              }}
            >
              {/* Gutter: line prefix symbol */}
              <span style={{
                width: 28, flexShrink: 0, textAlign: "center",
                userSelect: "none", opacity: 0.7,
                padding: "0 4px",
                borderRight: "1px solid rgba(255,255,255,0.06)",
              }}>
                {prefix}
              </span>
              {/* Line content */}
              <span style={{ padding: "0 12px", flex: 1, minWidth: 0 }}>
                {chunk.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

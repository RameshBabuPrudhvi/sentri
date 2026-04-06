import { useRef, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Braces, AlignLeft } from "lucide-react";

// Try to parse partial JSON — returns the parsed object or null
function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* partial stream */ }
  // Attempt to close open braces/brackets for partial JSON
  const partial = text.trim();
  for (const close of ["}", "}]", "}}", "}]}", "]"]) {
    try { return JSON.parse(partial + close); } catch { /* keep trying */ }
  }
  return null;
}

function countTokens(text) {
  // Rough token estimate: ~4 chars per token (GPT convention)
  return Math.round((text?.length ?? 0) / 4);
}

/**
 * LLMStreamPanel
 *
 * Props:
 *   tokens     — string, accumulated LLM output so far
 *   isRunning  — bool, whether the run is still active
 */
export default function LLMStreamPanel({ tokens = "", isRunning = false }) {
  const scrollRef = useRef(null);
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState("raw"); // "raw" | "json"

  // Auto-scroll to bottom as tokens arrive
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [tokens, open]);

  // Auto-open when streaming starts
  useEffect(() => {
    if (isRunning && tokens) setOpen(true);
  }, [isRunning, tokens]);

  const parsed = tryParseJson(tokens);
  const tokenCount = countTokens(tokens);
  const isEmpty = !tokens;
  const isTruncated = tokens.startsWith("⚠");

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 12 }}>
      {/* ── Header ── */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "11px 14px", cursor: "pointer",
          borderBottom: open ? "1px solid var(--border)" : "none",
          userSelect: "none",
        }}
      >
        {/* Collapse toggle */}
        <span style={{ color: "var(--text3)", display: "flex", flexShrink: 0 }}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>

        <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
          🧠 AI Thinking
          {isRunning && (
            <span style={{
              display: "inline-block", width: 7, height: 7, borderRadius: "50%",
              background: "var(--blue)", animation: "pulse 1.4s ease-in-out infinite",
              marginLeft: 2,
            }} />
          )}
        </span>

        {/* Token counter */}
        {tokenCount > 0 && (
          <span style={{
            fontSize: "0.67rem", color: "var(--text3)",
            fontFamily: "var(--font-mono)", marginLeft: "auto",
          }}>
            ~{tokenCount.toLocaleString()} tokens
          </span>
        )}

        {/* Mode toggle — only show when there's content */}
        {!isEmpty && open && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ display: "flex", gap: 2, marginLeft: tokenCount > 0 ? 10 : "auto" }}
          >
            {[
              { id: "raw",  Icon: AlignLeft, title: "Raw output" },
              { id: "json", Icon: Braces,    title: "JSON preview" },
            ].map(({ id, Icon, title }) => (
              <button
                key={id}
                title={title}
                onClick={() => setMode(id)}
                style={{
                  width: 24, height: 24, borderRadius: 5, border: "1px solid var(--border)",
                  background: mode === id ? "var(--accent-bg)" : "var(--bg)",
                  color: mode === id ? "var(--accent)" : "var(--text3)",
                  cursor: "pointer", display: "flex", alignItems: "center",
                  justifyContent: "center", transition: "all 0.12s",
                }}
              >
                <Icon size={11} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Body ── */}
      {open && (
        <div
          ref={scrollRef}
          style={{
            maxHeight: 280, overflowY: "auto",
            fontFamily: "var(--font-mono)", fontSize: "0.71rem",
            lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word",
            padding: isEmpty ? 0 : "12px 14px",
            background: "#0d1117", color: "#c9d1d9",
          }}
        >
          {isTruncated && (
            <div style={{
              padding: "6px 10px", marginBottom: 8,
              background: "rgba(245,166,35,0.12)", border: "1px solid rgba(245,166,35,0.3)",
              borderRadius: 6, fontSize: "0.68rem", color: "#f5a623",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              ⚠ Output exceeded {Math.round(50000 / 1000)}k characters — older content was trimmed. Showing most recent output only.
            </div>
          )}
          {isEmpty ? (
            <div style={{
              padding: "24px 14px", textAlign: "center",
              color: "var(--text3)", fontSize: "0.78rem",
              background: "transparent",
            }}>
              {isRunning ? (
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--blue)", borderTopColor: "transparent", animation: "spin 0.9s linear infinite", display: "inline-block" }} />
                  Waiting for AI response…
                </span>
              ) : "No AI output yet"}
            </div>
          ) : mode === "json" && parsed ? (
            <pre style={{ margin: 0, color: "#a5d6ff" }}>
              {JSON.stringify(parsed, null, 2)}
            </pre>
          ) : (
            <>
              {tokens}
              {isRunning && (
                <span style={{
                  display: "inline-block", width: "0.5em", height: "1em",
                  background: "#58a6ff", marginLeft: 1, verticalAlign: "text-bottom",
                  animation: "cursor-blink 1s step-end infinite",
                }} />
              )}
            </>
          )}
        </div>
      )}

      {/* Inline keyframe for cursor blink — avoids global CSS dependency */}
      <style>{`
        @keyframes cursor-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}

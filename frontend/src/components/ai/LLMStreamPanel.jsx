import { useRef, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Braces, AlignLeft } from "lucide-react";
import LLMContextRow from "./LLMContextRow.jsx";

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
 *   tokens       — string, accumulated LLM output so far
 *   isRunning    — bool, whether the run is still active
 *   stageLabel   — string, plain-English label for the active pipeline stage
 *                  (e.g. "Generate Tests via AI"). AI-004 (audit): without
 *                  this, the streaming panel shows raw tokens with zero
 *                  context — users can't tell which stage of the 8-stage
 *                  pipeline is producing output.
 *   stageIndex   — number, 1-based index of the active stage (e.g. 4 for
 *                  "Generate Tests via AI"). Combined with `totalStages`
 *                  renders the "Stage 4/8" progress hint the audit
 *                  recommends.
 *   totalStages  — number, total number of pipeline stages (8 for the
 *                  Generate flow; the consumer passes the count from its
 *                  own `PIPELINE_STAGES` array).
 *   agentRole    — string, the AI agent role driving this stage ("explorer",
 *                  "planner", "author", "healer"). The audit's recommended
 *                  copy is "Author agent generating test code with
 *                  [model name]"; we render the role + a friendlier
 *                  human-readable label.
 *   modelName    — string, the model id the active agent is using
 *                  (e.g. "claude-sonnet-4-20250514"). Surfaced inline so
 *                  technical users can correlate output style to the
 *                  underlying provider/model.
 */
export default function LLMStreamPanel({
  tokens = "",
  isRunning = false,
  stageLabel = null,
  stageIndex = null,
  totalStages = null,
  agentRole = null,
  modelName = null,
}) {
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

  // AI-004 (audit): the context-row JSX + tier-resolution logic moved to
  // the shared `<LLMContextRow>` so TestLab's pipeline view can render the
  // same row above its `<LiveLog>` without duplicating the markup. The
  // shared component also fixes the stage-0 truthiness bug flagged on this
  // file (BUG-0001 active finding): `(stageIndex && totalStages)` here
  // suppressed the progress chip for `stageIndex === 0`; the shared
  // component uses `stageIndex != null && stageIndex > 0` instead.

  return (
    <div className="card llm-stream">
      {/* ── Header ── */}
      <div
        onClick={() => setOpen((v) => !v)}
        className={`llm-stream__header${open ? " llm-stream__header--open" : ""}`}
      >
        {/* Collapse toggle */}
        <span className="llm-stream__chevron">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>

        <span className="llm-stream__title">
          🧠 AI Thinking
          {isRunning && <span className="llm-stream__title-dot" />}
        </span>

        {/* Token counter */}
        {tokenCount > 0 && (
          <span className="llm-stream__token-count">
            ~{tokenCount.toLocaleString()} tokens
          </span>
        )}

        {/* Mode toggle — only show when there's content. When the token
            counter is hidden, the mode toggle absorbs the right-edge
            anchor via the `--no-count` modifier so the row layout
            doesn't collapse into the title. */}
        {!isEmpty && open && (
          <div
            onClick={(e) => e.stopPropagation()}
            className={`llm-stream__mode-toggle${tokenCount > 0 ? "" : " llm-stream__mode-toggle--no-count"}`}
          >
            {[
              { id: "raw",  Icon: AlignLeft, title: "Raw output" },
              { id: "json", Icon: Braces,    title: "JSON preview" },
            ].map(({ id, Icon, title }) => (
              <button
                key={id}
                title={title}
                onClick={() => setMode(id)}
                className={`llm-stream__mode-btn${mode === id ? " llm-stream__mode-btn--active" : ""}`}
              >
                <Icon size={11} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Context row (AI-004, audit) ──
          Delegated to the shared `<LLMContextRow>` so TestLab's pipeline
          view can render the same line above its `<LiveLog>`. The shared
          component renders nothing when none of the context props are
          populated, so the conditional `open &&` guard is the only gate
          here (we still want to hide the row when the user collapsed the
          panel — the shared component itself doesn't know about open
          state). */}
      {open && (
        <LLMContextRow
          stageLabel={stageLabel}
          stageIndex={stageIndex}
          totalStages={totalStages}
          agentRole={agentRole}
          modelName={modelName}
          isRunning={isRunning}
        />
      )}

      {/* ── Body ── */}
      {open && (
        <div
          ref={scrollRef}
          className={`llm-stream__body${isEmpty ? "" : " llm-stream__body--padded"}`}
        >
          {isTruncated && (
            <div className="llm-stream__truncated">
              ⚠ Output exceeded {Math.round(50000 / 1000)}k characters — older content was trimmed. Showing most recent output only.
            </div>
          )}
          {isEmpty ? (
            <div className="llm-stream__empty">
              {isRunning ? (
                <span className="llm-stream__empty-inner">
                  <span className="llm-stream__empty-spinner" />
                  Waiting for AI response…
                </span>
              ) : "No AI output yet"}
            </div>
          ) : mode === "json" && parsed ? (
            <pre className="llm-stream__json">
              {JSON.stringify(parsed, null, 2)}
            </pre>
          ) : (
            <>
              {tokens}
              {isRunning && <span className="llm-stream__cursor" />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

import React from "react";

/**
 * AI-004 (audit) — Shared context row for AI-streaming surfaces.
 *
 * Extracted from `LLMStreamPanel` so TestLab's pipeline view can render the
 * same "<role> agent · <stage> with <model> · Stage N/M" line above its
 * `<LiveLog>` (which uses a different rendering than `LLMStreamPanel`'s
 * raw-token stream but serves the same explainability need).
 *
 * Renders nothing when none of the context props are populated — safe to drop
 * in unconditionally next to any streaming/log surface.
 *
 * Styling lives in `frontend/src/styles/features/llm-stream.css` under the
 * `.llm-stream__context*` rules; both `<LLMStreamPanel>` and any standalone
 * caller share that palette so the context line reads consistently across
 * the app.
 *
 * @param {Object} props
 * @param {string|null} props.stageLabel   - Plain-English label for the active
 *                                           pipeline stage (e.g. "Generate Tests
 *                                           via AI").
 * @param {number|null} props.stageIndex   - 1-based index of the active stage.
 *                                           Note: stage 0 is treated as "no
 *                                           stage" — callers should pass 1-based
 *                                           values or `null`, matching the
 *                                           backend's `currentStep` contract.
 * @param {number|null} props.totalStages  - Total number of pipeline stages
 *                                           (e.g. 8 for the Generate flow).
 * @param {string|null} props.agentRole    - "explorer" | "planner" | "author" |
 *                                           "healer". Rendered with title-case +
 *                                           "agent" suffix.
 * @param {string|null} props.modelName    - Model id (e.g.
 *                                           "claude-sonnet-4-20250514").
 * @param {boolean}     [props.isRunning]  - Drives the "· generating" fallback
 *                                           when no `stageLabel` is supplied.
 */
export default function LLMContextRow({
  stageLabel = null,
  stageIndex = null,
  totalStages = null,
  agentRole = null,
  modelName = null,
  isRunning = false,
}) {
  const roleLabel = agentRole
    ? `${agentRole.charAt(0).toUpperCase()}${agentRole.slice(1)} agent`
    : null;
  // `stageIndex` is 1-based per backend `currentStep` convention; treat 0 as
  // "not yet started" so the progress chip doesn't render mid-startup. The
  // `!= null` guard catches the stage-0 edge case (BUG-0001 active finding
  // on `LLMStreamPanel.jsx` flagged this for the panel's own copy of the
  // expression).
  const stageProgress = (stageIndex != null && stageIndex > 0 && totalStages != null)
    ? `Stage ${stageIndex}/${totalStages}`
    : null;
  const hasContext = !!(roleLabel || stageLabel || modelName || stageProgress);
  if (!hasContext) return null;

  return (
    <div className="llm-stream__context">
      {roleLabel && (
        <span>
          <span className="llm-stream__context-role">{roleLabel}</span>
          {stageLabel ? ` · ${stageLabel.toLowerCase()}` : isRunning ? " · generating" : ""}
          {modelName ? <> with <span className="llm-stream__context-model">{modelName}</span></> : null}
        </span>
      )}
      {!roleLabel && stageLabel && (
        <span className="llm-stream__context-role">{stageLabel}</span>
      )}
      {!roleLabel && !stageLabel && modelName && (
        <span className="llm-stream__context-model">{modelName}</span>
      )}
      {stageProgress && (
        <span
          className="llm-stream__context-progress"
          title="Pipeline progress — which stage is active"
        >
          {stageProgress}
        </span>
      )}
    </div>
  );
}

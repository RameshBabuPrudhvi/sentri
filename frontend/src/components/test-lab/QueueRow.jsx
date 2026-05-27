/**
 * @module components/test-lab/QueueRow
 * @description Single row rendered in the Test Lab Queue tab. Owns its own
 *   status-aware subtitle (Running / Completed / Failed / Aborted / Queued),
 *   the optional progress bar for active runs, and the per-row action
 *   buttons (Attach for active runs, View → /runs/:id for terminal runs).
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 * decomposition (audit §3.1). Kept here rather than co-located inside
 * `QueueTab.jsx` because the parent page passes the row component as a
 * prop (dependency-injected) so the queue rendering layer doesn't have to
 * import the icon + pipeline-stage constants directly.
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { StopCircle, ArrowRight } from "lucide-react";
import { fmtRelativeDate } from "../../utils/formatters.js";
import ProjIcon from "./ProjIcon.jsx";
import { PIPELINE_STAGES } from "./PipelinePanel.jsx";

/**
 * @param {{
 *   run: Object,
 *   project: Object,
 *   onStop: (runId: string) => void,
 *   onAttach: (run: Object) => void,
 * }} props
 *   `onAttach` is called for active runs to reattach the live view; it falls
 *   back to navigating to `/runs/:id` for completed runs.
 */
export default function QueueRow({ run, project, onStop, onAttach }) {
  const navigate = useNavigate();
  const isActive    = run.status === "running";
  const isCompleted = run.status === "completed" || run.status === "completed_empty";
  const isFailed    = run.status === "failed";
  const isAborted   = run.status === "aborted";
  // Any terminal status dims the row + suppresses the progress bar.
  const isTerminal  = isCompleted || isFailed || isAborted;

  const pct = run.currentStep != null
    ? Math.round(((run.currentStep - 1) / 7) * 100)
    : 0;

  // Subtitle reflects the actual outcome — a failed run must not read as
  // "Completed · N tests generated", and an aborted run must not fall through
  // to the "Queued" branch.
  let subtitle;
  if (isActive && run.currentStep != null) {
    subtitle = `Step ${run.currentStep}/8 · ${PIPELINE_STAGES[run.currentStep - 1]?.label ?? ""} · started ${fmtRelativeDate(run.startedAt)}`;
  } else if (isCompleted) {
    subtitle = `Completed · ${run.testsGenerated ?? 0} tests generated · ${fmtRelativeDate(run.startedAt)}`;
  } else if (isFailed) {
    subtitle = `Failed${run.error ? ` — ${run.error}` : ""} · ${fmtRelativeDate(run.startedAt)}`;
  } else if (isAborted) {
    subtitle = `Aborted · ${fmtRelativeDate(run.startedAt)}`;
  } else {
    subtitle = `Queued · ${fmtRelativeDate(run.startedAt)}`;
  }

  return (
    <div className={`tl-queue-row${isTerminal ? " tl-queue-row--done" : ""}`}>
      <ProjIcon project={project} />
      <div className="tl-queue-info">
        <div className="tl-queue-name">
          {project?.name ?? "Unknown"} · {run.type === "crawl" ? "Crawl & Generate" : "Requirement"}
        </div>
        <div className="tl-queue-sub">{subtitle}</div>
      </div>

      {isActive && (
        <div className="tl-queue-progress">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {isCompleted && (
        <span className="badge badge-green tl-queue-row__pin">done</span>
      )}
      {isFailed && (
        <span className="badge badge-red tl-queue-row__pin">failed</span>
      )}
      {isAborted && (
        <span className="badge badge-amber tl-queue-row__pin">aborted</span>
      )}

      {isActive ? (
        <>
          <button
            className="btn btn-ghost btn-sm tl-queue-row__pin"
            onClick={() => onAttach?.(run)}
            title="Attach the live pipeline view to this run"
          >
            View <ArrowRight size={13} />
          </button>
          <button
            className="btn btn-ghost btn-sm tl-queue-row__pin"
            onClick={() => onStop(run.id)}
          >
            <StopCircle size={14} />
            Stop
          </button>
        </>
      ) : (
        <button
          className="btn btn-ghost btn-sm tl-queue-row__pin"
          onClick={() => navigate(`/runs/${run.id}`)}
        >
          View <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}

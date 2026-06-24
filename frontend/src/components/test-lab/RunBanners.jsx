/**
 * @module components/test-lab/RunBanners
 * @description Terminal-state banners for the Test Lab run-center view —
 * one for completed runs (`<RunDoneBanner>`) and one for failed/aborted
 * runs (`<RunFailedBanner>`).
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` (the two
 * `{isRunDone && (...)} ` / `{isRunFailed && (...)} ` blocks formerly
 * at `:1682-1750`) so the page-level component stops being a 2400-line
 * monolith. AGENTS.md §40 — helpers with their own JSX surface belong in
 * a sibling file once they exceed a screenful.
 *
 * Both banners render inside the `.tl-run-center` div above the inner
 * tabs; they share the secondary "View run" / "Dismiss" action shape so
 * keeping them in one module keeps the action-stack styling synced.
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, ChevronRight } from "lucide-react";
import RetryButton from "./RetryButton.jsx";

/**
 * Success banner shown when a run completes (`completed` or
 * `completed_empty`). Surfaces the test-count split (drafts vs auto-
 * approved) and the canonical recovery actions.
 *
 * @param {Object} props
 * @param {Object} props.activeRun           - `{ runId, projectId, type }`
 * @param {{ total: number, drafts: number, autoApproved: number }} props.generatedOutcome
 * @param {() => void} props.onReset         - Dismiss handler from the page
 */
export function RunDoneBanner({ activeRun, generatedOutcome, onReset }) {
  const navigate = useNavigate();
  return (
    <div className="banner banner-success tl-banner-margin">
      <CheckCircle2 size={16} />
      <div className="tl-banner-body">
        <strong>Generation complete</strong> — {generatedOutcome.total} test{generatedOutcome.total !== 1 ? "s" : ""} generated
        {generatedOutcome.autoApproved > 0 && (
          <> · <span className="text-green">{generatedOutcome.autoApproved} auto-approved</span></>
        )}
        {generatedOutcome.drafts > 0 && (
          <> · {generatedOutcome.drafts} awaiting review</>
        )}
        .
        <div className="tl-banner-actions">
          {generatedOutcome.drafts > 0 && (
            <button
              className="btn btn-primary btn-xs"
              onClick={() => navigate(`/review-queue?projectId=${activeRun.projectId}`)}
            >
              Review {generatedOutcome.drafts} draft{generatedOutcome.drafts !== 1 ? "s" : ""} <ChevronRight size={12} />
            </button>
          )}
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => navigate(`/runs/${activeRun.runId}`)}
          >
            View run <ChevronRight size={12} />
          </button>
          <button
            className="btn btn-ghost btn-xs"
            onClick={onReset}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Error banner shown when a run terminates as `failed` or `aborted`.
 * The primary action is **Retry** (via `<RetryButton>`); secondary
 * actions mirror the success banner so the operator's mental model
 * stays the same across outcomes.
 *
 * @param {Object} props
 * @param {Object} props.activeRun           - `{ runId, projectId, type }`
 * @param {Object} props.runData             - Run snapshot for `runData.error`
 * @param {string} props.runStatus           - `failed | aborted`
 * @param {boolean} props.launching          - Disables Retry while a re-launch is in flight
 * @param {() => void} props.onRetry         - `handleRetry` from the page
 * @param {() => void} props.onReset         - `handleReset` from the page
 */
export function RunFailedBanner({ activeRun, runData, runStatus, launching, onRetry, onReset }) {
  const navigate = useNavigate();
  return (
    <div className="banner banner-error tl-banner-margin">
      <div>
        <strong>{runStatus === "aborted" ? "Run aborted" : "Run failed"}</strong>
        {runData?.error ? ` — ${runData.error}` : "."}
        {/* G11 — Retry uses the same dialsConfig + environmentId from
            the failed run. Implementation in `RetryButton`; `launching`
            is shared with the page's other launch handlers so a
            concurrent crawl/generate also disables retry. */}
        <RetryButton
          onRetry={onRetry}
          launching={launching}
          size="sm"
          className="tl-banner-spaced-btn-l"
        />
        <button
          className="btn btn-ghost btn-xs tl-banner-spaced-btn-s"
          onClick={() => navigate(`/runs/${activeRun.runId}`)}
        >
          View run <ChevronRight size={12} />
        </button>
        <button
          className="btn btn-ghost btn-xs tl-banner-spaced-btn-s"
          onClick={onReset}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

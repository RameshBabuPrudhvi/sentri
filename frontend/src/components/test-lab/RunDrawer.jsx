/**
 * @module components/test-lab/RunDrawer
 * @description Parallel-run drawer for Test Lab — G9 follow-up.
 *
 * Renders the list of currently-attached runs as a vertical strip of
 * cards. Each card shows: project name, run type (crawl / requirement),
 * a stage label or terminal status, and a compact progress bar. Clicking
 * a card flips the focused run (the one whose pipeline + log + agent
 * conversation render in the middle column).
 *
 * ### Why a separate component
 *
 * TestLab.jsx already exceeds 2000 lines. The drawer is a self-contained
 * surface — it reads `activeRuns` + `runDataByRunId` + `focusedRunId`
 * from the parent and emits two callbacks (`onFocus`, `onDismiss`).
 * Keeping it isolated means the parent's single responsibility stays
 * "manage the multi-run state machine"; layout/styling lives here.
 *
 * ### Drawer position
 *
 * Bottom-anchored strip (mirrors VS Code's bottom panel). The Test Lab
 * page already uses the right rail for the launch panel + run-attached
 * stats, so a right-rail drawer would compete for that space. A bottom
 * drawer slides up over the page footer without displacing existing
 * surfaces and matches the "transient task list" mental model.
 *
 * ### Visibility
 *
 * Renders nothing when `activeRuns.size === 0`. When the user dismisses
 * the last card the drawer fully collapses — no empty-state row, no
 * placeholder. The "+ New run" affordance lives in the launch panel,
 * not the drawer, so an empty drawer would just be visual noise.
 *
 * ### Accessibility
 *
 * Drawer container is `role="region"` with `aria-label="Active runs"`.
 * Each card is a `<button>` (real button, not a div-with-role — the
 * card content is single-line so the native button shape doesn't fight
 * any flex layout). The currently-focused card carries `aria-current="true"`
 * so screen readers announce which run the middle column is showing.
 * Dismiss buttons are nested inside the card buttons via stopPropagation
 * to keep click semantics clean (clicking the X dismisses; clicking
 * anywhere else focuses).
 *
 * ### Failure modes
 *
 * - `runDataByRunId.get(runId)` may be undefined briefly while the SSE
 *   snapshot is in flight. Cards degrade to "Connecting…" wording with
 *   an indeterminate progress bar rather than rendering blank.
 * - `projects` may be empty on first mount (TanStack Query hasn't
 *   returned). Cards fall back to the project ID as the title.
 * - `runDataByRunId.get(runId)?.status === "failed" / "aborted"` paints
 *   the card red; clicking still focuses it so the user can read the
 *   failure detail in the middle column.
 *
 * @param {Object} props
 * @param {Map<string, { runId: string, projectId: string, type: string }>} props.activeRuns
 *   - The full multi-run state. Keys are runIds. Insertion order is
 *     preserved (Map semantic) so cards render oldest-first.
 * @param {Map<string, Object>} props.runDataByRunId
 *   - Per-run state from SSE snapshots. Lookups by runId.
 * @param {string|null} props.focusedRunId
 *   - Which card has `aria-current` + the visual "active" treatment.
 * @param {Array<Object>} props.projects
 *   - From `useProjectData`. Used to resolve `projectId → name`.
 * @param {(runId: string) => void} props.onFocus
 *   - Caller flips the middle column to show this run's pipeline view.
 * @param {(runId: string) => void} props.onDismiss
 *   - Caller removes the run from `activeRuns` and tears down its SSE
 *     subscription. Does NOT abort the underlying run server-side —
 *     the user can re-attach from the Queue tab.
 */
import React from "react";
import { X, Loader2 } from "lucide-react";
// ── Per-stage label (kept in sync with PIPELINE_STAGES in TestLab.jsx) ───
//
// We don't import the constant from TestLab.jsx because doing so would
// create a circular module dependency (TestLab → RunDrawer → TestLab)
// once the parent refactor imports this component. Duplicating the 8
// stage labels here is the lesser evil — the labels change once a year
// and a drift-detector test in `frontend/tests/` can pin them if it
// becomes a real concern.
const STAGE_LABELS = [
  "Crawl & snapshot",
  "Filter elements",
  "Classify intents",
  "Generate tests",
  "Deduplicate",
  "Enhance assertions",
  "Validate",
  "Done",
];
// ── Status → visual tone ─────────────────────────────────────────────────
const TONE_BY_STATUS = {
  running:         "running",
  queued:          "queued",
  completed:       "done",
  completed_empty: "done",
  failed:          "failed",
  aborted:         "aborted",
  interrupted:     "aborted",
};
/**
 * Derive the per-card visible state from the run data + activeRun shape.
 * Pure function — testable in isolation if a JSX harness lands.
 *
 * @param {Object|undefined} runData
 * @param {{ type: string }} activeRunEntry
 * @returns {{
 *   subtitle: string,
 *   tone: "running" | "queued" | "done" | "failed" | "aborted" | "connecting",
 *   pct: number,
 *   showSpinner: boolean,
 * }}
 */
export function deriveCardState(runData, activeRunEntry) {
  // Snapshot hasn't landed yet — show a connecting state. This is the
  // sub-second window between `setActiveRuns(prev → prev.set(runId, …))`
  // and the first SSE `snapshot` event.
  if (!runData) {
    return {
      subtitle: "Connecting…",
      tone: "connecting",
      pct: 0,
      showSpinner: true,
    };
  }
  const status = runData.status || "running";
  const tone = TONE_BY_STATUS[status] || "running";
  const isTerminal = tone === "done" || tone === "failed" || tone === "aborted";
  if (isTerminal) {
    if (tone === "done") {
      const n = runData.testsGenerated ?? 0;
      return {
        subtitle: n === 0
          ? "Completed — no tests generated"
          : `Completed — ${n} test${n !== 1 ? "s" : ""} generated`,
        tone,
        pct: 100,
        showSpinner: false,
      };
    }
    if (tone === "failed") {
      const err = runData.error ? ` — ${runData.error}` : "";
      return { subtitle: `Failed${err}`, tone, pct: 100, showSpinner: false };
    }
    return { subtitle: "Aborted", tone, pct: 100, showSpinner: false };
  }
  // Running. Percent is currentStep-based (mirrors the inline progress
  // bar at TestLab.jsx around the pipeline column).
  const cs = runData.currentStep;
  const stageLabel = cs != null
    ? STAGE_LABELS[Math.max(0, Math.min(cs - 1, STAGE_LABELS.length - 1))]
    : "Starting…";
  const pct = cs != null ? Math.round(((cs - 1) / 7) * 100) : 0;
  const subtitle = cs != null
    ? `Step ${cs}/8 · ${stageLabel}`
    : "Starting…";
  return { subtitle, tone, pct, showSpinner: true };
}
// ── Component ────────────────────────────────────────────────────────────
export default function RunDrawer({
  activeRuns,
  runDataByRunId,
  focusedRunId,
  projects,
  onFocus,
  onDismiss,
}) {
  // Early return: drawer is invisible when no runs are attached. The
  // launch panel's "+ New run" CTA + the Queue tab are the entry points
  // — the drawer is purely for switching between live runs.
  if (!activeRuns || activeRuns.size === 0) {
    return null;
  }
  // Map → array for rendering. Map preserves insertion order, so cards
  // render oldest-first. If we ever want newest-first we sort here.
  const entries = Array.from(activeRuns.entries());
  const projectsById = new Map(
    Array.isArray(projects) ? projects.map(p => [p.id, p]) : [],
  );
  return (
    <aside
      className="rd-drawer"
      role="region"
      aria-label="Active runs"
    >
      <div className="rd-drawer__header">
        <span className="rd-drawer__title">Active runs</span>
        <span className="rd-drawer__count" aria-label={`${activeRuns.size} active`}>
          {activeRuns.size}
        </span>
      </div>
      <ol className="rd-drawer__list">
        {entries.map(([runId, entry]) => {
          const runData = runDataByRunId?.get?.(runId);
          const project = projectsById.get(entry.projectId);
          const state = deriveCardState(runData, entry);
          const isFocused = runId === focusedRunId;
          const typeLabel = entry.type === "crawl" ? "Crawl & Generate" : "Requirement";
          return (
            <li key={runId} className="rd-drawer__item">
              <button
                type="button"
                className={`rd-card rd-card--${state.tone}${isFocused ? " rd-card--focused" : ""}`}
                onClick={() => onFocus?.(runId)}
                aria-current={isFocused ? "true" : undefined}
                aria-label={`Focus run for ${project?.name || entry.projectId} — ${state.subtitle}`}
              >
                <div className="rd-card__head">
                  <span className="rd-card__name">
                    {project?.name || entry.projectId}
                  </span>
                  <span className="rd-card__type">{typeLabel}</span>
                </div>
                <div className="rd-card__sub">
                  {state.showSpinner && (
                    <Loader2 size={11} className="rd-card__spinner" aria-hidden="true" />
                  )}
                  <span className="rd-card__sub-text">{state.subtitle}</span>
                </div>
                {/* Progress bar — visible for running + terminal runs.
                    For terminal runs it sits at 100% as a "completed"
                    visual; for running runs it tracks currentStep / 7. */}
                <div
                  className="rd-card__progress"
                  role="progressbar"
                  aria-valuenow={state.pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Progress ${state.pct}%`}
                >
                  <div
                    className="rd-card__progress-fill"
                    style={{ width: `${state.pct}%` }}
                  />
                </div>
                {/* Dismiss control. Nested inside the focus-button so
                    visual layout stays as one rectangle, but
                    stopPropagation keeps the click semantic clean
                    (dismiss does not bubble to focus). Rendered as a
                    <span role="button"> rather than a real <button>
                    because nested <button> is invalid HTML. */}
                 <span
                  role="button"
                  tabIndex={0}
                  className="rd-card__dismiss"
                  aria-label={`Dismiss run for ${project?.name || entry.projectId}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismiss?.(runId);
                  }}
                  onKeyDown={(e) => {
                    // Enter + Space activate the dismiss (mirrors the
                    // native <button> contract). stopPropagation so the
                    // parent card's onClick doesn't also fire on Enter.
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onDismiss?.(runId);
                    }
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/**
 * @module components/test-lab/QueueTab
 * @description Test Lab Queue tab — workspace-wide list of generation runs.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` (the ~96-line inline
 * block at `tab === "queue"`) so the page stays focused on tab routing +
 * run-lifecycle state and the Queue surface lives in its own file.
 * AGENT.md §40 — feature surfaces > 50 lines that have their own data
 * shape (active + recent partition, project filter, empty state) belong
 * in `components/`, not inline.
 *
 * ### Render shape
 *
 *   <div role="tabpanel" aria-labelledby="…">
 *     <header>title + active-count badge + project filter</header>
 *     <ol>
 *       (no rows)    → <EmptyState> with "Start Crawl & Generate" CTA
 *       (else)       → "Active" section (filtered)   → <QueueRow>×N
 *                    → "Recent" section (filtered)   → <QueueRow>×N
 *     </ol>
 *   </div>
 *
 * The project filter (`queueFilter`) is parent-owned because the same
 * page state has to survive tab swaps — pushing it down into this
 * component would reset the filter on every tab toggle, which is
 * confusing UX when the user is comparing runs across tabs.
 *
 * ### Styling
 *
 * All visual rules live in `frontend/src/styles/pages/test-lab.css`
 * under the `.tl-queue-*` namespace already in use — zero inline styles,
 * zero new CSS file. The component is pure presentation + composition.
 *
 * ### Accessibility
 *
 * The active-count badge has `aria-label="N active runs"` so screen-
 * reader users hear the count alongside the visual. The project filter
 * is a native `<select>` so keyboard nav + screen-reader announcement
 * are free. `<EmptyState>` already handles its own ARIA contract.
 *
 * @param {Object} props
 * @param {Object[]} props.activeQueueRuns  - Newest-first runs with
 *   `status === "running"`. Caller filters by `isGenerationRun`.
 * @param {Object[]} props.recentQueueRuns  - Most-recent 8 terminal
 *   generation runs (completed / failed / aborted). Caller filters +
 *   slices before passing in.
 * @param {Object[]} props.projects         - All workspace projects;
 *   used by both `<QueueRow>` (to resolve project name) AND the project
 *   filter dropdown.
 * @param {string}   props.queueFilter      - `"all"` or a projectId.
 * @param {(next: string) => void} props.onQueueFilterChange
 * @param {(runId: string) => void | Promise<void>} props.onStop
 *   Called when the user clicks Stop on an active row.
 * @param {(run: Object) => void} props.onAttach
 *   Called when the user clicks View on an active row.
 * @param {() => void} props.onSwitchToCrawl
 *   Empty-state CTA target — caller flips the parent tab to "crawl".
 * @param {React.ComponentType} props.QueueRow      - The row component.
 *   Injected so this file stays decoupled from the page-internal
 *   `<QueueRow>` definition (which closes over `<ProjIcon>` + the
 *   `PIPELINE_STAGES` constant).
 * @param {React.ComponentType} props.EmptyState    - Shared empty-state
 *   primitive. Injected for the same reason — keeps this file free of
 *   side-effect imports beyond React + lucide.
 * @param {React.ComponentType} props.ClockIcon     - Lucide icon for
 *   the empty state; injected so this file doesn't reach into
 *   `lucide-react` (the parent already imports it for the tablist).
 */

import React from "react";

export default function QueueTab({
  activeQueueRuns,
  recentQueueRuns,
  projects,
  queueFilter,
  onQueueFilterChange,
  onStop,
  onAttach,
  onSwitchToCrawl,
  QueueRow,
  EmptyState,
  ClockIcon,
}) {
  // Apply project filter — when "all" the input arrays pass through
  // unchanged. Filtering here (not in the parent) so the parent doesn't
  // have to recompute when the user toggles the dropdown — only this
  // component re-renders, and the filter pass is O(N) over already-
  // small arrays (caps at the parent's slice limits).
  const filteredActive = queueFilter === "all"
    ? activeQueueRuns
    : activeQueueRuns.filter((r) => r.projectId === queueFilter);
  const filteredRecent = queueFilter === "all"
    ? recentQueueRuns
    : recentQueueRuns.filter((r) => r.projectId === queueFilter);

  return (
    <div className="tl-queue-wrap fade-in">
      <div className="tl-queue-header">
        <div>
          <h2 className="page-title tl-queue-title">Queue</h2>
          <p className="page-subtitle">All active and recent generation runs across projects</p>
        </div>
        <div className="flex-between gap-sm tl-queue-actions">
          <span
            className="badge badge-blue"
            aria-label={`${activeQueueRuns.length} active`}
          >
            {activeQueueRuns.length} active
          </span>
          {activeQueueRuns.length > 0 && (
            <span className="badge badge-green tl-queue-pulse-badge">running</span>
          )}
          {/* Project filter — shown when there are multiple projects so
              single-project workspaces don't see a 1-option dropdown. */}
          {projects.length > 1 && (
            <select
              className="tl-select tl-queue-filter-select"
              value={queueFilter}
              onChange={(e) => onQueueFilterChange(e.target.value)}
              aria-label="Filter queue by project"
            >
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {filteredActive.length === 0 && filteredRecent.length === 0 && (
        // ONB-002 (audit): swap the bare emoji+text empty state for
        // the shared primitive so the Queue tab matches the icon +
        // title + description + CTA shape used on Tests, Projects,
        // Runs, HealingDashboard, and Dashboard. The CTA jumps the
        // user back to the Crawl & Generate tab — the action that
        // produces queue rows — instead of leaving them stuck on an
        // empty surface. When a project filter is active, we also
        // surface a "Clear filter" secondary action so the user has
        // an escape hatch without retyping the dropdown.
        <EmptyState
          icon={<ClockIcon size={32} color="var(--accent)" />}
          title={queueFilter === "all" ? "No runs yet" : "No runs for this project"}
          description={queueFilter === "all"
            ? "Start a crawl or generate tests from a requirement to see them here."
            : "Switch to a different project or start a new run."}
          secondaryAction={queueFilter !== "all"
            ? { label: "Clear filter", onClick: () => onQueueFilterChange("all") }
            : null}
          action={{ label: "Start Crawl & Generate", onClick: onSwitchToCrawl }}
        />
      )}

      {filteredActive.length > 0 && (
        <>
          <div className="section-label mb-sm">Active</div>
          {filteredActive.map((run) => (
            <QueueRow
              key={run.id}
              run={run}
              project={projects.find((p) => p.id === run.projectId)}
              onStop={onStop}
              onAttach={onAttach}
            />
          ))}
        </>
      )}

      {filteredRecent.length > 0 && (
        <>
          <div className="section-label mb-sm tl-queue-recent-label">Recent</div>
          {filteredRecent.map((run) => (
            <QueueRow
              key={run.id}
              run={run}
              project={projects.find((p) => p.id === run.projectId)}
              onStop={onStop}
              onAttach={onAttach}
            />
          ))}
        </>
      )}
    </div>
  );
}

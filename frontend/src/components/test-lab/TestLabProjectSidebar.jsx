/**
 * @module components/test-lab/TestLabProjectSidebar
 * @description Left rail of the Test Lab grid — project list + "Last Crawl"
 *   meta footer. Each project item is keyboard-operable (WCAG 2.1.1) with
 *   `role="button"` + `aria-pressed` reflecting the current selection.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 * decomposition (audit §3.1). Pure presentational — selection state is
 * page-owned and flows in via `selectedId` + `onSelectProject`.
 */
import React from "react";
import { fmtRelativeDate } from "../../utils/formatters.js";
import ProjIcon from "./ProjIcon.jsx";

export default function TestLabProjectSidebar({
  projects,
  selectedId,
  loadingProjects,
  lastCrawlRun,
  onSelectProject,
}) {
  return (
    // G15 (a11y) — sidebar wrapped as `role="navigation"` with an
    // `aria-label` so screen readers announce "Projects navigation"
    // when the user tabs into the rail. Inner list uses semantic
    // defaults (the per-item `role="button"` already gives screen
    // readers the actionable shape); a literal `role="listbox"`
    // would imply single-select with arrow-key navigation, which
    // we don't yet implement and would mislead AT users. Revisit
    // this once arrow-key list nav lands.
    <nav className="tl-projects" aria-label="Projects">
      <div className="tl-col-header" id="tl-projects-heading">Projects</div>
      <div className="tl-proj-list" aria-labelledby="tl-projects-heading">
        {loadingProjects
          ? [1, 2].map(i => (
              <div key={i} className="skeleton tl-proj-skeleton" />
            ))
          : projects.map(p => (
              // G15 (a11y) — project sidebar items were `<div onClick>`
              // with no keyboard affordance. WCAG 2.1.1 (Keyboard, Level
              // A) requires every interactive element be operable via
              // keyboard. Promoted to `role="button"` + `tabIndex={0}`
              // + Enter/Space activation. `aria-pressed` reflects the
              // selected state so screen-reader users hear "selected"
              // / "not selected" alongside the visible active styling.
              // Kept as a `<div>` (not a `<button>`) because the inner
              // markup is two block-level rows (name + url) and a
              // native `<button>` requires `display: flex` overrides
              // that fight with the existing `.tl-proj-item` flex rule.
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                aria-pressed={p.id === selectedId}
                aria-label={`Select project ${p.name}`}
                className={`tl-proj-item${p.id === selectedId ? " tl-proj-item--active" : ""}`}
                onClick={() => onSelectProject(p.id)}
                onKeyDown={(e) => {
                  // Enter + Space activate, matching native <button>
                  // behaviour. preventDefault on Space stops the page
                  // scroll. Other keys pass through (Tab navigates,
                  // arrow keys reserved for future list-nav follow-up).
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectProject(p.id);
                  }
                }}
              >
                <ProjIcon project={p} />
                <div className="tl-proj-info">
                  <div className="tl-proj-name">{p.name}</div>
                  <div className="tl-proj-url">{p.url?.replace(/^https?:\/\//, "")}</div>
                </div>
              </div>
            ))
        }
      </div>

      {/* Last crawl meta */}
      {lastCrawlRun && (
        <div className="tl-proj-meta">
          <div className="tl-proj-meta-label">Last Crawl</div>
          <div className="tl-proj-meta-value">
            {fmtRelativeDate(lastCrawlRun.startedAt)}
          </div>
          <div className="tl-proj-meta-value tl-proj-meta-value--row2">
            {lastCrawlRun.pagesFound ?? "?"} pages · {lastCrawlRun.testsGenerated ?? "?"} tests
          </div>
        </div>
      )}
    </nav>
  );
}

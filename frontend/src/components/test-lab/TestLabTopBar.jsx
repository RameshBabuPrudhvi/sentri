/**
 * @module components/test-lab/TestLabTopBar
 * @description Test Lab page header — brand block (Atom icon + title +
 *   tagline), tablist (`<TestLabTabs>`), and the right-aligned "Record a
 *   test" CTA.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 * decomposition (audit §3.1). Pure presentational — every writer is
 * page-owned and flows in via callbacks.
 */
import React from "react";
import { Atom, Video } from "lucide-react";
import TestLabTabs from "./TestLabTabs.jsx";

export default function TestLabTopBar({
  tab,
  onTabChange,
  activeQueueCount,
  selectedProject,
  onRecord,
}) {
  return (
    <div className="tl-topbar">
      <div className="tl-topbar__brand">
        <Atom size={16} className="tl-topbar__brand-icon" />
        <span className="tl-topbar__brand-title">Test Lab</span>
        <span className="tl-topbar__brand-tagline">AI test generation workspace</span>
      </div>

      {/* G15 (a11y) — WAI-ARIA APG tablist. Implementation + comments
          live in `frontend/src/components/test-lab/TestLabTabs.jsx`. */}
      <TestLabTabs
        tab={tab}
        onChange={onTabChange}
        activeQueueCount={activeQueueCount}
      />

      {/* Record action — right-aligned, styled as a primary CTA so it
          reads as a peer to the tabs rather than disappearing as a ghost
          button. Recording remains a modal because the live screencast
          preview needs a focused overlay surface; the Test Lab page only
          provides the launch point. Disabled until a project is selected
          so we have a valid `projectId` to seed. */}
      <button
        className="btn btn-primary btn-sm tl-record-btn"
        onClick={onRecord}
        disabled={!selectedProject}
        title={selectedProject
          ? `Record a test in ${selectedProject.name}`
          : "Select a project first"}
      >
        <Video size={14} />
        Record a test
      </button>
    </div>
  );
}

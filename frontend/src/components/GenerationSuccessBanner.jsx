import React from "react";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import OutcomeBanner from "./OutcomeBanner.jsx";

/**
 * GenerationSuccessBanner — shown after a crawl or generate run finishes
 * successfully. Navigates the user to the project page to review generated tests.
 *
 * Props:
 *   run       — the run object (needs .status, .projectId, .tests, .testsGenerated)
 *   isRunning — whether the run is still in progress
 */
export default function GenerationSuccessBanner({ run, isRunning }) {
  const navigate = useNavigate();

  const testCount = run?.tests?.length || run?.testsGenerated || 0;

  if (isRunning || run?.status !== "completed" || !run?.projectId || testCount === 0) {
    return null;
  }

  return (
    <OutcomeBanner
      variant="success"
      title={`🎉 ${testCount} test${testCount === 1 ? "" : "s"} generated successfully`}
      subtitle="Your tests are saved as drafts — review and approve them to add to your regression suite."
    >
      <button
        className="btn btn-sm"
        style={{
          background: "var(--green)", color: "#fff", border: "none",
          fontWeight: 700, whiteSpace: "nowrap", gap: 6, flexShrink: 0,
        }}
        onClick={() => navigate(`/projects/${run.projectId}`)}
      >
        View Generated Tests <ArrowRight size={13} />
      </button>
    </OutcomeBanner>
  );
}

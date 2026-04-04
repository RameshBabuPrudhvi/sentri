import React from "react";
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * Completion CTA banner — shown after a crawl or generate run finishes
 * successfully. Navigates the user to the project page to review generated tests.
 *
 * Props:
 *   run       — the run object (needs .status, .projectId, .tests, .testsGenerated)
 *   isRunning — whether the run is still in progress
 */
export default function CompletionCTA({ run, isRunning }) {
  const navigate = useNavigate();

  const testCount = run?.tests?.length || run?.testsGenerated || 0;

  if (isRunning || run?.status !== "completed" || !run?.projectId || testCount === 0) {
    return null;
  }

  return (
    <div style={{
      padding: "16px 18px", background: "var(--green-bg)",
      border: "1px solid #86efac", borderRadius: "var(--radius)",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 12,
    }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--green)", marginBottom: 3 }}>
          🎉 {testCount} test{testCount === 1 ? "" : "s"} generated successfully
        </div>
        <div style={{ fontSize: "0.78rem", color: "var(--text2)", lineHeight: 1.5 }}>
          Your tests are saved as drafts — review and approve them to add to your regression suite.
        </div>
      </div>
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
    </div>
  );
}

/**
 * @module components/project/RunToast
 * @description Floating toast for run lifecycle feedback on Project Detail.
 */

import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * @param {Object} props
 * @param {string} props.msg
 * @param {"success"|"error"|"info"} props.type
 * @param {boolean} props.visible
 * @param {boolean} props.onViewRun
 * @param {string|null} props.runId
 * @returns {React.ReactElement}
 */
export default function RunToast({ msg, type, visible, onViewRun, runId }) {
  const colors = { success: "var(--green)", error: "var(--red)", info: "var(--accent)" };
  const navigate = useNavigate();

  return (
    <div style={{
      position: "fixed", bottom: 24, right: 28, zIndex: 9999,
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8,
      fontSize: "0.83rem", fontWeight: 500, boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
      transition: "all 0.25s", opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(12px)", pointerEvents: visible ? "auto" : "none",
    }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: colors[type] || colors.info, flexShrink: 0 }} />
      {msg}
      {onViewRun && runId && (
        <button
          className="btn btn-ghost btn-xs"
          style={{ marginLeft: 8, pointerEvents: "auto" }}
          onClick={() => navigate(`/runs/${runId}`)}
        >
          View run <ArrowRight size={11} />
        </button>
      )}
    </div>
  );
}

/**
 * @module components/project/RunToast
 * @description Floating toast for run lifecycle feedback on Project Detail.
 */

import React from "react";
import { ArrowRight, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * @param {Object} props
 * @param {string} props.msg
 * @param {"success"|"error"|"info"} props.type
 * @param {boolean} props.visible
 * @param {boolean} props.showViewRun - Whether to show the "View run" navigation button.
 * @param {string|null} props.runId
 * @param {Function} [props.onDismiss] - Optional close handler. When provided, renders a × button.
 * @returns {React.ReactElement}
 */
export default function RunToast({ msg, type, visible, onViewRun, runId, onDismiss }) {
  const colors = { success: "var(--green)", error: "var(--red)", info: "var(--accent)" };
  const navigate = useNavigate();

  // WAI-ARIA: error toasts use `role="alert"` + `aria-live="assertive"` so
  // screen readers interrupt with the failure message; success/info use
  // `role="status"` + `aria-live="polite"` to announce without interrupting.
  // `aria-atomic="true"` ensures the full message is read on each update
  // rather than only the diff. Matches the WCAG 2.2 / WAI-ARIA APG pattern
  // used by GitHub flash banners and Linear's toast surface.
  const isError = type === "error";

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      // `aria-hidden` while invisible so AT doesn't announce a stale
      // toast that's mid-fade-out. The role/live attrs above only kick
      // in when the toast becomes visible.
      aria-hidden={!visible}
      style={{
        position: "fixed", bottom: 24, right: 28, zIndex: 9999,
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: 10, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8,
        fontSize: "0.83rem", fontWeight: 500, boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
        transition: "all 0.25s", opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)", pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: colors[type] || colors.info, flexShrink: 0 }} />
      <span>{msg}</span>
      {onViewRun && runId && (
        <button
          className="btn btn-ghost btn-xs"
          style={{ marginLeft: 8, pointerEvents: "auto" }}
          onClick={() => navigate(`/runs/${runId}`)}
        >
          View run <ArrowRight size={11} />
        </button>
      )}
      {/* WCAG 2.2 SC 2.2.1 — user-dismissable affordance. The toast still
          auto-dismisses, but a keyboard / screen-reader user can close it
          early without waiting for the timer. */}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={onDismiss}
          style={{
            marginLeft: 4, background: "none", border: "none", cursor: "pointer",
            color: "var(--text3)", padding: 2, display: "flex", alignItems: "center",
            borderRadius: 4, pointerEvents: "auto",
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

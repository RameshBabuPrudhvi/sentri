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
 * @param {{label:string,onClick:Function}|null} [props.action] - Optional inline CTA
 *   (e.g. Undo). Rendered before the View-run button. The handler is invoked
 *   AND the toast is dismissed in one click — wrapping happens at the
 *   `ToastContext` layer so this component stays a pure renderer.
 * @returns {React.ReactElement}
 *
 * AGENT.md:127 — all styles live in `frontend/src/styles/components/run-toast.css`.
 * This component is JSX-only: ARIA wiring + class names + the `data-toast-type`
 * hook the CSS reads to swatch the status dot. No inline styles.
 */
export default function RunToast({ msg, type, visible, onViewRun, runId, onDismiss, action }) {
  const navigate = useNavigate();

  // WAI-ARIA: error toasts use `role="alert"` + `aria-live="assertive"` so
  // screen readers interrupt with the failure message; success/info use
  // `role="status"` + `aria-live="polite"` to announce without interrupting.
  // `aria-atomic="true"` ensures the full message is read on each update
  // rather than only the diff. Matches the WCAG 2.2 / WAI-ARIA APG pattern
  // used by GitHub flash banners and Linear's toast surface.
  //
  // `aria-hidden={!visible}` doubles as the visibility hook the CSS uses
  // for the fade-out transition (see `.rt-toast[aria-hidden="true"]`).
  const isError = type === "error";

  return (
    <div
      className="rt-toast"
      data-toast-type={type || "info"}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      aria-hidden={!visible}
    >
      <div className="rt-toast__dot" />
      <span className="rt-toast__msg">{msg}</span>
      {/* Optional inline CTA — used today for "Undo" on bulk-action toasts.
          Rendered BEFORE the View-run / dismiss buttons so the primary
          recovery action sits closest to the message it relates to. */}
      {action && (
        <button
          type="button"
          className="btn btn-ghost btn-xs rt-toast__action-btn"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
      {onViewRun && runId && (
        <button
          className="btn btn-ghost btn-xs rt-toast__view-btn"
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
          className="rt-toast__dismiss-btn"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

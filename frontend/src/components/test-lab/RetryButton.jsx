/**
 * @module components/test-lab/RetryButton
 * @description Primary "Retry" button for the G11 failed-run recovery flow.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` so the spinner / label /
 * disabled-state shape lives in one place instead of being duplicated
 * between the failure banner (compact, `btn-xs`) and the right-rail panel
 * (full-width, default size). Both call-sites share the same `onRetry` +
 * `launching` props, so any future tweak (telemetry, focus management,
 * confirm dialog) lands once.
 */

import React from "react";
import { RotateCcw } from "lucide-react";

/**
 * @param {Object} props
 * @param {() => void} props.onRetry         - Click handler (typically `handleRetry`).
 * @param {boolean}    props.launching       - Disables the button + swaps
 *   the icon for the in-flight spinner. Shared with the page's other launch
 *   handlers so a concurrent crawl/generate also disables retry.
 * @param {"sm"|"md"} [props.size="sm"]      - `"sm"` → `btn-xs` icon+12px
 *   (banner variant). `"md"` → default size + 13px icon + `tl-full-btn`
 *   layout class (right-panel variant).
 * @param {string} [props.className]         - Extra classes (e.g.
 *   `tl-banner-spaced-btn-l` for the banner variant).
 * @param {string} [props.label="Retry"]     - Idle label; banner uses
 *   "Retry", right rail uses "Retry run".
 */
export default function RetryButton({
  onRetry,
  launching,
  size = "sm",
  className = "",
  label = "Retry",
}) {
  const iconSize = size === "sm" ? 12 : 13;
  const sizeClass = size === "sm" ? "btn-xs" : "tl-full-btn";
  return (
    <button
      className={`btn btn-primary ${sizeClass}${className ? ` ${className}` : ""}`}
      onClick={onRetry}
      disabled={launching}
      title="Re-run with the same configuration"
    >
      {launching ? (
        <><span className="spin"><RotateCcw size={iconSize} /></span> Retrying…</>
      ) : (
        <><RotateCcw size={iconSize} /> {label}</>
      )}
    </button>
  );
}

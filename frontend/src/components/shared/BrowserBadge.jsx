/**
 * @module components/shared/BrowserBadge
 * @description Per-run browser engine badge (DIF-002b gap 3).
 *
 * Surfaces `run.browser` (chromium / firefox / webkit) on the Run Detail
 * header and Runs list. Falls back to "chromium" for pre-migration-009
 * runs where `run.browser` is null so the badge always renders something
 * meaningful.
 */

import React from "react";

const BROWSER_META = {
  chromium: { label: "Chromium", color: "var(--blue)",   bg: "var(--blue-bg)",        icon: "🌐" },
  firefox:  { label: "Firefox",  color: "#dd4814",        bg: "rgba(221,72,20,0.10)",  icon: "🦊" },
  webkit:   { label: "WebKit",   color: "#1d6fff",        bg: "rgba(29,111,255,0.10)", icon: "🧭" },
};

/**
 * @param {Object}      props
 * @param {string|null} [props.browser] - One of "chromium" | "firefox" | "webkit".
 *                                        Null/undefined falls back to "chromium".
 * @param {boolean}     [props.compact] - Hide the text label, icon-only.
 * @returns {JSX.Element}
 */
export default function BrowserBadge({ browser, compact = false }) {
  const key = (browser || "chromium").toLowerCase();
  const meta = BROWSER_META[key] || BROWSER_META.chromium;
  return (
    <span
      className="badge"
      style={{
        background: meta.bg,
        color: meta.color,
        border: `1px solid ${meta.color}33`,
        gap: 4,
        fontWeight: 600,
      }}
      title={`Browser engine: ${meta.label}`}
      aria-label={`Browser: ${meta.label}`}
    >
      <span aria-hidden="true">{meta.icon}</span>
      {!compact && meta.label}
    </span>
  );
}

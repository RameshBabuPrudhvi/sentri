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
  chromium: { label: "Chromium", color: "var(--blue)",    bg: "var(--blue-bg)",    icon: "🌐" },
  firefox:  { label: "Firefox",  color: "var(--firefox)", bg: "var(--firefox-bg)", icon: "🦊" },
  webkit:   { label: "WebKit",   color: "var(--webkit)",  bg: "var(--webkit-bg)",  icon: "🧭" },
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
        // The `bg` token is already a low-alpha tint of the brand colour; reuse
        // it as the border so we don't try to splice an alpha suffix onto a
        // `var(--…)` reference (which CSS doesn't support).
        border: `1px solid ${meta.bg}`,
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

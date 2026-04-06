/**
 * @module components/AppLogo
 * @description SVG logo — animated "watching eyes" icon + wordmark.
 *
 * The icon uses a rotating rainbow-gradient border (Google brand colours)
 * with two animated eyeballs that look side-to-side and blink.
 * The wordmark uses `var(--text)` by default so it adapts to light/dark mode
 * automatically, or accepts an explicit `color` override for custom contexts
 * (e.g. the Login page's dark background).
 *
 * This is the **single source of truth** for the brand visual identity.
 *
 * @param {Object} props
 * @param {number}  [props.size=40]       - Controls height of the icon in pixels.
 * @param {string}  [props.variant="full"] - `"icon"` | `"wordmark"` | `"full"`.
 * @param {string}  [props.color]          - Explicit wordmark color; omit to use `var(--text)`.
 * @param {Object}  [props.style]          - Additional inline styles for the wrapper.
 * @returns {React.ReactElement}
 *
 * @example
 * <AppLogo size={36} variant="full" color="#f1f5f9" />
 */

import React, { useId } from "react";

function IconMark({ size = 40 }) {
  const uid = useId();
  const gradId = `sentri-snake-${uid}`;
  // Cropped viewBox tightly around artwork (eyes visor).
  // size controls height (matches old shield where size = height = width).
  // Width scales from the 1.75:1 aspect ratio.
  const h = size;
  const w = Math.round(size * 1.75);
  return (
    <svg
      width={w}
      height={h}
      viewBox="30 62 140 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Sentri logo mark"
      role="img"
    >
      <defs>
        <linearGradient id={gradId} gradientUnits="userSpaceOnUse"
          x1="40" y1="105" x2="160" y2="105">
          <stop offset="0%" stopColor="#4285F4"/>
          <stop offset="25%" stopColor="#EA4335"/>
          <stop offset="50%" stopColor="#FBBC05"/>
          <stop offset="75%" stopColor="#34A853"/>
          <stop offset="100%" stopColor="#4285F4"/>
          <animateTransform attributeName="gradientTransform"
            type="rotate" from="0 100 105" to="360 100 105" dur="2s"
            repeatCount="indefinite"/>
        </linearGradient>
      </defs>

      <rect x="40" y="70" width="120" height="70" rx="35" fill="#020817"/>
      <rect x="40" y="70" width="120" height="70" rx="35"
            fill="none" stroke={`url(#${gradId})`} strokeWidth="6"
            strokeLinecap="round"/>

      {/* Left eye */}
      <g>
        <ellipse cx="80" cy="105" rx="22" ry="18" fill="#0b0f1a"/>
        <g>
          <animateTransform
            attributeName="transform" type="translate"
            values="-4 0; 0 0; 4 0; 0 0; -4 0"
            keyTimes="0;0.25;0.5;0.75;1"
            dur="2.4s" repeatCount="indefinite"/>
          <ellipse cx="80" cy="105" rx="13" ry="11" fill="#dbe9ff"/>
          <circle cx="76" cy="99" r="3" fill="#fff"/>
        </g>
        <rect x="58" y="90" width="44" height="30" fill="#020817">
          <animate attributeName="height"
                   values="0;0;30;0;0"
                   keyTimes="0;0.45;0.5;0.55;1"
                   dur="2.4s" repeatCount="indefinite"/>
        </rect>
      </g>

      {/* Right eye */}
      <g>
        <ellipse cx="120" cy="105" rx="22" ry="18" fill="#0b0f1a"/>
        <g>
          <animateTransform
            attributeName="transform" type="translate"
            values="-4 0; 0 0; 4 0; 0 0; -4 0"
            keyTimes="0;0.25;0.5;0.75;1"
            dur="2.4s" repeatCount="indefinite"/>
          <ellipse cx="120" cy="105" rx="13" ry="11" fill="#dbe9ff"/>
          <circle cx="116" cy="99" r="3" fill="#fff"/>
        </g>
        <rect x="98" y="90" width="44" height="30" fill="#020817">
          <animate attributeName="height"
                   values="0;0;30;0;0"
                   keyTimes="0;0.45;0.5;0.55;1"
                   dur="2.4s" repeatCount="indefinite"/>
        </rect>
      </g>
    </svg>
  );
}

function Wordmark({ height = 20, color }) {
  return (
    <span
      style={{
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontWeight: 700,
        fontSize: height,
        lineHeight: 1,
        letterSpacing: "-0.04em",
        color: color || "var(--text)",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
      aria-label="Sentri"
    >
      Sentri
    </span>
  );
}

export default function AppLogo({
  size    = 40,
  variant = "full",
  color,
  style   = {},
}) {
  if (variant === "icon") {
    return <IconMark size={size} />;
  }

  if (variant === "wordmark") {
    return <Wordmark height={Math.round(size * 0.5)} color={color} />;
  }

  // "full" — icon + wordmark side by side
  return (
    <div
      style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.25), ...style }}
      role="banner"
      aria-label="Sentri"
    >
      <IconMark size={size} />
      <Wordmark height={Math.round(size * 0.5)} color={color} />
    </div>
  );
}

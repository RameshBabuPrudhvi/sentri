/**
 * AppLogo.jsx
 *
 * SVG logo for Sentri — gradient shield icon + wordmark.
 * The shield always uses the brand gradient so it's visible on any background.
 * The wordmark uses var(--text) by default so it adapts to light/dark mode
 * automatically, or accepts an explicit `color` override for custom contexts
 * (e.g. the Login page's dark background).
 *
 * Props:
 *   size     — controls height of the icon (default 40)
 *   variant  — "icon" | "wordmark" | "full" (default "full")
 *   color    — explicit wordmark color; omit to use var(--text)
 *   style    — additional inline styles for the wrapper
 */

import React, { useId } from "react";

function IconMark({ size = 40 }) {
  const uid = useId();
  const shieldGradId = `sentri-shield-${uid}`;
  const rayGradId = `sentri-ray-${uid}`;
  const glowId = `sentri-glow-${uid}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Sentri logo mark"
      role="img"
    >
      <defs>
        <linearGradient id={shieldGradId} x1="5" y1="3" x2="35" y2="37" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id={rayGradId} x1="12" y1="15" x2="28" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#e0e7ff" />
        </linearGradient>
        <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Shield body — brand gradient, always visible */}
      <path
        d="M20 3L5 9v10c0 8.5 6.5 16 15 18 8.5-2 15-9.5 15-18V9L20 3z"
        fill={`url(#${shieldGradId})`}
      />

      {/* White checkmark */}
      <path
        d="M12 20.5l5.5 5.5 10.5-11"
        stroke={`url(#${rayGradId})`}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${glowId})`}
      />
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

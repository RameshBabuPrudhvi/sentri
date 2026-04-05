/**
 * AppLogo.jsx
 *
 * SVG logo for Sentri — shield icon + wordmark.
 *
 * Props:
 *   size     — controls height of the icon variant (default 40)
 *   variant  — "icon" | "wordmark" | "full" (default "full")
 *   theme    — "dark" | "light" (default "dark")
 *   style    — additional inline styles for the wrapper
 */

import React, { useId } from "react";

const BRAND = {
  dark: {
    shield:       "#1e2235",
    shieldBorder: "#3d4466",
    wordmark:     "#f1f5f9",
  },
  light: {
    shield:       "#f0f2ff",
    shieldBorder: "#c7cdf5",
    wordmark:     "#0f172a",
  },
};

function IconMark({ size = 40, theme = "dark" }) {
  const c = BRAND[theme];
  const uid = useId();
  const gradId = `sentri-ray-${uid}`;
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
        <linearGradient id={gradId} x1="8" y1="10" x2="32" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Shield body */}
      <path
        d="M20 3L5 9v10c0 8.5 6.5 16 15 18 8.5-2 15-9.5 15-18V9L20 3z"
        fill={c.shield}
        stroke={c.shieldBorder}
        strokeWidth="1.2"
      />

      {/* Gradient checkmark */}
      <path
        d="M12 20.5l5.5 5.5 10.5-11"
        stroke={`url(#${gradId})`}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${glowId})`}
      />

      {/* Subtle inner highlight */}
      <path
        d="M20 5.5L7 11v8.5"
        stroke="rgba(255,255,255,0.07)"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Wordmark({ height = 20, theme = "dark" }) {
  const c = BRAND[theme];
  return (
    <span
      style={{
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        fontWeight: 700,
        fontSize: height,
        lineHeight: 1,
        letterSpacing: "-0.04em",
        color: c.wordmark,
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
  theme   = "dark",
  style   = {},
}) {
  if (variant === "icon") {
    return <IconMark size={size} theme={theme} />;
  }

  if (variant === "wordmark") {
    return <Wordmark height={Math.round(size * 0.5)} theme={theme} />;
  }

  // "full" — icon + wordmark side by side
  return (
    <div
      style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.25), ...style }}
      role="banner"
      aria-label="Sentri"
    >
      <IconMark size={size} theme={theme} />
      <Wordmark height={Math.round(size * 0.5)} theme={theme} />
    </div>
  );
}

/**
 * SentriLogo.jsx
 *
 * SVG wordmark + icon for Sentri.
 * The mark is a geometric shield containing a stylised checkmark ray —
 * communicating security, precision, and forward motion.
 *
 * Props:
 *   size     — controls height of the icon variant (default 40)
 *   variant  — "icon" | "wordmark" | "full" (default "full")
 *   theme    — "dark" | "light" (default "dark")
 */

import React from "react";

const BRAND = {
  dark: {
    shield:    "#1e2235",
    shieldBorder: "#3d4466",
    ray:       "url(#sentri-ray-dark)",
    wordmark:  "#f1f5f9",
    tagline:   "#64748b",
  },
  light: {
    shield:    "#f0f2ff",
    shieldBorder: "#c7cdf5",
    ray:       "url(#sentri-ray-light)",
    wordmark:  "#0f172a",
    tagline:   "#64748b",
  },
};

function IconMark({ size = 40, theme = "dark" }) {
  const c = BRAND[theme];
  const id = `sentri-ray-${theme}`;
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
        <linearGradient id={id} x1="8" y1="10" x2="32" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#818cf8" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <filter id="sentri-glow" x="-20%" y="-20%" width="140%" height="140%">
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

      {/* Gradient ray / check arrow */}
      <path
        d="M12 20.5l5.5 5.5 10.5-11"
        stroke={c.ray}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#sentri-glow)"
      />

      {/* Subtle top-left inner highlight */}
      <path
        d="M20 5.5L7 11v8.5"
        stroke="rgba(255,255,255,0.07)"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Wordmark({ height = 28, theme = "dark" }) {
  const c = BRAND[theme];
  // Geometric wordmark built from SVG paths — no external font dependency
  // Letters drawn on a 7×14 grid per glyph, 3px tracking
  return (
    <svg
      height={height}
      viewBox="0 0 142 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Sentri"
      role="img"
    >
      {/* S */}
      <path d="M2 5.5C2 3.6 3.6 2 5.5 2H11c2 0 3 1.2 3 2.5s-1 2.2-2.5 2.5l-4 1C5.8 8.5 2 9.8 2 13c0 2.8 2.2 5 5 5h5.5c2 0 3.5-1.5 3.5-3" stroke={c.wordmark} strokeWidth="1.8" strokeLinecap="round" />

      {/* E */}
      <path d="M20 2h9M20 10h7M20 18h9M20 2v16" stroke={c.wordmark} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />

      {/* N */}
      <path d="M35 18V2l10 16V2" stroke={c.wordmark} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />

      {/* T */}
      <path d="M52 2h11M57.5 2v16" stroke={c.wordmark} strokeWidth="1.8" strokeLinecap="round" />

      {/* R */}
      <path d="M70 18V2h6c2.8 0 4.5 1.5 4.5 4s-1.7 4-4.5 4H70M76 10l5 8" stroke={c.wordmark} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />

      {/* I — with a dot */}
      <path d="M88 18V6" stroke={c.wordmark} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="88" cy="2.5" r="1.3" fill={c.wordmark} />

      {/* Accent line under wordmark */}
      <linearGradient id="wm-accent" x1="0" y1="0" x2="95" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0%"    stopColor="#6366f1" stopOpacity="0.9" />
        <stop offset="100%"  stopColor="#a855f7" stopOpacity="0" />
      </linearGradient>
    </svg>
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
    return <Wordmark height={size * 0.6} theme={theme} />;
  }

  // "full" — icon + wordmark side by side
  return (
    <div
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.28, ...style }}
      role="banner"
      aria-label="Sentri"
    >
      <IconMark size={size} theme={theme} />
      <Wordmark height={size * 0.55} theme={theme} />
    </div>
  );
}

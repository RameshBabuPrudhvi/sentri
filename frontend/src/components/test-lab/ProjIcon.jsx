/**
 * @module components/test-lab/ProjIcon
 * @description Compact project avatar with deterministic colour derived from
 *   the first letter of the project name. Used by the Test Lab project
 *   sidebar, the queue row, and the right-rail active-runs list.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 *   decomposition (audit §3.1).
 *
 * STANDARDS.md:383 carve-out: inline styles must reference CSS variables.
 * `avatarHueStyle` returns a single `--avatar-h` custom property; the
 * actual `background` + `color` declarations live in
 * `frontend/src/styles/pages/test-lab.css` (`.tl-proj-icon`) and consume
 * the hue via `hsl(var(--avatar-h), …)`. This keeps the runtime-numeric
 * value (the hue) inline while moving the styling layer back into CSS.
 *
 * `avatarHueStyle` is exported so other surfaces — e.g. the launch panel's
 * "Active runs" rendering — can drive their own non-avatar UI from the
 * same deterministic palette without re-importing the icon component.
 */
import React from "react";

/**
 * Deterministic hue (0–360) keyed on the uppercase initial. 26 distinct
 * hues spread across the wheel; unknown / non-letter initials fall back to
 * a neutral blue so the avatar never renders as transparent.
 *
 * @param {string} initial — single character (case-insensitive)
 * @returns {{ "--avatar-h": number }}
 */
export function avatarHueStyle(initial) {
  const hues = {
    A: 210, B: 280, C: 340, D: 170, E: 50, F: 120, G: 15,
    H: 255, I: 190, J: 320, K: 90, L: 200, M: 30, N: 160,
    O: 60, P: 295, Q: 135, R: 0, S: 240, T: 75, U: 215,
    V: 145, W: 350, X: 180, Y: 45, Z: 270,
  };
  const h = hues[(initial || "?").toUpperCase()] ?? 200;
  return { "--avatar-h": h };
}

/**
 * @param {{ project: { name?: string } | null | undefined }} props
 */
export default function ProjIcon({ project }) {
  const initial = (project?.name || "?")[0].toUpperCase();
  return (
    <div className="tl-proj-icon" style={avatarHueStyle(initial)}>
      {initial}
    </div>
  );
}

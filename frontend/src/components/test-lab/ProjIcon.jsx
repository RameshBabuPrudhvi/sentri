/**
 * @module components/test-lab/ProjIcon
 * @description Compact project avatar with deterministic colour derived from
 *   the first letter of the project name. Used by the Test Lab project
 *   sidebar, the queue row, and the right-rail active-runs list.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 *   decomposition (audit §3.1). The colour-mapping helper (`avatarStyle`)
 *   ships alongside as a named export so other surfaces — e.g. the launch
 *   panel's "Active runs" rendering — can drive their own non-avatar UI
 *   from the same deterministic palette without re-importing the icon
 *   component.
 */
import React from "react";

/**
 * Deterministic HSL pair keyed on the uppercase initial. 26 distinct hues
 * spread across the wheel; unknown / non-letter initials fall back to a
 * neutral blue so the avatar never renders as transparent.
 *
 * @param {string} initial — single character (case-insensitive)
 * @returns {{ background: string, color: string }}
 */
export function avatarStyle(initial) {
  const hues = {
    A: 210, B: 280, C: 340, D: 170, E: 50, F: 120, G: 15,
    H: 255, I: 190, J: 320, K: 90, L: 200, M: 30, N: 160,
    O: 60, P: 295, Q: 135, R: 0, S: 240, T: 75, U: 215,
    V: 145, W: 350, X: 180, Y: 45, Z: 270,
  };
  const h = hues[(initial || "?").toUpperCase()] ?? 200;
  return {
    background: `hsl(${h},60%,90%)`,
    color: `hsl(${h},60%,30%)`,
  };
}

/**
 * @param {{ project: { name?: string } | null | undefined }} props
 */
export default function ProjIcon({ project }) {
  const initial = (project?.name || "?")[0].toUpperCase();
  return (
    <div className="tl-proj-icon" style={avatarStyle(initial)}>
      {initial}
    </div>
  );
}

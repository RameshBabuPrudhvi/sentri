import React from "react";

/**
 * Horizontal stacked bar — renders proportional colour segments.
 *
 * Props:
 *   segments — [{ label, count, color }]
 *   height   — bar height in px (default 8)
 *
 * Returns null when total count is zero.
 */
export default function StackedBar({ segments, height = 8 }) {
  const total = (segments || []).reduce((s, seg) => s + (seg.count || 0), 0);
  if (!total) return null;
  return (
    <div style={{ display: "flex", height, borderRadius: height / 2, overflow: "hidden", marginTop: 12, background: "var(--bg3)" }}>
      {segments.map((seg) =>
        seg.count > 0
          ? <div key={seg.label} style={{ width: `${(seg.count / total) * 100}%`, background: seg.color }} />
          : null
      )}
    </div>
  );
}

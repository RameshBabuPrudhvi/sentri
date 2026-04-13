import React from "react";
import { passRateColor } from "../../utils/formatters";

/**
 * Horizontal pass-rate bar with percentage label.
 * Used in Applications and Reports.
 *
 * Props:
 *   rate  — 0-100 or null (shows "No runs")
 *   width — track width CSS (default: auto / flex)
 */
export default function PassRateBar({ rate, width }) {
  if (rate == null) return <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>No runs</span>;
  const color = passRateColor(rate);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--bg3)", overflow: "hidden", minWidth: width || 60 }}>
        <div style={{ width: `${rate}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: "0.75rem", fontWeight: 600, color, minWidth: 28 }}>{rate}%</span>
    </div>
  );
}

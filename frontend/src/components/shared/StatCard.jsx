import React from "react";

/**
 * Reusable stat card — label, large value, optional subtitle and icon.
 * Used in Dashboard, Reports, and Work.
 */
export default function StatCard({ label, value, sub, color = "var(--accent)", icon }) {
  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: "0.72rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
        {icon && <span style={{ color, opacity: 0.7 }}>{icon}</span>}
      </div>
      <div className="stat-card-value" style={{ fontSize: "1.9rem", fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

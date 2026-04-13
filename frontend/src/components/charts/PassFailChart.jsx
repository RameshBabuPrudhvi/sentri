import React from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>{p.name}: {p.value}</div>
      ))}
    </div>
  );
};

/**
 * Reusable pass/fail area chart.
 *
 * Props:
 *   data     — [{ name, passed, failed }]
 *   height   — chart height in px (default 150)
 *   idPrefix — unique SVG gradient ID prefix to avoid collisions (default "pf")
 *   title    — optional header text
 *   subtitle — optional subtitle text
 *   legend   — show passed/failed legend (default true)
 */
export default function PassFailChart({
  data,
  height = 150,
  idPrefix = "pf",
  title,
  subtitle,
  legend = true,
}) {
  if (!data || data.length < 2) return null;
  const gpId = `${idPrefix}Gp`;
  const gfId = `${idPrefix}Gf`;

  return (
    <div className="card" style={{ padding: 24, marginBottom: 16 }}>
      {(title || legend) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <div>
            {title && <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>{title}</div>}
            {subtitle && <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 2 }}>{subtitle}</div>}
          </div>
          {legend && (
            <div style={{ display: "flex", gap: 14, fontSize: "0.75rem" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green)", display: "inline-block" }} />
                Passed
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--red)", display: "inline-block" }} />
                Failed
              </span>
            </div>
          )}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={gpId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#16a34a" stopOpacity={0.18} />
              <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={gfId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#dc2626" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--text3)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: "var(--text3)" }} axisLine={false} tickLine={false} />
          <Tooltip content={<ChartTooltip />} />
          <Area type="monotone" dataKey="passed" name="Passed" stroke="#16a34a" fill={`url(#${gpId})`} strokeWidth={2} />
          <Area type="monotone" dataKey="failed" name="Failed" stroke="#dc2626" fill={`url(#${gfId})`} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

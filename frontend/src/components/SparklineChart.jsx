import React from "react";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";

/**
 * Minimal sparkline area chart — single metric over time.
 *
 * Props:
 *   data      — [{ name, value }]
 *   height    — chart height in px (default 48)
 *   color     — stroke/fill colour (default "var(--accent)")
 *   dataKey   — key in data objects to plot (default "value")
 *   tooltipFn — optional (entry) => string for custom tooltip labels
 *
 * Returns null when data has fewer than 2 points.
 */
export default function SparklineChart({
  data,
  height = 48,
  color = "var(--accent)",
  dataKey = "value",
  tooltipFn,
}) {
  if (!data || data.length < 2) return null;
  const id = `sp-${Math.random().toString(36).slice(2, 6)}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.2} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {tooltipFn && (
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              return (
                <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", fontSize: 11 }}>
                  {tooltipFn(payload[0].payload)}
                </div>
              );
            }}
          />
        )}
        <Area type="monotone" dataKey={dataKey} stroke={color} fill={`url(#${id})`} strokeWidth={1.5} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

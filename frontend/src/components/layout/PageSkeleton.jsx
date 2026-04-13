/**
 * PageSkeleton — lightweight shimmer placeholder shown by React Suspense
 * while a lazily-loaded page chunk is being fetched.
 *
 * Uses only CSS variables from tokens.css so it works in both light and dark
 * themes without any additional state.
 */

import React from "react";

// Single shimmer bar
function ShimmerBar({ width = "100%", height = 14, radius = 6, style = {} }) {
  return (
    <div
      className="shimmer"
      style={{
        width,
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

export default function PageSkeleton() {
  return (
    <div
      className="fade-in"
      style={{ padding: "32px 24px", maxWidth: 900, margin: "0 auto" }}
      aria-busy="true"
      aria-label="Loading page"
    >
      {/* Page title skeleton */}
      <ShimmerBar width="35%" height={28} radius={8} style={{ marginBottom: 10 }} />
      <ShimmerBar width="55%" height={14} style={{ marginBottom: 32 }} />

      {/* Tab bar skeleton */}
      <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
        {[80, 90, 60, 72].map((w, i) => (
          <ShimmerBar key={i} width={w} height={32} radius={8} />
        ))}
      </div>

      {/* Card rows */}
      {[1, 2, 3].map(i => (
        <div
          key={i}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            padding: "18px 20px",
            marginBottom: 12,
          }}
        >
          <ShimmerBar width="40%" height={15} style={{ marginBottom: 8 }} />
          <ShimmerBar width="70%" height={12} />
        </div>
      ))}
    </div>
  );
}

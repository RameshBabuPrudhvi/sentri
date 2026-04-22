import React from "react";

/**
 * Shared outcome banner — colored strip with title, subtitle, and action buttons.
 *
 * Used by GenerationSuccessBanner (generate/crawl success) and TestRunView (post-run footer).
 *
 * Props:
 *   variant   — "success" | "warning" | "error" (controls background / border color)
 *   title     — bold heading text
 *   subtitle  — secondary description text
 *   style     — extra inline styles merged onto the outer div
 *   children  — action buttons rendered on the right
 */
const VARIANTS = {
  success: { bg: "var(--green-bg)", border: "#86efac", color: "var(--green)" },
  warning: { bg: "var(--amber-bg)", border: "#fcd34d", color: "#92400e" },
  error:   { bg: "var(--red-bg)",   border: "#fca5a5", color: "var(--red)" },
};

export default function OutcomeBanner({ variant = "success", title, subtitle, style, children }) {
  const v = VARIANTS[variant] || VARIANTS.success;

  // WAI-ARIA: role="alert" implies aria-live="assertive" — use it for
  // error/warning (urgent).  role="status" implies aria-live="polite" —
  // use it for success (non-urgent).  Never combine role="alert" with
  // aria-live="polite" as they contradict each other.
  const isUrgent = variant === "error" || variant === "warning";

  return (
    <div
      role={isUrgent ? "alert" : "status"}
      aria-live={isUrgent ? "assertive" : "polite"}
      style={{
        padding: "16px 18px", background: v.bg,
        border: `1px solid ${v.border}`, borderRadius: "var(--radius)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, flexWrap: "wrap",
        ...style,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: "0.9rem", color: v.color, marginBottom: 3 }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: "0.78rem", color: "var(--text2)", lineHeight: 1.5 }}>
            {subtitle}
          </div>
        )}
      </div>
      {children && (
        <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          {children}
        </div>
      )}
    </div>
  );
}

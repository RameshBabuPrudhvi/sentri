import React, { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * Generic collapsible section / accordion.
 *
 * Props:
 *   icon         — React node shown before the label
 *   label        — section title
 *   subtitle     — optional italic hint shown after the label
 *   defaultOpen  — whether the section starts expanded (default: false)
 *   children     — content rendered when open
 *
 * Usage:
 *   <Collapsible icon={<Target size={15} />} label="Strategy" subtitle="Happy">
 *     …content…
 *   </Collapsible>
 */
export default function Collapsible({ icon, label, subtitle, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderRadius: "var(--radius)", border: "1px solid var(--border)", overflow: "hidden", background: "var(--surface)" }}>
      <button
        className="section-header"
        onClick={() => setOpen(o => !o)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--text3)", display: "flex" }}>{icon}</span>
          <span style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text)" }}>{label}</span>
          {subtitle && (
            <span style={{ fontSize: "0.72rem", color: "var(--text3)", fontStyle: "italic" }}>({subtitle})</span>
          )}
        </div>
        <span style={{ color: "var(--text3)", display: "flex", flexShrink: 0 }}>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {children}
        </div>
      )}
    </div>
  );
}

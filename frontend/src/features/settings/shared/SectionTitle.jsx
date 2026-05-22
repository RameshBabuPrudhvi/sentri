import React from "react";

/**
 * Settings section header — icon + title + optional subtitle. Used at the
 * top of every settings section to anchor scroll position and provide
 * consistent visual rhythm. Styling lives in `pages/settings.css` under
 * `.st-section-title`. Extracted from Settings.jsx (GAP-002).
 */
export default function SectionTitle({ icon, title, sub }) {
  return (
    <div className="st-section-title">
      <div className="st-section-icon">{icon}</div>
      <div>
        <div className="font-bold st-section-title__heading">{title}</div>
        {sub && <div className="text-xs text-muted st-section-title__sub">{sub}</div>}
      </div>
    </div>
  );
}

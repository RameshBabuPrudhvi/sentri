/**
 * CrawlDialsPanel.jsx
 *
 * Collapsible "Test Dials" configuration panel for the
 * "Crawl & Generate Tests" flow in ProjectDetail.
 *
 * Usage:
 *   <CrawlDialsPanel onChange={(cfg) => setCrawlDialsConfig(cfg)} />
 *
 * Then pass the config to buildTestDialsPrompt() and include it in the
 * crawl request body so the backend can embed it in the AI prompt.
 */

import React, { useState } from "react";
import { Settings2, ChevronDown, ChevronUp } from "lucide-react";
import TestDials, { buildTestDialsPrompt } from "./TestDials.jsx";

export { buildTestDialsPrompt };

export default function CrawlDialsPanel({ onChange }) {
  const [open, setOpen] = useState(false);
  const [activeCount, setActiveCount] = useState(4);

  function handleChange(cfg) {
    let n = 0;
    if (cfg?.strategy) n++;
    if (cfg?.workflow?.length) n++;
    if (cfg?.quality?.length) n++;
    if (cfg?.format) n++;
    setActiveCount(n);
    onChange?.(cfg);
  }

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: "var(--radius)",
      background: "var(--surface)", overflow: "hidden",
    }}>
      {/* Collapse toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "11px 14px", background: "none", border: "none",
          cursor: "pointer", textAlign: "left",
        }}
      >
        <Settings2 size={14} color="var(--text3)" />
        <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--text)", flex: 1 }}>
          Test Dials
        </span>
        <span style={{
          display: "inline-flex", alignItems: "center",
          background: "var(--accent-bg)", color: "var(--accent)",
          padding: "1px 8px", borderRadius: 99, fontSize: "0.7rem", fontWeight: 700, marginRight: 6,
        }}>
          {activeCount} active
        </span>
        <span style={{ color: "var(--text3)", display: "flex" }}>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: 16 }}>
          <TestDials onChange={handleChange} />
        </div>
      )}
    </div>
  );
}

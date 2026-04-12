/**
 * CrawlDialsPanel.jsx
 *
 * Collapsible "Test Dials" configuration panel for the
 * "Crawl & Generate Tests" flow in ProjectDetail.
 *
 * Usage:
 *   <CrawlDialsPanel onChange={(cfg) => setCrawlDialsCfg(cfg)} />
 *
 * Then pass the raw config object as `dialsConfig` in the crawl request
 * body — the backend validates it and builds the prompt server-side
 * (see backend/src/testDials.js).
 */

import React, { useState } from "react";
import { Settings2, ChevronDown, ChevronUp } from "lucide-react";
import TestDials from "../shared/TestDials.jsx";
import { countActiveDials, loadSavedConfig } from "../../utils/testDialsStorage.js";

export default function CrawlDialsPanel({ value, onChange }) {
  // Controlled mode: parent owns the config via value/onChange.
  // Uncontrolled fallback: if no value prop, use internal state from localStorage.
  const isControlled = value !== undefined;
  const [internalCfg, setInternalCfg] = useState(() => loadSavedConfig());
  const [open, setOpen] = useState(false);

  const cfg = isControlled ? value : internalCfg;
  const activeCount = countActiveDials(cfg);

  function handleChange(nextCfg) {
    if (isControlled) {
      onChange?.(nextCfg);
    } else {
      setInternalCfg(nextCfg);
      onChange?.(nextCfg);
    }
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
        <span className="active-count-pill" style={{ marginRight: 6 }}>
          {activeCount} active
        </span>
        <span style={{ color: "var(--text3)", display: "flex" }}>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: 16 }}>
          <TestDials value={cfg} onChange={handleChange} />
        </div>
      )}
    </div>
  );
}

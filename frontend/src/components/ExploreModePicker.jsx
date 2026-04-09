import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  EXPLORE_MODE_OPTIONS,
  EXPLORER_INTENSITY_PRESETS,
  EXPLORER_TUNING,
} from "../config/testDialsConfig.js";

/**
 * Shared explore-mode picker used by CrawlProjectModal and GenerateTestModal.
 *
 * Renders:
 *   1. Discovery mode toggle (Link crawl vs State exploration)
 *   2. Intensity presets (Quick / Balanced / Deep) — only when state mode
 *   3. Collapsible custom tuning sliders — only when state mode + expanded
 *
 * Props:
 *   value    — the dialsConfig object (needs exploreMode + tuning fields)
 *   onChange — called with updater function: onChange(prev => ({ ...prev, ... }))
 */
export default function ExploreModePicker({ value, onChange }) {
  const [showCustom, setShowCustom] = useState(false);

  const mode = value?.exploreMode || "crawl";

  // Detect which intensity preset matches the current tuning values
  const activePreset = EXPLORER_INTENSITY_PRESETS.find(p =>
    Object.entries(p.values).every(([k, v]) => (value?.[k] ?? v) === v)
  )?.id || "custom";

  function selectPreset(preset) {
    setShowCustom(false);
    onChange(prev => ({ ...prev, ...preset.values }));
  }

  return (
    <div>
      {/* Discovery mode toggle */}
      <label style={{ display: "block", marginBottom: 8, fontSize: "0.82rem", fontWeight: 500, color: "var(--text2)" }}>
        Discovery Mode
      </label>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {EXPLORE_MODE_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => onChange(prev => ({ ...prev, exploreMode: opt.id }))}
            style={{
              flex: 1, padding: "10px 12px", borderRadius: "var(--radius)",
              border: `1.5px solid ${mode === opt.id ? "var(--accent)" : "var(--border)"}`,
              background: mode === opt.id ? "var(--accent-bg)" : "var(--bg2)",
              color: mode === opt.id ? "var(--accent)" : "var(--text2)",
              cursor: "pointer", fontSize: "0.82rem", fontWeight: 500,
              transition: "all 0.15s", textAlign: "left",
            }}
          >
            {opt.id === "crawl" ? "🔗" : "⚡"} {opt.label}
            <div style={{ fontSize: "0.7rem", color: "var(--text3)", marginTop: 3, fontWeight: 400 }}>
              {opt.desc}
            </div>
          </button>
        ))}
      </div>

      {/* Intensity presets — only for state exploration */}
      {mode === "state" && (
        <div style={{
          padding: 14, background: "var(--bg2)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", marginBottom: 16,
        }}>
          <div style={{ fontSize: "0.72rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>
            Explorer Intensity
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {EXPLORER_INTENSITY_PRESETS.map(p => {
              const active = activePreset === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => selectPreset(p)}
                  style={{
                    flex: 1, padding: "8px 6px", borderRadius: "var(--radius)",
                    border: `1.5px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "var(--accent-bg)" : "var(--surface)",
                    color: active ? "var(--accent)" : "var(--text2)",
                    cursor: "pointer", textAlign: "center",
                    transition: "all 0.15s",
                  }}
                >
                  <div style={{ fontSize: "1rem", marginBottom: 2 }}>{p.icon}</div>
                  <div style={{ fontSize: "0.78rem", fontWeight: 600 }}>{p.label}</div>
                  <div style={{ fontSize: "0.65rem", color: "var(--text3)", marginTop: 1 }}>{p.desc}</div>
                </button>
              );
            })}
          </div>

          {/* Custom tuning toggle */}
          <button
            onClick={() => setShowCustom(v => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 5, marginTop: 10,
              background: "none", border: "none", cursor: "pointer",
              fontSize: "0.72rem", color: "var(--text3)", padding: 0,
              fontFamily: "var(--font-sans)",
            }}
          >
            <ChevronDown size={11} style={{ transform: showCustom ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
            Custom tuning
            {activePreset === "custom" && (
              <span style={{
                fontSize: "0.6rem", background: "var(--accent-bg)", color: "var(--accent)",
                padding: "1px 5px", borderRadius: 4, fontWeight: 600,
              }}>
                modified
              </span>
            )}
          </button>

          {/* Expanded sliders */}
          {showCustom && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              {EXPLORER_TUNING.map(t => (
                <div key={t.id}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                    <span style={{ fontSize: "0.78rem", color: "var(--text)", fontWeight: 500 }}>
                      {t.label}
                    </span>
                    <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 600 }}>
                      {value?.[t.id] ?? t.defaultVal}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={t.min}
                    max={t.max}
                    step={t.step}
                    value={value?.[t.id] ?? t.defaultVal}
                    onChange={e => onChange(prev => ({ ...prev, [t.id]: parseInt(e.target.value, 10) }))}
                    style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer" }}
                  />
                  <div style={{ fontSize: "0.65rem", color: "var(--text3)", marginTop: 1 }}>
                    {t.desc}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

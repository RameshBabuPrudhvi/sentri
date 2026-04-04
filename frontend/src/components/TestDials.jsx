import React, { useState, useRef, useEffect } from "react";
import {
  Settings2, ChevronDown, Plus, X, Save, RotateCcw,
  Target, Users, ShieldCheck, FileText, Globe, Cpu, Info,
  Zap, BookOpen, GitBranch, Bug, Lock, BarChart3, Layers, Hash,
} from "lucide-react";
import {
  STRATEGY_OPTIONS, WORKFLOW_OPTIONS, QUALITY_OPTIONS,
  FORMAT_OPTIONS, LANGUAGES, DEFAULT_CONFIG, TEST_COUNT_OPTIONS,
} from "../config/testDialsConfig.js";
import {
  loadSavedConfig, saveConfig,
  countActiveDials,
} from "../utils/testDialsStorage.js";
import Collapsible from "./Collapsible.jsx";
import Tooltip from "./Tooltip.jsx";

// Re-export so consumers can import { countActiveDials } from "./TestDials.jsx"
export { countActiveDials };

// ─── Test Profiles (contain JSX icons, so they live here) ──────────────────────

const TEST_PROFILES = [
  {
    id: "smoke",
    label: "Smoke Test",
    icon: <Zap size={13} color="#f59e0b" />,
    description: "Quick sanity checks. Happy paths only.",
    strategy: "happy_path",
    workflow: ["e2e"],
    quality: [],
    format: "concise",
  },
  {
    id: "new_feature",
    label: "New Feature Full Suite",
    icon: <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)" }} />,
    description: "Comprehensive coverage for new functionality.",
    strategy: "comprehensive",
    workflow: ["e2e", "multi_role"],
    quality: ["data_integrity"],
    format: "verbose",
    default: true,
  },
  {
    id: "bdd",
    label: "BDD Automation Blueprint",
    icon: <div style={{ width: 11, height: 11, borderRadius: 2, background: "#16a34a", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ width: 6, height: 6, borderRadius: 1, background: "#fff" }} /></div>,
    description: "Gherkin-style specs ready for automation.",
    strategy: "comprehensive",
    workflow: ["e2e", "multi_role"],
    quality: [],
    format: "gherkin",
  },
  {
    id: "hardening",
    label: "Edge Case Hardening",
    icon: <div style={{ width: 11, height: 11, borderRadius: "50%", border: "1.5px solid #dc2626" }} />,
    description: "Edge cases, error handling, boundaries.",
    strategy: "edge_cases",
    workflow: ["interruptions"],
    quality: ["security", "reliability"],
    format: "verbose",
  },
  {
    id: "a11y",
    label: "Accessibility Audit",
    icon: <Users size={13} color="#7c3aed" />,
    description: "WCAG 2.1 compliance and keyboard navigation.",
    strategy: "comprehensive",
    workflow: ["first_time_user"],
    quality: ["accessibility"],
    format: "verbose",
  },
  {
    id: "api",
    label: "API & Backend Focus",
    icon: <Settings2 size={13} color="#6b7280" />,
    description: "Integration points, data validation, API contracts.",
    strategy: "comprehensive",
    workflow: ["multi_role"],
    quality: ["api_integration", "data_integrity"],
    format: "concise",
  },
  {
    id: "bugfix",
    label: "Regression Guard",
    icon: <Bug size={13} color="#dc2626" />,
    description: "Regression checks around a specific fix.",
    strategy: "regression",
    workflow: ["e2e"],
    quality: ["reliability"],
    format: "concise",
  },
];

// Alias Collapsible as Section to keep JSX below unchanged
const Section = Collapsible;

// ─── Preset dropdown ──────────────────────────────────────────────────────────

function PresetDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  const selected = TEST_PROFILES.find(p => p.id === value) || TEST_PROFILES[1];

  useEffect(() => {
    function close(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    if (open) document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "9px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius)",
          background: "var(--bg2)", cursor: "pointer", gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ display: "flex", alignItems: "center", width: 16, justifyContent: "center" }}>{selected.icon}</span>
          <span style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text)" }}>{selected.label}</span>
        </div>
        <ChevronDown size={14} color="var(--text3)" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 200,
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
          boxShadow: "var(--shadow)", overflow: "hidden",
        }}>
          {TEST_PROFILES.map(pack => (
            <button
              key={pack.id}
              onClick={() => { onChange(pack); setOpen(false); }}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 14px",
                background: pack.id === value ? "var(--accent-bg)" : "none",
                border: "none", cursor: "pointer", textAlign: "left",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", width: 16, justifyContent: "center", flexShrink: 0 }}>
                {pack.id === value
                  ? <div style={{ width: 10, height: 10, borderRadius: "50%", border: "2.5px solid var(--accent)", background: "var(--accent)" }} />
                  : pack.icon
                }
              </span>
              <span style={{ fontSize: "0.85rem", color: pack.id === value ? "var(--accent)" : "var(--text)", fontWeight: pack.id === value ? 500 : 400 }}>
                {pack.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main TestDials component ─────────────────────────────────────────────────

export default function TestDials({ onChange }) {
  const [cfg, setCfg] = useState(loadSavedConfig);
  const [saved, setSaved] = useState(false);

  // Notify parent of config changes
  useEffect(() => {
    onChange?.(cfg);
  }, [cfg]);

  function update(patch) {
    setCfg(prev => ({ ...prev, ...patch }));
  }

  function applyPreset(pack) {
    const next = {
      ...cfg,
      preset: pack.id,
      strategy: pack.strategy,
      workflow: pack.workflow,
      quality: pack.quality,
      format: pack.format,
    };
    setCfg(next);
  }

  function toggleWorkflow(id) {
    update({
      workflow: cfg.workflow.includes(id) ? cfg.workflow.filter(w => w !== id) : [...cfg.workflow, id],
      preset: "",
    });
  }

  function toggleQuality(id) {
    update({
      quality: cfg.quality.includes(id) ? cfg.quality.filter(q => q !== id) : [...cfg.quality, id],
      preset: "",
    });
  }

  function handleSave() {
    saveConfig(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  function handleClearAll() {
    const fresh = { ...DEFAULT_CONFIG };
    setCfg(fresh);
  }

  const activeCount = countActiveDials(cfg);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Header row ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text)" }}>Test Dials</span>
          <span className="active-count-pill">
            {activeCount} active
          </span>
        </div>
        <Tooltip text="Test Dials control how the AI generates your test cases — strategy, coverage depth, format, and more.">
          <Info size={15} color="var(--text3)" style={{ cursor: "help" }} />
        </Tooltip>
      </div>

      {/* ── Test Profiles ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Layers size={14} color="var(--text3)" />
            <span className="dial-label">Test Profiles</span>
          </div>
          <button
            onClick={() => {}}
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "3px 9px",
              border: "1px solid var(--border)", borderRadius: "var(--radius)",
              background: "var(--bg2)", cursor: "pointer", fontSize: "0.78rem", color: "var(--text2)",
            }}
          >
            <Plus size={12} /> Save current
          </button>
        </div>
        <PresetDropdown value={cfg.preset} onChange={applyPreset} />
      </div>

      {/* ── Test Strategy & Scope ── */}
      <Section
        icon={<Target size={15} />}
        label="Test Strategy & Scope"
        subtitle={STRATEGY_OPTIONS.find(s => s.id === cfg.strategy)?.label.split(" ").slice(0, 1)[0] || "Comprehensive"}
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> Choose the testing approach: happy path, error cases, edge cases, or comprehensive coverage
        </div>
        {STRATEGY_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "2px 0" }}>
            <input
              type="radio"
              name="strategy"
              value={opt.id}
              checked={cfg.strategy === opt.id}
              onChange={() => update({ strategy: opt.id, preset: "" })}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)", fontWeight: cfg.strategy === opt.id ? 500 : 400 }}>{opt.label}</div>
            </div>
          </label>
        ))}
      </Section>

      {/* ── Test Count ── */}
      <Section
        icon={<Hash size={15} />}
        label="Test Count"
        subtitle={TEST_COUNT_OPTIONS.find(o => o.id === cfg.testCount)?.label || "Auto"}
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> Choose how many test cases to generate: a single focused test or a full suite
        </div>
        {TEST_COUNT_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "2px 0" }}>
            <input
              type="radio"
              name="testCount"
              value={opt.id}
              checked={cfg.testCount === opt.id}
              onChange={() => update({ testCount: opt.id, preset: "" })}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)", fontWeight: cfg.testCount === opt.id ? 500 : 400 }}>{opt.label}</div>
              <div style={{ fontSize: "0.72rem", color: "var(--text3)" }}>{opt.desc}</div>
            </div>
          </label>
        ))}
      </Section>

      {/* ── Workflow & User Perspective ── */}
      <Section
        icon={<Users size={15} />}
        label="Workflow & User Perspective"
        subtitle={cfg.workflow.length > 0 ? WORKFLOW_OPTIONS.filter(w => cfg.workflow.includes(w.id)).map(w => w.label.split(" ")[0]).slice(0, 2).join(", ") : "None"}
        defaultOpen={false}
      >
        {WORKFLOW_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "2px 0" }}>
            <input
              type="checkbox"
              checked={cfg.workflow.includes(opt.id)}
              onChange={() => toggleWorkflow(opt.id)}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer", width: 14, height: 14 }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)", fontWeight: cfg.workflow.includes(opt.id) ? 500 : 400 }}>{opt.label}</div>
            </div>
          </label>
        ))}
      </Section>

      {/* ── Specific Quality Checks ── */}
      <Section
        icon={<ShieldCheck size={15} />}
        label="Specific Quality Checks"
        subtitle={cfg.quality.length > 0 ? cfg.quality.slice(0, 2).join(", ") : undefined}
        defaultOpen={false}
      >
        {QUALITY_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "2px 0" }}>
            <input
              type="checkbox"
              checked={cfg.quality.includes(opt.id)}
              onChange={() => toggleQuality(opt.id)}
              style={{ accentColor: "var(--accent)", cursor: "pointer", width: 14, height: 14 }}
            />
            <span style={{ fontSize: "0.85rem", color: "var(--text)", fontWeight: cfg.quality.includes(opt.id) ? 500 : 400 }}>
              {opt.label}
            </span>
          </label>
        ))}
      </Section>

      {/* ── Output Format & Style ── */}
      <Section
        icon={<FileText size={15} />}
        label="Output Format & Style"
        subtitle={FORMAT_OPTIONS.find(f => f.id === cfg.format)?.label.split(" ").slice(0, 1)[0] || "Verbose"}
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> Choose how test steps are formatted: verbose, concise, or Gherkin
        </div>
        {FORMAT_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "2px 0" }}>
            <input
              type="radio"
              name="format"
              value={opt.id}
              checked={cfg.format === opt.id}
              onChange={() => update({ format: opt.id, preset: "" })}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)", fontWeight: cfg.format === opt.id ? 500 : 400 }}>{opt.label}</div>
            </div>
          </label>
        ))}
      </Section>

      {/* ── Language + Automation Hooks ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* Output Language */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <Globe size={14} color="var(--text3)" />
            <span className="dial-label">Output Language</span>
          </div>
          <div style={{ position: "relative" }}>
            <select
              value={cfg.language}
              onChange={e => update({ language: e.target.value })}
              style={{
                width: "100%", padding: "8px 10px", border: "1px solid var(--border)",
                borderRadius: "var(--radius)", background: "var(--bg2)",
                color: "var(--text)", fontSize: "0.85rem", cursor: "pointer",
                appearance: "none",
              }}
            >
              {LANGUAGES.map(l => (
                <option key={l.code} value={l.code}>{l.flag} {l.label}</option>
              ))}
            </select>
            <ChevronDown size={12} color="var(--text3)" style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
          </div>
        </div>

        {/* Automation Hooks */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <Cpu size={14} color="var(--text3)" />
            <span className="dial-label">Automation Hooks</span>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", paddingTop: 10 }}>
            <input
              type="checkbox"
              checked={cfg.automationHooks}
              onChange={e => update({ automationHooks: e.target.checked })}
              style={{ accentColor: "var(--accent)", width: 14, height: 14, cursor: "pointer" }}
            />
            <span style={{ fontSize: "0.82rem", color: "var(--text2)", lineHeight: 1.4 }}>
              Include automation element ID hooks
            </span>
          </label>
        </div>
      </div>

      {/* ── Custom Modifier ── */}
      <div>
        <div className="dial-label" style={{ marginBottom: 8 }}>
          Custom Modifier
        </div>
        <textarea
          className="dial-textarea"
          value={cfg.customModifier}
          onChange={e => {
            if (e.target.value.length <= 500) update({ customModifier: e.target.value });
          }}
          placeholder="Add any additional context or specific requirements (max 500 characters)..."
          rows={3}
        />
        <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 4 }}>
          {cfg.customModifier.length}/500 characters
        </div>
      </div>

      {/* ── Footer actions ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
        <button
          onClick={handleSave}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 14px",
            border: "1px solid var(--border)", borderRadius: "var(--radius)",
            background: saved ? "var(--green-bg)" : "var(--bg2)",
            color: saved ? "var(--green)" : "var(--text2)",
            cursor: "pointer", fontSize: "0.82rem", fontWeight: 500,
            transition: "all 0.2s",
          }}
        >
          <Save size={13} /> {saved ? "Saved!" : "Save Config"}
        </button>
        <button
          onClick={handleClearAll}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 14px",
            border: "none", background: "none",
            color: "var(--text3)", cursor: "pointer", fontSize: "0.82rem",
          }}
        >
          <RotateCcw size={13} /> Clear All
        </button>
      </div>
    </div>
  );
}



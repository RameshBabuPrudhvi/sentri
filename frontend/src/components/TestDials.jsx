import React, { useState, useEffect } from "react";
import {
  Settings2, ChevronDown, Save, RotateCcw,
  Target, Users, ShieldCheck, FileText, Globe, Info,
  Hash, SlidersHorizontal, Compass,
} from "lucide-react";
import {
  APPROACH_OPTIONS,
  PERSPECTIVE_OPTIONS,
  QUALITY_OPTIONS,
  FORMAT_OPTIONS,
  LANGUAGES,
  TEST_COUNT_OPTIONS,
  EXPLORE_MODE_OPTIONS,
  EXPLORER_TUNING,
  OPTION_TOGGLES,
  PROFILE_OPTIONS,
  DEFAULT_CONFIG,
} from "../config/testDialsConfig.js";
import {
  loadSavedConfig,
  saveConfig,
  countActiveDials,
} from "../utils/testDialsStorage.js";
import Collapsible from "./Collapsible.jsx";
import Tooltip from "./Tooltip.jsx";

// Re-export so consumers can do: import { countActiveDials } from "./TestDials.jsx"
export { countActiveDials };

const Section = Collapsible;

// ─── Profile dropdown ──────────────────────────────────────────────────────────

function ProfileDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = PROFILE_OPTIONS.find(p => p.id === value) || PROFILE_OPTIONS.find(p => p.default);

  useEffect(() => {
    if (!open) return;
    function close(e) {
      if (!e.target.closest("[data-profile-dropdown]")) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div data-profile-dropdown style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center",
          justifyContent: "space-between", padding: "9px 12px",
          border: "1px solid var(--border)", borderRadius: "var(--radius)",
          background: "var(--bg2)", cursor: "pointer", gap: 8,
        }}
      >
        <span style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text)" }}>
          {selected?.label ?? "Custom"}
        </span>
        <ChevronDown size={14} color="var(--text3)"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 200,
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", boxShadow: "var(--shadow)", overflow: "hidden",
        }}>
          {PROFILE_OPTIONS.map(p => (
            <button
              key={p.id}
              onClick={() => { onChange(p); setOpen(false); }}
              style={{
                width: "100%", display: "flex", flexDirection: "column",
                alignItems: "flex-start", gap: 2, padding: "10px 14px",
                background: p.id === value ? "var(--accent-bg)" : "none",
                border: "none", cursor: "pointer", textAlign: "left",
              }}
            >
              <span style={{
                fontSize: "0.85rem", fontWeight: 500,
                color: p.id === value ? "var(--accent)" : "var(--text)",
              }}>
                {p.label}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>
                {p.desc}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main TestDials component ──────────────────────────────────────────────────

export default function TestDials({ onChange }) {
  const [cfg, setCfg] = useState(loadSavedConfig);
  const [saved, setSaved] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps — onChange identity is stable
  useEffect(() => { onChange?.(cfg); }, [cfg, onChange]);

  function update(patch) {
    setCfg(prev => ({ ...prev, ...patch }));
  }

  function applyProfile(profile) {
    setCfg(prev => ({
      ...prev,
      profile:            profile.id,
      approach:           profile.approach,
      perspectives:       [...profile.perspectives],
      quality:            [...profile.quality],
      format:             profile.format,
      testCount:          profile.testCount,
      exploreMode:          profile.exploreMode || "crawl",
      exploreMaxStates:     DEFAULT_CONFIG.exploreMaxStates,
      exploreMaxDepth:      DEFAULT_CONFIG.exploreMaxDepth,
      exploreMaxActions:    DEFAULT_CONFIG.exploreMaxActions,
      exploreActionTimeout: DEFAULT_CONFIG.exploreActionTimeout,
      options:            { ...DEFAULT_CONFIG.options },
      customInstructions: "",
    }));
  }

  function togglePerspective(id) {
    const next = cfg.perspectives.includes(id)
      ? cfg.perspectives.filter(p => p !== id)
      : [...cfg.perspectives, id];
    update({ perspectives: next, profile: "" });
  }

  function toggleQuality(id) {
    const next = cfg.quality.includes(id)
      ? cfg.quality.filter(q => q !== id)
      : [...cfg.quality, id];
    update({ quality: next, profile: "" });
  }

  function toggleOption(id) {
    update({
      options: { ...cfg.options, [id]: !cfg.options?.[id] },
      profile: "",
    });
  }

  function handleSave() {
    saveConfig(cfg);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  function handleReset() {
    setCfg({ ...DEFAULT_CONFIG });
  }

  const activeCount = countActiveDials(cfg);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text)" }}>Test Dials</span>
          <span className="active-count-pill">{activeCount} active</span>
        </div>
        <Tooltip text="Test Dials control how the AI generates your test cases — coverage approach, perspectives, quality checks, format, and more.">
          <Info size={15} color="var(--text3)" style={{ cursor: "help" }} />
        </Tooltip>
      </div>

      {/* ① Quick profile */}
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: "var(--radius)", padding: 14,
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SlidersHorizontal size={14} color="var(--text3)" />
          <span className="dial-label">Quick profile</span>
          <Tooltip text="Pick a starting point — it pre-fills the dials below. You can still adjust anything.">
            <Info size={12} color="var(--text3)" style={{ cursor: "help" }} />
          </Tooltip>
        </div>
        <ProfileDropdown value={cfg.profile} onChange={applyProfile} />
      </div>

      {/* ② Explore mode */}
      <Section
        icon={<Compass size={15} />}
        label="Explore mode"
        subtitle={EXPLORE_MODE_OPTIONS.find(o => o.id === cfg.exploreMode)?.label || "Link crawl"}
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 6,
          display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> How should Sentri discover your app before generating tests?
        </div>
        {EXPLORE_MODE_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start",
            gap: 10, cursor: "pointer", padding: "3px 0" }}>
            <input
              type="radio"
              name="exploreMode"
              value={opt.id}
              checked={cfg.exploreMode === opt.id}
              onChange={() => update({ exploreMode: opt.id, profile: "" })}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)",
                fontWeight: cfg.exploreMode === opt.id ? 500 : 400 }}>
                {opt.label}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 1 }}>
                {opt.desc}
              </div>
            </div>
          </label>
        ))}

        {/* Tuning sliders — only shown when state exploration is selected */}
        {cfg.exploreMode === "state" && (
          <div style={{
            marginTop: 10, paddingTop: 10,
            borderTop: "1px solid var(--border)",
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{ fontSize: "0.72rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Explorer tuning
            </div>
            {EXPLORER_TUNING.map(t => (
              <div key={t.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <label style={{ fontSize: "0.8rem", color: "var(--text)", fontWeight: 500 }}>
                    {t.label}
                  </label>
                  <span style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 600 }}>
                    {cfg[t.id] ?? t.defaultVal}
                  </span>
                </div>
                <input
                  type="range"
                  min={t.min}
                  max={t.max}
                  step={t.step}
                  value={cfg[t.id] ?? t.defaultVal}
                  onChange={e => update({ [t.id]: parseInt(e.target.value, 10), profile: "" })}
                  style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <div style={{ fontSize: "0.68rem", color: "var(--text3)", marginTop: 1 }}>
                  {t.desc}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ③ Coverage approach */}
      <Section
        icon={<Target size={15} />}
        label="Coverage approach"
        subtitle={APPROACH_OPTIONS.find(a => a.id === cfg.approach)?.label.split(" ")[0] || "Full"}
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 6,
          display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> What mix of scenarios should the AI focus on?
        </div>
        {APPROACH_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start",
            gap: 10, cursor: "pointer", padding: "3px 0" }}>
            <input
              type="radio"
              name="approach"
              value={opt.id}
              checked={cfg.approach === opt.id}
              onChange={() => update({ approach: opt.id, profile: "" })}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)",
                fontWeight: cfg.approach === opt.id ? 500 : 400 }}>
                {opt.label}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 1 }}>
                {opt.desc}
              </div>
            </div>
          </label>
        ))}
      </Section>

      {/* ③ Number of tests */}
      <Section
        icon={<Hash size={15} />}
        label="Number of tests"
        subtitle={TEST_COUNT_OPTIONS.find(o => o.id === cfg.testCount)?.label || "AI decides"}
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 6,
          display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> How many test cases should be generated?
        </div>
        {TEST_COUNT_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start",
            gap: 10, cursor: "pointer", padding: "3px 0" }}>
            <input
              type="radio"
              name="testCount"
              value={opt.id}
              checked={cfg.testCount === opt.id}
              onChange={() => update({ testCount: opt.id, profile: "" })}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)",
                fontWeight: cfg.testCount === opt.id ? 500 : 400 }}>
                {opt.label}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 1 }}>
                {opt.desc}
              </div>
            </div>
          </label>
        ))}
      </Section>

      {/* ④ Test perspective */}
      <Section
        icon={<Users size={15} />}
        label="Test perspective"
        subtitle={
          cfg.perspectives.length > 0
            ? PERSPECTIVE_OPTIONS
                .filter(p => cfg.perspectives.includes(p.id))
                .map(p => p.label.split(" ")[0])
                .slice(0, 2)
                .join(", ")
            : "None"
        }
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 6,
          display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> From which angle should each test be written? Pick all that apply.
        </div>
        {PERSPECTIVE_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start",
            gap: 10, cursor: "pointer", padding: "3px 0" }}>
            <input
              type="checkbox"
              checked={cfg.perspectives.includes(opt.id)}
              onChange={() => togglePerspective(opt.id)}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer",
                width: 14, height: 14 }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)",
                fontWeight: cfg.perspectives.includes(opt.id) ? 500 : 400 }}>
                {opt.label}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 1 }}>
                {opt.desc}
              </div>
            </div>
          </label>
        ))}
      </Section>

      {/* ⑤ Quality checks */}
      <Section
        icon={<ShieldCheck size={15} />}
        label="Quality checks"
        subtitle={
          cfg.quality.length > 0
            ? QUALITY_OPTIONS.filter(q => cfg.quality.includes(q.id))
                .map(q => q.label).slice(0, 2).join(", ")
            : "None"
        }
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 6,
          display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> Extra assertion types added on top of your coverage approach.
        </div>
        {QUALITY_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "center",
            gap: 10, cursor: "pointer", padding: "3px 0" }}>
            <input
              type="checkbox"
              checked={cfg.quality.includes(opt.id)}
              onChange={() => toggleQuality(opt.id)}
              style={{ accentColor: "var(--accent)", cursor: "pointer", width: 14, height: 14 }}
            />
            <span style={{ fontSize: "0.85rem", color: "var(--text)",
              fontWeight: cfg.quality.includes(opt.id) ? 500 : 400 }}>
              {opt.label}
            </span>
          </label>
        ))}
      </Section>

      {/* ⑥ Output format */}
      <Section
        icon={<FileText size={15} />}
        label="Output format"
        subtitle={FORMAT_OPTIONS.find(f => f.id === cfg.format)?.label.split(" ")[0] || "Step"}
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 6,
          display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> How should each test case be written?
        </div>
        {FORMAT_OPTIONS.map(opt => (
          <label key={opt.id} style={{ display: "flex", alignItems: "flex-start",
            gap: 10, cursor: "pointer", padding: "3px 0" }}>
            <input
              type="radio"
              name="format"
              value={opt.id}
              checked={cfg.format === opt.id}
              onChange={() => update({ format: opt.id, profile: "" })}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)",
                fontWeight: cfg.format === opt.id ? 500 : 400 }}>
                {opt.label}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 1 }}>
                {opt.desc}
              </div>
            </div>
          </label>
        ))}
      </Section>

      {/* ⑦ Extra options */}
      <Section
        icon={<Settings2 size={15} />}
        label="Extra options"
        subtitle={
          Object.values(cfg.options || {}).filter(Boolean).length > 0
            ? `${Object.values(cfg.options).filter(Boolean).length} on`
            : "None"
        }
        defaultOpen={false}
      >
        <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginBottom: 6,
          display: "flex", alignItems: "center", gap: 6 }}>
          <Info size={11} /> Additional output tweaks — each adds detail to the generated tests.
        </div>
        {OPTION_TOGGLES.map(t => (
          <label key={t.id} style={{ display: "flex", alignItems: "flex-start",
            gap: 10, cursor: "pointer", padding: "3px 0" }}>
            <input
              type="checkbox"
              checked={cfg.options?.[t.id] ?? false}
              onChange={() => toggleOption(t.id)}
              style={{ marginTop: 3, accentColor: "var(--accent)", cursor: "pointer",
                width: 14, height: 14 }}
            />
            <div>
              <div style={{ fontSize: "0.85rem", color: "var(--text)",
                fontWeight: cfg.options?.[t.id] ? 500 : 400 }}>
                {t.label}
              </div>
              <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 1 }}>
                {t.desc}
              </div>
            </div>
          </label>
        ))}
      </Section>

      {/* ⑧ Output language */}
      <div style={{
        borderRadius: "var(--radius)", border: "1px solid var(--border)",
        background: "var(--surface)", padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <Globe size={15} color="var(--text3)" style={{ flexShrink: 0 }} />
        <span style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text)", flexShrink: 0 }}>
          Language
        </span>
        <div style={{ position: "relative", flex: 1 }}>
          <select
            value={cfg.language}
            onChange={e => update({ language: e.target.value })}
            style={{
              width: "100%", padding: "7px 28px 7px 10px",
              border: "1px solid var(--border)", borderRadius: "var(--radius)",
              background: "var(--bg2)", color: "var(--text)",
              fontSize: "0.85rem", cursor: "pointer", appearance: "none",
            }}
          >
            {LANGUAGES.map(l => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          <ChevronDown size={12} color="var(--text3)" style={{
            position: "absolute", right: 10, top: "50%",
            transform: "translateY(-50%)", pointerEvents: "none",
          }} />
        </div>
      </div>

      {/* ⑨ Custom instructions */}
      <div>
        <div className="dial-label" style={{ marginBottom: 8 }}>Custom instructions</div>
        <textarea
          className="dial-textarea"
          value={cfg.customInstructions}
          onChange={e => {
            if (e.target.value.length <= 500)
              update({ customInstructions: e.target.value });
          }}
          placeholder="Tell the AI anything else — specific flows to include, things to avoid, domain context... (max 500 chars)"
          rows={3}
        />
        <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 4 }}>
          {(cfg.customInstructions || "").length} / 500 characters
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        paddingTop: 4 }}>
        <button
          onClick={handleSave}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 14px", border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            background: saved ? "var(--green-bg)" : "var(--bg2)",
            color: saved ? "var(--green)" : "var(--text2)",
            cursor: "pointer", fontSize: "0.82rem", fontWeight: 500,
            transition: "all 0.2s",
          }}
        >
          <Save size={13} /> {saved ? "Saved!" : "Save as default"}
        </button>
        <button
          onClick={handleReset}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 14px", border: "none", background: "none",
            color: "var(--text3)", cursor: "pointer", fontSize: "0.82rem",
          }}
        >
          <RotateCcw size={13} /> Reset
        </button>
      </div>

    </div>
  );
}

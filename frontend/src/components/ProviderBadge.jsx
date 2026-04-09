import React, { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Brain, ChevronDown, AlertTriangle, Check, RefreshCw, Settings } from "lucide-react";
import { api } from "../api.js";

// ── Simple module-level cache (no in-flight dedup to avoid stale-closure bugs) ─
let _configCache   = null;
let _settingsCache = null;

export function invalidateConfigCache() {
  _configCache   = null;
  _settingsCache = null;
}

// ── Provider display metadata ─────────────────────────────────────────────────
const PROVIDER_META = {
  anthropic: { label: "Claude Sonnet",    sublabel: "claude-sonnet-4-20250514", bg: "#fef3e2", border: "#fcd8a8", color: "#b45309", dot: "#d97706", activeBg: "rgba(180,83,9,0.08)" },
  openai:    { label: "GPT-4o-mini",      sublabel: "gpt-4o-mini",              bg: "#dcfce7", border: "#bbf7d0", color: "#15803d", dot: "#16a34a", activeBg: "rgba(21,128,61,0.08)" },
  google:    { label: "Gemini 2.5 Flash", sublabel: "gemini-2.5-flash",         bg: "#dbeafe", border: "#bfdbfe", color: "#1d4ed8", dot: "#2563eb", activeBg: "rgba(29,78,216,0.08)" },
  local:     { label: "Ollama",           sublabel: "local model",              bg: "#f5f3ff", border: "#ddd6fe", color: "#6d28d9", dot: "#7c3aed", activeBg: "rgba(109,40,217,0.08)" },
};

const ALL_IDS = ["anthropic", "openai", "google", "local"];

// A provider is "saved" if getSettings() returns a non-empty masked key for it,
// or (for Ollama) if ollamaBaseUrl is set or it was the active provider.
function getSavedProviders(settings) {
  if (!settings) return [];
  const list = [];
  if (settings.anthropic) list.push("anthropic");
  if (settings.openai)    list.push("openai");
  if (settings.google)    list.push("google");
  if (settings.ollamaBaseUrl || settings.activeProvider === "local") list.push("local");
  return list;
}

export default function ProviderBadge({ style }) {
  const [config,   setConfig]   = useState(_configCache);
  const [settings, setSettings] = useState(_settingsCache);
  const [open,     setOpen]     = useState(false);
  const [switching, setSwitching] = useState(null); // provider id currently being switched to
  const [error,    setError]    = useState(null);
  const navigate = useNavigate();
  const ref = useRef(null);

  // Load on mount — always re-fetch if cache is empty
  const load = useCallback(async () => {
    if (_configCache && _settingsCache) {
      setConfig(_configCache);
      setSettings(_settingsCache);
      return;
    }
    try {
      const [cfg, sett] = await Promise.all([api.getConfig(), api.getSettings()]);
      _configCache   = cfg;
      _settingsCache = sett;
      setConfig(cfg);
      setSettings(sett);
    } catch { /* silent — badge degrades gracefully */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setError(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // ── Switch provider ────────────────────────────────────────────────────────
  const switchProvider = useCallback(async (providerId) => {
    if (providerId === config?.provider) { setOpen(false); return; }

    setSwitching(providerId);
    setError(null);

    try {
      if (providerId === "local") {
        await api.saveApiKey("local", null, {
          baseUrl: settings?.ollamaBaseUrl || "http://localhost:11434",
          model:   settings?.ollamaModel   || "mistral:7b",
        });
      } else {
        await api.saveApiKey(providerId, "__use_existing__");
      }

      // Force re-fetch — clear cache first so fetchAll() can't return stale data
      invalidateConfigCache();
      const [freshCfg, freshSett] = await Promise.all([api.getConfig(), api.getSettings()]);
      _configCache   = freshCfg;
      _settingsCache = freshSett;
      setConfig(freshCfg);
      setSettings(freshSett);
      setOpen(false);

    } catch (err) {
      setError(err?.message?.includes("No saved key")
        ? "No saved key — add it in Settings first."
        : "Switch failed. Try Settings to re-enter the key.");
    } finally {
      setSwitching(null);
    }
  }, [config, settings]);

  // ── Render: loading ────────────────────────────────────────────────────────
  if (!config) {
    return <div className="skeleton" style={{ width: 130, height: 26, borderRadius: 6, ...style }} />;
  }

  // ── Render: no provider ────────────────────────────────────────────────────
  if (!config.hasProvider) {
    return (
      <button onClick={() => navigate("/settings")} className="btn btn-ghost btn-sm"
        style={{ gap: 5, color: "var(--red)", borderColor: "#fca5a5", background: "var(--red-bg)", ...style }}>
        <AlertTriangle size={12} />
        <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>Configure AI</span>
      </button>
    );
  }

  const c      = PROVIDER_META[config.provider] || PROVIDER_META.openai;
  const saved  = getSavedProviders(settings);
  const unsaved = ALL_IDS.filter(id => !saved.includes(id));

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0, ...style }}>

      {/* ── Badge trigger ── */}
      <button
        onClick={() => { setOpen(v => !v); setError(null); }}
        title="Switch AI provider"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "4px 10px", borderRadius: 7,
          background: c.bg,
          border: `1px solid ${open ? c.color : c.border}`,
          cursor: "pointer", transition: "border-color 0.15s, box-shadow 0.15s",
          boxShadow: open ? `0 0 0 3px ${c.bg}` : "none",
        }}
      >
        {switching
          ? <RefreshCw size={12} color={c.color} className="spin" />
          : <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
        }
        <Brain size={12} color={c.color} />
        <span style={{ fontSize: "0.73rem", fontWeight: 600, color: c.color, whiteSpace: "nowrap" }}>
          {config.providerName}
        </span>
        <ChevronDown size={10} color={c.color}
          style={{ opacity: 0.7, transition: "transform 0.18s", transform: open ? "rotate(180deg)" : "none" }} />
      </button>

      {/* ── Dropdown ── */}
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 200,
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,0.13)",
          minWidth: 236, overflow: "hidden",
        }}>

          {/* Header */}
          <div style={{ padding: "9px 12px 8px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              AI Provider
            </span>
            <button
              onClick={() => { setOpen(false); navigate("/settings"); }}
              style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", fontSize: "0.7rem", color: "var(--text3)", padding: "2px 5px", borderRadius: 4, transition: "all 0.1s" }}
              onMouseEnter={e => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg2)"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "var(--text3)"; e.currentTarget.style.background = "none"; }}
            >
              <Settings size={10} /> Manage keys
            </button>
          </div>

          {/* Saved providers — one-click switch */}
          {saved.length > 0 && (
            <div style={{ padding: "4px 0" }}>
              {saved.map(id => {
                const meta     = PROVIDER_META[id];
                const isActive = config.provider === id;
                const isBusy   = switching === id;
                return (
                  <button key={id} onClick={() => switchProvider(id)}
                    disabled={!!switching}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      width: "100%", padding: "8px 13px",
                      background: isActive ? meta.activeBg : "none",
                      border: "none",
                      cursor: switching ? (isBusy ? "wait" : "default") : "pointer",
                      textAlign: "left", transition: "background 0.1s",
                      opacity: (switching && !isBusy) ? 0.45 : 1,
                    }}
                    onMouseEnter={e => { if (!isActive && !switching) e.currentTarget.style.background = "var(--bg2)"; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "none"; }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.dot, flexShrink: 0, opacity: isActive ? 1 : 0.45 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "0.82rem", fontWeight: isActive ? 600 : 400, color: isActive ? meta.color : "var(--text)", lineHeight: 1.3 }}>
                        {meta.label}
                      </div>
                      <div style={{ fontSize: "0.68rem", color: "var(--text3)", marginTop: 1 }}>
                        {id === "local" ? (settings?.ollamaModel || meta.sublabel) : meta.sublabel}
                      </div>
                    </div>
                    {isBusy
                      ? <RefreshCw size={12} color={meta.color} className="spin" style={{ flexShrink: 0 }} />
                      : isActive
                      ? <Check size={12} color={meta.color} style={{ flexShrink: 0 }} />
                      : <span style={{ fontSize: "0.68rem", color: "var(--text3)", flexShrink: 0 }}>Switch</span>
                    }
                  </button>
                );
              })}
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div style={{ padding: "7px 12px", fontSize: "0.72rem", color: "var(--red)", borderTop: "1px solid var(--border)", background: "var(--red-bg)", lineHeight: 1.5 }}>
              {error}
            </div>
          )}

          {/* Unsaved providers — link to settings to add key */}
          {unsaved.length > 0 && (
            <>
              <div style={{ borderTop: "1px solid var(--border)", padding: "7px 13px 3px", fontSize: "0.67rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                Add provider
              </div>
              {unsaved.map(id => {
                const meta = PROVIDER_META[id];
                return (
                  <button key={id} onClick={() => { setOpen(false); navigate("/settings"); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "7px 13px", background: "none", border: "none", cursor: "pointer", textAlign: "left", transition: "background 0.1s" }}
                    onMouseEnter={e => { e.currentTarget.style.background = "var(--bg2)"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "none"; }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.dot, flexShrink: 0, opacity: 0.25 }} />
                    <span style={{ fontSize: "0.81rem", color: "var(--text3)", flex: 1 }}>{meta.label}</span>
                    <span style={{ fontSize: "0.67rem", color: "var(--text3)", opacity: 0.6 }}>+ Add key →</span>
                  </button>
                );
              })}
            </>
          )}
          <div style={{ height: 4 }} />
        </div>
      )}
    </div>
  );
}
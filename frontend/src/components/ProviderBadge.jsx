import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Brain, ChevronDown, AlertTriangle } from "lucide-react";
import { api } from "../api.js";

let _cache = null;
let _listeners = [];
let _fetching = false;

export function invalidateConfigCache() {
  _cache = null;
}

async function fetchConfig() {
  if (_cache) return _cache;
  if (_fetching) return new Promise(r => _listeners.push(r));
  _fetching = true;
  try {
    const d = await api.getConfig();
    _cache = d;
    _listeners.forEach(r => r(d));
    _listeners = [];
    return d;
  } finally { _fetching = false; }
}

const COLORS = {
  anthropic: { bg: "#fef3e2", border: "#fcd8a8", color: "#b45309", dot: "#d97706" },
  openai:    { bg: "#dcfce7", border: "#bbf7d0", color: "#15803d", dot: "#16a34a" },
  google:    { bg: "#dbeafe", border: "#bfdbfe", color: "#1d4ed8", dot: "#2563eb" },
  local:     { bg: "#f5f3ff", border: "#ddd6fe", color: "#6d28d9", dot: "#7c3aed" },
};

export default function ProviderBadge({ style }) {
  const [config, setConfig] = useState(_cache);
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    fetchConfig().then(d => { if (alive) setConfig(d); });
    return () => { alive = false; };
  }, []);

  if (!config) return <div className="skeleton" style={{ width: 120, height: 26, borderRadius: 6, ...style }} />;

  if (!config.hasProvider) {
    return (
      <button onClick={() => navigate("/settings")} className="btn btn-ghost btn-sm" style={{ gap: 5, color: "var(--red)", borderColor: "#fca5a5", background: "var(--red-bg)", ...style }}>
        <AlertTriangle size={12} />
        <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>Configure AI</span>
      </button>
    );
  }

  const c = COLORS[config.provider] || COLORS.openai;
  return (
    <button onClick={() => navigate("/settings")} title={`${config.providerName} · Click to change`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 7, background: c.bg, border: `1px solid ${c.border}`, cursor: "pointer", transition: "all 0.12s", ...style }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
      <Brain size={12} color={c.color} />
      <span style={{ fontSize: "0.73rem", fontWeight: 600, color: c.color, whiteSpace: "nowrap" }}>{config.providerName}</span>
      <ChevronDown size={10} color={c.color} style={{ opacity: 0.7 }} />
    </button>
  );
}

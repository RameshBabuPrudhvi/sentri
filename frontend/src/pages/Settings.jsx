import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Check, Eye, EyeOff, ExternalLink, AlertTriangle,
  RefreshCw, Trash2, Zap, Database, Server, Clock, Cpu,
  Activity, Shield, HardDrive, MemoryStick, Info,
} from "lucide-react";
import { api } from "../api.js";
import { invalidateConfigCache } from "../components/ProviderBadge.jsx";

const PROVIDERS = [
  {
    id: "anthropic",
    name: "Claude Sonnet",
    company: "Anthropic",
    model: "claude-sonnet-4-20250514",
    placeholder: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    color: "#e8965a",
    borderColor: "rgba(205,127,50,0.3)",
    bg: "rgba(205,127,50,0.06)",
    description: "Best quality. Pay-as-you-go from $5 minimum deposit.",
    badge: "Recommended",
    badgeColor: "var(--accent)",
  },
  {
    id: "openai",
    name: "GPT-4o-mini",
    company: "OpenAI",
    model: "gpt-4o-mini",
    placeholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    color: "#3ecfaf",
    borderColor: "rgba(16,163,127,0.3)",
    bg: "rgba(16,163,127,0.06)",
    description: "Fast and affordable. Great for high-volume crawls.",
    badge: "Fast",
    badgeColor: "var(--green)",
  },
  {
    id: "google",
    name: "Gemini 2.5 Flash",
    company: "Google",
    model: "gemini-2.5-flash",
    placeholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    color: "#6ba4f8",
    borderColor: "rgba(66,133,244,0.3)",
    bg: "rgba(66,133,244,0.06)",
    description: "Free tier available (20 req/day limit). Good for testing.",
    badge: "Free tier",
    badgeColor: "var(--purple)",
    warning: "Free tier is limited to 20 requests/day — hits rate limits quickly on large crawls.",
  },
];

function ProviderCard({ provider, activeProvider, maskedKey, onSave, onDelete }) {
  const [input, setInput] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // "saved" | "error" | null
  const [error, setError] = useState("");

  const isActive = activeProvider === provider.id;
  const hasKey = !!maskedKey;

  async function handleSave() {
    if (!input.trim()) return;
    setSaving(true);
    setStatus(null);
    setError("");
    try {
      await onSave(provider.id, input.trim());
      setStatus("saved");
      setInput("");
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus("error");
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Remove ${provider.name} API key?`)) return;
    await onDelete(provider.id);
  }

  return (
    <div style={{
      background: isActive ? provider.bg : "var(--surface)",
      border: `1px solid ${isActive ? provider.borderColor : "var(--border)"}`,
      borderRadius: "var(--radius-lg)", padding: 24,
      transition: "all 0.2s",
      position: "relative",
    }}>
      {/* Active indicator */}
      {isActive && (
        <div style={{
          position: "absolute", top: 16, right: 16,
          display: "flex", alignItems: "center", gap: 5,
          background: provider.bg, border: `1px solid ${provider.borderColor}`,
          borderRadius: 99, padding: "3px 10px",
        }}>
          <Zap size={11} color={provider.color} />
          <span style={{ fontSize: "0.7rem", fontFamily: "var(--font-display)", fontWeight: 700, color: provider.color }}>Active</span>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 16 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10, flexShrink: 0,
          background: isActive ? provider.bg : "var(--bg3)",
          border: `1px solid ${isActive ? provider.borderColor : "var(--border)"}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 20,
        }}>
          {provider.id === "anthropic" ? "🔶" : provider.id === "openai" ? "🟢" : "🔷"}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1rem" }}>{provider.name}</span>
            <span style={{ fontSize: "0.65rem", fontFamily: "var(--font-display)", fontWeight: 700, color: provider.badgeColor, background: `${provider.badgeColor}18`, padding: "2px 7px", borderRadius: 99 }}>{provider.badge}</span>
          </div>
          <div style={{ fontSize: "0.78rem", color: "var(--text2)" }}>{provider.company} · {provider.model}</div>
        </div>
      </div>

      <div style={{ fontSize: "0.82rem", color: "var(--text2)", marginBottom: 16, lineHeight: 1.6 }}>
        {provider.description}
      </div>

      {/* Rate limit warning for Google */}
      {provider.warning && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 16,
          padding: "10px 12px", borderRadius: "var(--radius)",
          background: "rgba(255,165,2,0.07)", border: "1px solid rgba(255,165,2,0.2)",
        }}>
          <AlertTriangle size={13} color="var(--amber)" style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ fontSize: "0.76rem", color: "var(--amber)", lineHeight: 1.5 }}>{provider.warning}</span>
        </div>
      )}

      {/* Current key status */}
      {hasKey && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", background: "var(--bg3)", borderRadius: "var(--radius)",
          marginBottom: 12, border: "1px solid var(--border)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Check size={13} color="var(--green)" />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--text2)" }}>{maskedKey}</span>
          </div>
          <button className="btn btn-danger btn-sm" onClick={handleDelete} style={{ padding: "3px 8px" }}>
            <Trash2 size={11} />
          </button>
        </div>
      )}

      {/* Key input */}
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <input
            className="input"
            type={show ? "text" : "password"}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSave()}
            placeholder={hasKey ? "Enter new key to replace..." : provider.placeholder}
            style={{ paddingRight: 40 }}
          />
          <button
            onClick={() => setShow(s => !s)}
            style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 0 }}
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={saving || !input.trim()}
          style={{ flexShrink: 0 }}
        >
          {saving ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {/* Feedback */}
      {status === "saved" && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, color: "var(--green)", fontSize: "0.78rem" }}>
          <Check size={12} /> Key saved — provider is now active
        </div>
      )}
      {status === "error" && (
        <div style={{ marginTop: 8, fontSize: "0.78rem", color: "var(--red)" }}>
          {error}
        </div>
      )}

      {/* Docs link */}
      <a
        href={provider.docsUrl}
        target="_blank"
        rel="noreferrer"
        style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 12, fontSize: "0.76rem", color: provider.color }}
      >
        Get {provider.company} API key <ExternalLink size={11} />
      </a>
    </div>
  );
}

function SectionTitle({ icon, title, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, marginTop: 40 }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: "var(--bg3)", border: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.05rem" }}>{title}</div>
        {sub && <div style={{ fontSize: "0.76rem", color: "var(--text3)", marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
}

function DataAction({ icon, label, sub, count, btnLabel, btnColor, onAction }) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing]     = useState(false);
  const [result, setResult]         = useState(null);

  async function handleClick() {
    if (!confirming) { setConfirming(true); return; }
    setClearing(true);
    try {
      const res = await onAction();
      setResult(`Cleared ${res.cleared} item${res.cleared !== 1 ? "s" : ""}`);
      setTimeout(() => setResult(null), 3000);
    } catch (err) {
      setResult(`Error: ${err.message}`);
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "14px 18px", background: "var(--surface)",
      border: "1px solid var(--border)", borderRadius: "var(--radius-lg)",
    }}>
      <div style={{ color: "var(--text3)" }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>
          {label}
          {count != null && <span style={{ fontWeight: 400, color: "var(--text3)", marginLeft: 6, fontSize: "0.78rem" }}>({count})</span>}
        </div>
        <div style={{ fontSize: "0.76rem", color: "var(--text3)", marginTop: 2 }}>{sub}</div>
      </div>
      {result ? (
        <span style={{ fontSize: "0.78rem", color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}>
          <Check size={12} /> {result}
        </span>
      ) : (
        <button
          className={`btn btn-sm ${confirming ? "btn-danger" : "btn-ghost"}`}
          onClick={handleClick}
          disabled={clearing || count === 0}
          style={{ flexShrink: 0 }}
        >
          {clearing ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
          {confirming ? "Confirm?" : btnLabel}
        </button>
      )}
    </div>
  );
}

function fmtUptime(seconds) {
  if (seconds < 60)    return `${seconds}s`;
  if (seconds < 3600)  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export default function Settings() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [config, setConfig] = useState(null);
  const [sysInfo, setSysInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    const [s, c, sys] = await Promise.all([
      api.getSettings(),
      api.getConfig(),
      api.getSystemInfo().catch(() => null),
    ]);
    setSettings(s);
    setConfig(c);
    setSysInfo(sys);
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  async function handleSave(provider, apiKey) {
    await api.saveApiKey(provider, apiKey);
    invalidateConfigCache();
    await reload();
  }

  async function handleDelete(provider) {
    await api.deleteApiKey(provider);
    invalidateConfigCache();
    await reload();
  }

  return (
    <div className="fade-in" style={{ maxWidth: 760, margin: "0 auto" }}>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }} onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>

      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.9rem" }}>Settings</h1>
        <p style={{ color: "var(--text2)", marginTop: 6 }}>Configure your AI provider. Keys are stored in memory — restart the server to clear them.</p>
      </div>

      {/* Active provider banner */}
      {!loading && config && (
        <div style={{
          marginBottom: 28, padding: "14px 20px", borderRadius: "var(--radius-lg)",
          background: config.hasProvider ? "rgba(0,229,255,0.05)" : "rgba(255,71,87,0.05)",
          border: `1px solid ${config.hasProvider ? "rgba(0,229,255,0.15)" : "rgba(255,71,87,0.2)"}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          {config.hasProvider ? (
            <>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--green)", boxShadow: "0 0 8px var(--green)" }} />
              <div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--text)" }}>
                  Active: {config.providerName}
                </div>
                <div style={{ fontSize: "0.76rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>{config.model}</div>
              </div>
            </>
          ) : (
            <>
              <AlertTriangle size={18} color="var(--red)" />
              <div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--red)" }}>No AI provider configured</div>
                <div style={{ fontSize: "0.76rem", color: "var(--text3)" }}>Add an API key below to enable test generation</div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Provider cards */}
      {loading ? (
        <div style={{ display: "grid", gap: 16 }}>
          {[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 200, borderRadius: 16 }} />)}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {PROVIDERS.map(p => (
            <ProviderCard
              key={p.id}
              provider={p}
              activeProvider={settings?.activeProvider}
              maskedKey={settings?.[p.id]}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* .env tip */}
      <div style={{ marginTop: 28, padding: "16px 20px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.85rem", marginBottom: 10 }}>Prefer environment variables?</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text2)", lineHeight: 1.8 }}>
          Add to <span className="mono" style={{ background: "var(--bg3)", padding: "1px 6px", borderRadius: 4 }}>backend/.env</span> for persistence across restarts:
        </div>
        <pre style={{
          marginTop: 10, padding: "12px 16px", background: "#040608",
          border: "1px solid var(--border)", borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "#6ab4a0",
          overflowX: "auto", lineHeight: 2,
        }}>{`ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
GOOGLE_API_KEY=AIza...`}</pre>
      </div>

      {/* ── Test Execution ─────────────────────────────────────────────── */}
      <SectionTitle
        icon={<Cpu size={16} color="var(--accent)" />}
        title="Test Execution"
        sub="Self-healing runtime defaults — applied to every test run"
      />
      <div style={{
        background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", overflow: "hidden",
      }}>
        {[
          { label: "Element Timeout", value: "5 000 ms", desc: "Max wait for each element strategy in the self-healing waterfall" },
          { label: "Retry Count", value: "3", desc: "Number of retries per interaction (safeClick / safeFill)" },
          { label: "Retry Delay", value: "400 ms", desc: "Pause between retries before re-attempting the action" },
          { label: "Browser Mode", value: "Headless", desc: "Chromium runs without a visible window for faster execution" },
          { label: "Viewport", value: "1280 × 720", desc: "Default browser viewport size used during test runs" },
          { label: "Self-Healing", value: "Enabled", desc: "Multi-strategy element finding with adaptive healing history" },
        ].map((item, i, arr) => (
          <div key={item.label} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "13px 20px",
            borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none",
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>{item.label}</div>
              <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 2 }}>{item.desc}</div>
            </div>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: "0.8rem", fontWeight: 600,
              color: item.value === "Enabled" ? "var(--green)" : "var(--text)",
              background: "var(--bg3)", padding: "3px 10px", borderRadius: 6,
            }}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 8, paddingLeft: 2 }}>
        <Info size={11} style={{ verticalAlign: "middle", marginRight: 4 }} />
        These values are compiled into the self-healing runtime. To customise, edit <span style={{ fontFamily: "var(--font-mono)", background: "var(--bg3)", padding: "1px 5px", borderRadius: 3 }}>backend/src/selfHealing.js</span>
      </div>

      {/* ── Data Management ─────────────────────────────────────────────── */}
      <SectionTitle
        icon={<Database size={16} color="var(--amber)" />}
        title="Data Management"
        sub="Clear in-memory data — all data is ephemeral and resets on server restart"
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <DataAction
          icon={<Activity size={16} />}
          label="Run History"
          sub="All crawl and test run records, including logs and results"
          count={sysInfo?.runs}
          btnLabel="Clear Runs"
          onAction={async () => { const r = await api.clearRuns(); await reload(); return r; }}
        />
        <DataAction
          icon={<Clock size={16} />}
          label="Activity Log"
          sub="Timeline of all user and system actions"
          count={sysInfo?.activities}
          btnLabel="Clear Log"
          onAction={async () => { const r = await api.clearActivities(); await reload(); return r; }}
        />
        <DataAction
          icon={<Shield size={16} />}
          label="Self-Healing History"
          sub="Learned selector strategies — clearing forces the waterfall to start fresh"
          count={sysInfo?.healingEntries}
          btnLabel="Clear History"
          onAction={async () => { const r = await api.clearHealing(); await reload(); return r; }}
        />
      </div>

      {/* ── System Info ──────────────────────────────────────────────────── */}
      <SectionTitle
        icon={<Server size={16} color="var(--green)" />}
        title="System"
        sub="Server runtime and resource information"
      />
      {sysInfo ? (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)", overflow: "hidden",
        }}>
          {[
            { label: "Uptime",             value: fmtUptime(sysInfo.uptime),                    icon: <Clock size={13} /> },
            { label: "Node.js",            value: sysInfo.nodeVersion,                           icon: <Server size={13} /> },
            { label: "Playwright",         value: sysInfo.playwrightVersion || "—",              icon: <Cpu size={13} /> },
            { label: "Heap Memory",        value: `${sysInfo.memoryMB} MB`,                     icon: <HardDrive size={13} /> },
            { label: "Projects",           value: sysInfo.projects,                              icon: <Database size={13} /> },
            { label: "Tests",              value: `${sysInfo.tests} (${sysInfo.approvedTests} approved, ${sysInfo.draftTests} draft)`, icon: <Activity size={13} /> },
            { label: "Runs",               value: sysInfo.runs,                                  icon: <RefreshCw size={13} /> },
            { label: "Healing Entries",    value: sysInfo.healingEntries,                        icon: <Shield size={13} /> },
          ].map((item, i, arr) => (
            <div key={item.label} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "11px 20px",
              borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none",
            }}>
              <span style={{ color: "var(--text3)" }}>{item.icon}</span>
              <span style={{ fontSize: "0.82rem", color: "var(--text2)", minWidth: 130 }}>{item.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem", fontWeight: 500, color: "var(--text)" }}>{item.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: "20px 0", color: "var(--text3)", fontSize: "0.85rem" }}>
          Could not load system info.
        </div>
      )}

      {/* Bottom spacer */}
      <div style={{ height: 40 }} />
    </div>
  );
}

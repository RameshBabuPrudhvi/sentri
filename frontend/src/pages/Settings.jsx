import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Check, Eye, EyeOff, ExternalLink, AlertTriangle,
  RefreshCw, Trash2, Zap, Database, Server, Clock, Cpu,
  Activity, Shield, HardDrive, Info, Wifi, WifiOff, Terminal,
  Compass,
} from "lucide-react";
import { api } from "../api.js";
import { invalidateConfigCache } from "../components/ProviderBadge.jsx";
import { resetOnboarding, emitTourEvent } from "../hooks/useOnboarding.js";
import usePageTitle from "../hooks/usePageTitle.js";

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
  {
    id: "local",
    name: "Ollama",
    company: "Local / Self-hosted",
    model: "mistral:7b",            // shown as default; overridden by live config
    placeholder: null,            // no API key
    docsUrl: "https://ollama.ai",
    color: "#7c3aed",
    borderColor: "rgba(124,58,237,0.3)",
    bg: "rgba(124,58,237,0.06)",
    description: "100% free, runs on your machine. No data leaves your network.",
    badge: "Private",
    badgeColor: "var(--purple)",
    isLocal: true,
  },
];

// ── Ollama status panel (shown inside the local provider card) ────────────────
function OllamaStatusPanel({ baseUrl, model, onModelChange, onBaseUrlChange }) {
  const [status, setStatus] = useState(null);   // null | { ok, error?, availableModels? }
  const [checking, setChecking] = useState(false);

  // Refs to avoid re-triggering the status check when model/callback change
  const modelRef = useRef(model);
  const onModelChangeRef = useRef(onModelChange);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { onModelChangeRef.current = onModelChange; }, [onModelChange]);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const s = await api.getOllamaStatus();
      setStatus(s);
      // Sync model state to the exact option value returned by Ollama so the
      // controlled <select> stays in sync. Ollama tags include a suffix like
      // ":latest" that the saved config may omit (e.g. "mistral:7b" vs
      // "mistral:7b:latest"), causing a value mismatch → flicker loop.
      const cur = modelRef.current;
      if (s.availableModels?.length && !s.availableModels.includes(cur)) {
        const match = s.availableModels.find(m => m.split(":")[0] === cur.split(":")[0]);
        if (match) onModelChangeRef.current(match);
      }
    } catch (err) {
      setStatus({ ok: false, error: err.message });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { check(); }, [check]);

  return (
    <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
      <hr className="divider" />

      {/* Connection status */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 10,
        padding: "10px 14px", borderRadius: "var(--radius)",
        background: status == null ? "var(--bg3)"
          : status.ok ? "var(--green-bg)"
          : "var(--red-bg)",
        border: `1px solid ${status == null ? "var(--border)"
          : status.ok ? "#86efac"
          : "#fca5a5"}`,
      }}>
        {checking
          ? <RefreshCw size={14} color="var(--text3)" className="spin shrink-0" style={{ marginTop: 1 }} />
          : status?.ok
          ? <Wifi size={14} color="var(--green)" className="shrink-0" style={{ marginTop: 1 }} />
          : <WifiOff size={14} color="var(--red)" className="shrink-0" style={{ marginTop: 1 }} />}
        <div className="flex-1" style={{ minWidth: 0 }}>
          {status == null || checking
            ? <span className="text-sm text-sub">Checking Ollama…</span>
            : status.ok
            ? <span className="text-sm font-semi" style={{ color: "var(--green)" }}>
                Connected · <span className="text-mono">{status.model}</span>
              </span>
            : <span className="text-xs" style={{ color: "var(--red)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {status.error}
              </span>}
        </div>
        <button className="btn btn-ghost btn-xs shrink-0" onClick={check} disabled={checking}>
          <RefreshCw size={11} className={checking ? "spin" : undefined} /> Check
        </button>
      </div>
      {!status?.ok && status != null && !checking && (
        <div className="hint" style={{ fontStyle: "italic" }}>
          Status reflects the last saved config. Click "Activate Ollama" first if you changed the URL or model above.
        </div>
      )}

      {/* Available models dropdown */}
      {status?.availableModels?.length > 0 && (
        <div>
          <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>
            Active model
          </label>
          <select
            className="input"
            value={model}
            onChange={e => onModelChange(e.target.value)}
            style={{ height: 38, fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}
          >
            {status.availableModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div className="hint">
            Only models you have pulled with <code style={{ background: "var(--bg3)", padding: "1px 5px", borderRadius: 3 }}>ollama pull &lt;model&gt;</code> appear here.
          </div>
        </div>
      )}

      {/* Manual model name input when list is empty or connection failed */}
      {(!status?.availableModels?.length) && (
        <div>
          <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>
            Model name
          </label>
          <input
            className="input"
            value={model}
            onChange={e => onModelChange(e.target.value)}
            placeholder="mistral:7b"
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </div>
      )}

      {/* Ollama base URL */}
      <div>
        <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>
          Ollama base URL
        </label>
        <input
          className="input"
          value={baseUrl}
          onChange={e => onBaseUrlChange(e.target.value)}
          placeholder="http://localhost:11434"
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}
        />
        <div className="hint">
          Change this if Ollama is running on a remote host or a different port.
        </div>
      </div>

      {/* Quick-start instructions */}
      <div className="card-padded-sm" style={{ background: "var(--bg3)" }}>
        <div className="font-semi text-xs" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <Terminal size={13} color="var(--text2)" /> Quick start
        </div>
        <pre className="text-mono text-sub" style={{ margin: 0, fontSize: "0.75rem", lineHeight: 1.9, whiteSpace: "pre-wrap" }}>{
`# 1. Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# 2. Pull a model (one-time download)
ollama pull mistral:7b          # ~2 GB, good quality
ollama pull qwen2.5-coder:7b  # great for code generation
ollama pull mistral           # lighter alternative

# 3. Start the server
ollama serve                  # default: http://localhost:11434`
        }</pre>
      </div>

      <div className="hint" style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <Info size={11} className="shrink-0" style={{ marginTop: 2 }} />
        <span>
          For best results use a model with strong JSON output and code generation.
          Recommended: <strong>mistral:7b</strong>, <strong>qwen2.5-coder:7b</strong>, <strong>mistral</strong>.
          Small models (≤3B) may struggle to produce valid Playwright code.
        </span>
      </div>
    </div>
  );
}

// ── Cloud provider card ───────────────────────────────────────────────────────
function ProviderCard({ provider, activeProvider, maskedKey, ollamaBaseUrl, ollamaModel, onSave, onDelete }) {
  const [input, setInput]           = useState("");
  const [show, setShow]             = useState(false);
  const [saving, setSaving]         = useState(false);
  const [status, setStatus]         = useState(null);
  const [error, setError]           = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Auto-reset confirmation state after 4s if user doesn't follow through
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  // Warn before navigating away with unsaved API key input
  useEffect(() => {
    if (!input.trim()) return;
    function handleBeforeUnload(e) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [input]);

  // Ollama-specific local state — sync with props when parent reloads settings.
  // Always sync (not just when truthy) so deactivation resets to defaults.
  const [ollamaUrl, setOllamaUrl]   = useState(ollamaBaseUrl || "http://localhost:11434");
  const [ollamaMdl, setOllamaMdl]   = useState(ollamaModel   || "mistral:7b");

  useEffect(() => {
    setOllamaUrl(ollamaBaseUrl || "http://localhost:11434");
  }, [ollamaBaseUrl]);
  useEffect(() => {
    setOllamaMdl(ollamaModel || "mistral:7b");
  }, [ollamaModel]);

  const isActive = activeProvider === provider.id;
  const hasKey   = !!maskedKey;
  const isLocal  = provider.isLocal;

  async function handleSave() {
    if (saving) return;
    if (!isLocal && !input.trim()) return;
    setSaving(true); setStatus(null); setError("");
    try {
      if (isLocal) {
        await onSave(provider.id, null, { baseUrl: ollamaUrl, model: ollamaMdl });
      } else {
        await onSave(provider.id, input.trim());
      }
      setStatus("saved");
      if (!isLocal) setInput("");
      setTimeout(() => setStatus(null), 3000);
    } catch (err) {
      setStatus("error");
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteClick() {
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    setConfirmingDelete(false);
    onDelete(provider.id);
  }

  return (
    <div className="st-provider-card" style={{
      background: isActive ? provider.bg : "var(--surface)",
      border: `1px solid ${isActive ? provider.borderColor : "var(--border)"}`,
    }}>
      {/* Active indicator */}
      {isActive && (
        <div className="st-provider-active-pill" style={{ background: provider.bg, border: `1px solid ${provider.borderColor}` }}>
          <Zap size={11} color={provider.color} />
          <span style={{ fontSize: "0.7rem", fontWeight: 700, color: provider.color }}>Active</span>
        </div>
      )}

      {/* Header */}
      <div className="st-provider-header">
        <div className="st-provider-icon" style={{
          background: isActive ? provider.bg : "var(--bg3)",
          border: `1px solid ${isActive ? provider.borderColor : "var(--border)"}`,
        }}>
          {provider.id === "anthropic" ? "🔶" : provider.id === "openai" ? "🟢" : provider.id === "local" ? "🦙" : "🔷"}
        </div>
        <div className="flex-1">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <span className="font-bold">{provider.name}</span>
            <span className="st-provider-badge" style={{ color: provider.badgeColor, background: `${provider.badgeColor}18` }}>
              {provider.badge}
            </span>
          </div>
          <div className="text-xs text-sub">
            {provider.company}
            {!isLocal && ` · ${provider.model}`}
            {isLocal && isActive && ` · ${ollamaMdl}`}
          </div>
        </div>
      </div>

      <div className="st-provider-desc">
        {provider.description}
      </div>

      {/* Rate limit warning */}
      {provider.warning && (
        <div className="st-provider-warning">
          <AlertTriangle size={13} color="var(--amber)" className="shrink-0" style={{ marginTop: 2 }} />
          <span className="st-provider-warning-text">{provider.warning}</span>
        </div>
      )}

      {/* ── Local / Ollama section ── */}
      {isLocal ? (
        <>
          <OllamaStatusPanel
            baseUrl={ollamaUrl}
            model={ollamaMdl}
            onModelChange={setOllamaMdl}
            onBaseUrlChange={setOllamaUrl}
          />
          <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
              {saving ? "Activating…" : isActive ? "Update & Save" : "Activate Ollama"}
            </button>
            {isActive && (
              <button
                className={`btn btn-sm ${confirmingDelete ? "btn-danger" : "btn-ghost"}`}
                onClick={handleDeleteClick}
              >
                <Trash2 size={12} />
                {confirmingDelete ? "Confirm deactivate?" : "Deactivate"}
              </button>
            )}
          </div>
          {status === "saved" && (
            <div className="st-status-ok">
              <Check size={12} /> Ollama activated — using {ollamaMdl}
            </div>
          )}
          {status === "error" && (
            <div className="st-status-err">{error}</div>
          )}
          <a href={provider.docsUrl} target="_blank" rel="noreferrer"
            className="st-docs-link" style={{ color: provider.color }}>
            ollama.ai <ExternalLink size={11} />
          </a>
        </>
      ) : (
        /* ── Cloud provider section ── */
        <>
          {/* Current key status */}
          {hasKey && (
            <div className="st-key-status">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Check size={13} color="var(--green)" />
                <span className="text-mono text-sm text-sub">{maskedKey}</span>
              </div>
              <button
                className={`btn btn-sm ${confirmingDelete ? "btn-danger" : "btn-ghost"}`}
                onClick={handleDeleteClick}
                style={{ padding: "3px 8px" }}
              >
                <Trash2 size={11} />
                {confirmingDelete ? "Confirm remove?" : "Remove"}
              </button>
            </div>
          )}

          {/* Key input */}
          <div className="st-key-input-row">
            <div className="st-key-input-wrap">
              <input
                className="input"
                type={show ? "text" : "password"}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSave()}
                placeholder={hasKey ? "Enter new key to replace..." : provider.placeholder}
                style={{ paddingRight: 40 }}
              />
              <button onClick={() => setShow(s => !s)} className="st-key-toggle">
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <button className="btn btn-primary btn-sm" onClick={handleSave}
              disabled={saving || !input.trim()} style={{ flexShrink: 0 }}>
              {saving ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
              {saving ? "Saving..." : "Save"}
            </button>
          </div>

          {status === "saved" && (
            <div className="st-status-ok">
              <Check size={12} /> Key saved — provider is now active
            </div>
          )}
          {status === "error" && (
            <div className="st-status-err">{error}</div>
          )}
          <a href={provider.docsUrl} target="_blank" rel="noreferrer"
            className="st-docs-link" style={{ color: provider.color }}>
            Get {provider.company} API key <ExternalLink size={11} />
          </a>
        </>
      )}
    </div>
  );
}

function SectionTitle({ icon, title, sub }) {
  return (
    <div className="st-section-title">
      <div className="st-section-icon">{icon}</div>
      <div>
        <div className="font-bold" style={{ fontSize: "1.05rem" }}>{title}</div>
        {sub && <div className="text-xs text-muted" style={{ marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
}

function DataAction({ icon, label, sub, count, btnLabel, onAction }) {
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
    <div className="st-data-action">
      <div className="text-muted">{icon}</div>
      <div className="flex-1">
        <div className="font-semi" style={{ fontSize: "0.88rem" }}>
          {label}
          {count != null && <span className="text-xs text-muted" style={{ fontWeight: 400, marginLeft: 6 }}>({count})</span>}
        </div>
        <div className="text-xs text-muted" style={{ marginTop: 2 }}>{sub}</div>
      </div>
      {result ? (
        <span className="st-status-ok" style={{ marginTop: 0 }}>
          <Check size={12} /> {result}
        </span>
      ) : (
        <button className={`btn btn-sm ${confirming ? "btn-danger" : "btn-ghost"}`}
          onClick={handleClick} disabled={clearing || count === 0} style={{ flexShrink: 0 }}>
          {clearing ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
          {confirming ? "Confirm?" : btnLabel}
        </button>
      )}
    </div>
  );
}

function fmtUptime(seconds) {
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const SETTINGS_TABS = [
  { key: "providers", label: "AI Providers", icon: <Zap size={14} /> },
  { key: "execution", label: "Execution",    icon: <Cpu size={14} /> },
  { key: "data",      label: "Data",         icon: <Database size={14} /> },
  { key: "system",    label: "System",       icon: <Server size={14} /> },
];

export default function Settings() {
  usePageTitle("Settings");
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [config, setConfig]     = useState(null);
  const [sysInfo, setSysInfo]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState("providers");

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

  useEffect(() => { reload().finally(() => setLoading(false)); }, []);

  async function handleSave(provider, apiKey, ollamaOpts) {
    await api.saveApiKey(provider, apiKey, ollamaOpts);
    invalidateConfigCache();
    await reload();
    emitTourEvent("provider-saved");
  }

  async function handleDelete(provider) {
    await api.deleteApiKey(provider);
    invalidateConfigCache();
    await reload();
  }

  return (
    <div className="fade-in page-container-md">
      <button className="btn btn-ghost btn-sm mb-lg" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>

      <div className="mb-lg">
        <h1 style={{ fontWeight: 800, fontSize: "1.9rem" }}>Settings</h1>
        <p className="page-subtitle" style={{ marginTop: 6 }}>
          Configure AI providers, execution defaults, and manage data.
        </p>
      </div>

      {/* ── Tab bar ── */}
      <div className="tab-bar">
        {SETTINGS_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`tab-btn${tab === t.key ? " tab-btn--active" : ""}`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab: AI Providers ── */}
      {tab === "providers" && <>
      {/* Active provider banner */}
      {!loading && config && (
        <div className="st-provider-banner" style={{
          background: config.hasProvider ? "rgba(0,229,255,0.05)" : "rgba(255,71,87,0.05)",
          border: `1px solid ${config.hasProvider ? "rgba(0,229,255,0.15)" : "rgba(255,71,87,0.2)"}`,
        }}>
          {config.hasProvider ? (
            <>
              <div className="st-active-dot" />
              <div>
                <div className="font-bold">Active: {config.providerName}</div>
                <div className="text-xs text-muted text-mono">{config.model}</div>
              </div>
            </>
          ) : (
            <>
              <AlertTriangle size={18} color="var(--red)" />
              <div>
                <div className="font-bold" style={{ color: "var(--red)" }}>No AI provider configured</div>
                <div className="text-xs text-muted">
                  Add an API key below, or activate Ollama for 100% local inference
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Provider cards */}
      {loading ? (
        <div className="flex-col gap-lg">
          {[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 200, borderRadius: 16 }} />)}
        </div>
      ) : (
        <div className="flex-col gap-lg">
          {PROVIDERS.map(p => (
            <ProviderCard
              key={p.id}
              provider={p}
              activeProvider={settings?.activeProvider}
              maskedKey={settings?.[p.id]}
              ollamaBaseUrl={settings?.ollamaBaseUrl}
              ollamaModel={settings?.ollamaModel}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* .env tip */}
      <div className="st-env-tip">
        <div className="font-bold" style={{ fontSize: "0.85rem", marginBottom: 10 }}>Prefer environment variables?</div>
        <div className="text-sm text-sub" style={{ lineHeight: 1.8 }}>
          Add to <span className="mono" style={{ background: "var(--bg3)", padding: "1px 6px", borderRadius: 4 }}>backend/.env</span> for persistence across restarts:
        </div>
        <pre className="code-block" style={{ marginTop: 10 }}>{`# Cloud providers
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
GOOGLE_API_KEY=AIza...

# Local / Ollama (no key needed)
AI_PROVIDER=local
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral:7b`}</pre>
      </div>
      </>}

      {/* ── Tab: Execution ── */}
      {tab === "execution" && <>
      <SectionTitle icon={<Cpu size={16} color="var(--accent)" />} title="Test Execution" sub="Self-healing runtime defaults — applied to every test run" />
      <div className="card" style={{ overflow: "hidden" }}>
        {[
          { label: "Element Timeout", value: "5 000 ms", desc: "Max wait for each element strategy in the self-healing waterfall" },
          { label: "Retry Count",     value: "3",        desc: "Number of retries per interaction (safeClick / safeFill)" },
          { label: "Retry Delay",     value: "400 ms",   desc: "Pause between retries before re-attempting the action" },
          { label: "Browser Mode",    value: "Headless", desc: "Chromium runs without a visible window for faster execution" },
          { label: "Viewport",        value: "1280 × 720", desc: "Default browser viewport size used during test runs" },
          { label: "Self-Healing",    value: "Enabled",  desc: "Multi-strategy element finding with adaptive healing history" },
        ].map((item) => (
          <div key={item.label} className="kv-row">
            <div>
              <div className="kv-label">{item.label}</div>
              <div className="kv-desc">{item.desc}</div>
            </div>
            <span className="kv-value" style={{ color: item.value === "Enabled" ? "var(--green)" : undefined }}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8, paddingLeft: 2 }}>
        <Info size={11} style={{ verticalAlign: "middle", marginRight: 4 }} />
        These values are compiled into the self-healing runtime. To customise, edit <span className="text-mono" style={{ background: "var(--bg3)", padding: "1px 5px", borderRadius: 3 }}>backend/src/selfHealing.js</span>
      </div>
      </>}

      {/* ── Tab: Data ── */}
      {tab === "data" && <>
      <SectionTitle icon={<Database size={16} color="var(--amber)" />} title="Data Management" sub="Clear in-memory data — all data is ephemeral and resets on server restart" />
      <div className="flex-col gap-md">
        <DataAction icon={<Activity size={16} />} label="Run History" sub="All crawl and test run records, including logs and results" count={sysInfo?.runs} btnLabel="Clear Runs" onAction={async () => { const r = await api.clearRuns(); await reload(); return r; }} />
        <DataAction icon={<Clock size={16} />} label="Activity Log" sub="Timeline of all user and system actions" count={sysInfo?.activities} btnLabel="Clear Log" onAction={async () => { const r = await api.clearActivities(); await reload(); return r; }} />
        <DataAction icon={<Shield size={16} />} label="Self-Healing History" sub="Learned selector strategies — clearing forces the waterfall to start fresh" count={sysInfo?.healingEntries} btnLabel="Clear History" onAction={async () => { const r = await api.clearHealing(); await reload(); return r; }} />
      </div>
      </>}

      {/* ── Tab: System ── */}
      {tab === "system" && <>
      <SectionTitle icon={<Server size={16} color="var(--green)" />} title="System" sub="Server runtime and resource information" />
      {sysInfo ? (
        <div className="card" style={{ overflow: "hidden" }}>
          {[
            { label: "Uptime",          value: fmtUptime(sysInfo.uptime),                               icon: <Clock size={13} /> },
            { label: "Node.js",         value: sysInfo.nodeVersion,                                      icon: <Server size={13} /> },
            { label: "Playwright",      value: sysInfo.playwrightVersion || "—",                         icon: <Cpu size={13} /> },
            { label: "Heap Memory",     value: `${sysInfo.memoryMB} MB`,                                icon: <HardDrive size={13} /> },
            { label: "Projects",        value: sysInfo.projects,                                         icon: <Database size={13} /> },
            { label: "Tests",           value: `${sysInfo.tests} (${sysInfo.approvedTests} approved, ${sysInfo.draftTests} draft)`, icon: <Activity size={13} /> },
            { label: "Runs",            value: sysInfo.runs,                                             icon: <RefreshCw size={13} /> },
            { label: "Healing Entries", value: sysInfo.healingEntries,                                   icon: <Shield size={13} /> },
          ].map((item) => (
            <div key={item.label} className="info-row">
              <span className="text-muted">{item.icon}</span>
              <span className="text-sm text-sub" style={{ minWidth: 130 }}>{item.label}</span>
              <span className="text-sm text-mono font-semi" style={{ color: "var(--text)" }}>{item.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted" style={{ padding: "20px 0" }}>Could not load system info.</div>
      )}
      </>}

      {/* ── Restart onboarding tour ── */}
      <div className="st-tour-card">
        <div className="st-section-icon icon-box-accent shrink-0">
          <Compass size={16} color="var(--accent)" />
        </div>
        <div className="flex-1">
          <div className="font-bold" style={{ fontSize: "0.88rem" }}>Getting Started Tour</div>
          <div className="text-xs text-muted" style={{ marginTop: 2 }}>
            Re-run the onboarding walkthrough that guides you through setup.
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            resetOnboarding();
            // Navigate away first (avoids beforeunload prompt from unsaved
            // API key inputs), then reload so useOnboarding picks up the
            // force flag from localStorage on fresh mount.
            window.location.href = import.meta.env.BASE_URL + "dashboard";
          }}
          style={{ flexShrink: 0 }}
        >
          <RefreshCw size={13} /> Restart Tour
        </button>
      </div>

      <div style={{ height: 40 }} />
    </div>
  );
}

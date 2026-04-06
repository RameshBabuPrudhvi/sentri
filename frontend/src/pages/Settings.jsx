import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Check, Eye, EyeOff, ExternalLink, AlertTriangle,
  RefreshCw, Trash2, Zap, Database, Server, Clock, Cpu,
  Activity, Shield, HardDrive, Info, Wifi, WifiOff, Terminal,
} from "lucide-react";
import { api } from "../api.js";
import { invalidateConfigCache } from "../components/ProviderBadge.jsx";
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
    model: "llama3.2",            // shown as default; overridden by live config
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
      // ":latest" that the saved config may omit (e.g. "llama3.2" vs
      // "llama3.2:latest"), causing a value mismatch → flicker loop.
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
      <div style={{ height: 1, background: "var(--border)" }} />

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
          ? <RefreshCw size={14} color="var(--text3)" className="spin" style={{ flexShrink: 0, marginTop: 1 }} />
          : status?.ok
          ? <Wifi size={14} color="var(--green)" style={{ flexShrink: 0, marginTop: 1 }} />
          : <WifiOff size={14} color="var(--red)" style={{ flexShrink: 0, marginTop: 1 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          {status == null || checking
            ? <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>Checking Ollama…</span>
            : status.ok
            ? <span style={{ fontSize: "0.82rem", color: "var(--green)", fontWeight: 500 }}>
                Connected · <span style={{ fontFamily: "var(--font-mono)" }}>{status.model}</span>
              </span>
            : <span style={{ fontSize: "0.78rem", color: "var(--red)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {status.error}
              </span>}
        </div>
        <button className="btn btn-ghost btn-xs" onClick={check} disabled={checking} style={{ flexShrink: 0 }}>
          <RefreshCw size={11} className={checking ? "spin" : undefined} /> Check
        </button>
      </div>
      {!status?.ok && status != null && !checking && (
        <div style={{ fontSize: "0.7rem", color: "var(--text3)", fontStyle: "italic" }}>
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
          <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 4 }}>
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
            placeholder="llama3.2"
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
        <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 4 }}>
          Change this if Ollama is running on a remote host or a different port.
        </div>
      </div>

      {/* Quick-start instructions */}
      <div style={{ padding: "12px 14px", background: "var(--bg3)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
        <div style={{ fontSize: "0.78rem", fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <Terminal size={13} color="var(--text2)" /> Quick start
        </div>
        <pre style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text2)", lineHeight: 1.9, whiteSpace: "pre-wrap" }}>{
`# 1. Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# 2. Pull a model (one-time download)
ollama pull llama3.2          # ~2 GB, good quality
ollama pull qwen2.5-coder:7b  # great for code generation
ollama pull mistral           # lighter alternative

# 3. Start the server
ollama serve                  # default: http://localhost:11434`
        }</pre>
      </div>

      <div style={{ fontSize: "0.73rem", color: "var(--text3)", display: "flex", alignItems: "flex-start", gap: 6 }}>
        <Info size={11} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          For best results use a model with strong JSON output and code generation.
          Recommended: <strong>llama3.2</strong>, <strong>qwen2.5-coder:7b</strong>, <strong>mistral</strong>.
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
  const [ollamaMdl, setOllamaMdl]   = useState(ollamaModel   || "llama3.2");

  useEffect(() => {
    setOllamaUrl(ollamaBaseUrl || "http://localhost:11434");
  }, [ollamaBaseUrl]);
  useEffect(() => {
    setOllamaMdl(ollamaModel || "llama3.2");
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
    <div style={{
      background: isActive ? provider.bg : "var(--surface)",
      border: `1px solid ${isActive ? provider.borderColor : "var(--border)"}`,
      borderRadius: "var(--radius-lg)", padding: 24,
      transition: "all 0.2s", position: "relative",
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
          <span style={{ fontSize: "0.7rem", fontWeight: 700, color: provider.color }}>Active</span>
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
          {provider.id === "anthropic" ? "🔶" : provider.id === "openai" ? "🟢" : provider.id === "local" ? "🦙" : "🔷"}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <span style={{ fontWeight: 700, fontSize: "1rem" }}>{provider.name}</span>
            <span style={{ fontSize: "0.65rem", fontWeight: 700, color: provider.badgeColor, background: `${provider.badgeColor}18`, padding: "2px 7px", borderRadius: 99 }}>
              {provider.badge}
            </span>
          </div>
          <div style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
            {provider.company}
            {!isLocal && ` · ${provider.model}`}
            {isLocal && isActive && ` · ${ollamaMdl}`}
          </div>
        </div>
      </div>

      <div style={{ fontSize: "0.82rem", color: "var(--text2)", marginBottom: 16, lineHeight: 1.6 }}>
        {provider.description}
      </div>

      {/* Rate limit warning */}
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
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, color: "var(--green)", fontSize: "0.78rem" }}>
              <Check size={12} /> Ollama activated — using {ollamaMdl}
            </div>
          )}
          {status === "error" && (
            <div style={{ marginTop: 8, fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>
          )}
          <a href={provider.docsUrl} target="_blank" rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 12, fontSize: "0.76rem", color: provider.color }}>
            ollama.ai <ExternalLink size={11} />
          </a>
        </>
      ) : (
        /* ── Cloud provider section ── */
        <>
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
              <button onClick={() => setShow(s => !s)}
                style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 0 }}>
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
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, color: "var(--green)", fontSize: "0.78rem" }}>
              <Check size={12} /> Key saved — provider is now active
            </div>
          )}
          {status === "error" && (
            <div style={{ marginTop: 8, fontSize: "0.78rem", color: "var(--red)" }}>{error}</div>
          )}
          <a href={provider.docsUrl} target="_blank" rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 12, fontSize: "0.76rem", color: provider.color }}>
            Get {provider.company} API key <ExternalLink size={11} />
          </a>
        </>
      )}
    </div>
  );
}

function SectionTitle({ icon, title, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, marginTop: 40 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {icon}
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{title}</div>
        {sub && <div style={{ fontSize: "0.76rem", color: "var(--text3)", marginTop: 1 }}>{sub}</div>}
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
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}>
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

export default function Settings() {
  usePageTitle("Settings");
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [config, setConfig]     = useState(null);
  const [sysInfo, setSysInfo]   = useState(null);
  const [loading, setLoading]   = useState(true);

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
        <h1 style={{ fontWeight: 800, fontSize: "1.9rem" }}>Settings</h1>
        <p style={{ color: "var(--text2)", marginTop: 6 }}>
          Choose your AI provider. Cloud providers need an API key; Ollama runs fully locally.
        </p>
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
                <div style={{ fontWeight: 700, color: "var(--text)" }}>Active: {config.providerName}</div>
                <div style={{ fontSize: "0.76rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>{config.model}</div>
              </div>
            </>
          ) : (
            <>
              <AlertTriangle size={18} color="var(--red)" />
              <div>
                <div style={{ fontWeight: 700, color: "var(--red)" }}>No AI provider configured</div>
                <div style={{ fontSize: "0.76rem", color: "var(--text3)" }}>
                  Add an API key below, or activate Ollama for 100% local inference
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Provider cards */}
      {loading ? (
        <div style={{ display: "grid", gap: 16 }}>
          {[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 200, borderRadius: 16 }} />)}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
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
      <div style={{ marginTop: 28, padding: "16px 20px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}>
        <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 10 }}>Prefer environment variables?</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text2)", lineHeight: 1.8 }}>
          Add to <span className="mono" style={{ background: "var(--bg3)", padding: "1px 6px", borderRadius: 4 }}>backend/.env</span> for persistence across restarts:
        </div>
        <pre style={{
          marginTop: 10, padding: "12px 16px", background: "#040608",
          border: "1px solid var(--border)", borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "#6ab4a0",
          overflowX: "auto", lineHeight: 2,
        }}>{`# Cloud providers
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
GOOGLE_API_KEY=AIza...

# Local / Ollama (no key needed)
AI_PROVIDER=local
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2`}</pre>
      </div>

      {/* ── Test Execution ── */}
      <SectionTitle icon={<Cpu size={16} color="var(--accent)" />} title="Test Execution" sub="Self-healing runtime defaults — applied to every test run" />
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
        {[
          { label: "Element Timeout", value: "5 000 ms", desc: "Max wait for each element strategy in the self-healing waterfall" },
          { label: "Retry Count",     value: "3",        desc: "Number of retries per interaction (safeClick / safeFill)" },
          { label: "Retry Delay",     value: "400 ms",   desc: "Pause between retries before re-attempting the action" },
          { label: "Browser Mode",    value: "Headless", desc: "Chromium runs without a visible window for faster execution" },
          { label: "Viewport",        value: "1280 × 720", desc: "Default browser viewport size used during test runs" },
          { label: "Self-Healing",    value: "Enabled",  desc: "Multi-strategy element finding with adaptive healing history" },
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
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", fontWeight: 600, color: item.value === "Enabled" ? "var(--green)" : "var(--text)", background: "var(--bg3)", padding: "3px 10px", borderRadius: 6 }}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 8, paddingLeft: 2 }}>
        <Info size={11} style={{ verticalAlign: "middle", marginRight: 4 }} />
        These values are compiled into the self-healing runtime. To customise, edit <span style={{ fontFamily: "var(--font-mono)", background: "var(--bg3)", padding: "1px 5px", borderRadius: 3 }}>backend/src/selfHealing.js</span>
      </div>

      {/* ── Data Management ── */}
      <SectionTitle icon={<Database size={16} color="var(--amber)" />} title="Data Management" sub="Clear in-memory data — all data is ephemeral and resets on server restart" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <DataAction icon={<Activity size={16} />} label="Run History" sub="All crawl and test run records, including logs and results" count={sysInfo?.runs} btnLabel="Clear Runs" onAction={async () => { const r = await api.clearRuns(); await reload(); return r; }} />
        <DataAction icon={<Clock size={16} />} label="Activity Log" sub="Timeline of all user and system actions" count={sysInfo?.activities} btnLabel="Clear Log" onAction={async () => { const r = await api.clearActivities(); await reload(); return r; }} />
        <DataAction icon={<Shield size={16} />} label="Self-Healing History" sub="Learned selector strategies — clearing forces the waterfall to start fresh" count={sysInfo?.healingEntries} btnLabel="Clear History" onAction={async () => { const r = await api.clearHealing(); await reload(); return r; }} />
      </div>

      {/* ── System Info ── */}
      <SectionTitle icon={<Server size={16} color="var(--green)" />} title="System" sub="Server runtime and resource information" />
      {sysInfo ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
          {[
            { label: "Uptime",          value: fmtUptime(sysInfo.uptime),                               icon: <Clock size={13} /> },
            { label: "Node.js",         value: sysInfo.nodeVersion,                                      icon: <Server size={13} /> },
            { label: "Playwright",      value: sysInfo.playwrightVersion || "—",                         icon: <Cpu size={13} /> },
            { label: "Heap Memory",     value: `${sysInfo.memoryMB} MB`,                                icon: <HardDrive size={13} /> },
            { label: "Projects",        value: sysInfo.projects,                                         icon: <Database size={13} /> },
            { label: "Tests",           value: `${sysInfo.tests} (${sysInfo.approvedTests} approved, ${sysInfo.draftTests} draft)`, icon: <Activity size={13} /> },
            { label: "Runs",            value: sysInfo.runs,                                             icon: <RefreshCw size={13} /> },
            { label: "Healing Entries", value: sysInfo.healingEntries,                                   icon: <Shield size={13} /> },
          ].map((item, i, arr) => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 20px", borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none" }}>
              <span style={{ color: "var(--text3)" }}>{item.icon}</span>
              <span style={{ fontSize: "0.82rem", color: "var(--text2)", minWidth: 130 }}>{item.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem", fontWeight: 500, color: "var(--text)" }}>{item.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: "20px 0", color: "var(--text3)", fontSize: "0.85rem" }}>Could not load system info.</div>
      )}

      <div style={{ height: 40 }} />
    </div>
  );
}

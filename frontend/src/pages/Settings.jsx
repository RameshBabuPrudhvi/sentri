import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Check, Eye, EyeOff, ExternalLink, AlertTriangle,
  RefreshCw, Trash2, Zap, Database, Server, Clock, Cpu,
  Activity, Shield, HardDrive, Info, Wifi, WifiOff, Terminal,
  Compass, RotateCcw, FolderOpen, FileText, Play, AlertCircle,
  Users, UserPlus, Crown, KeyRound, Smartphone, Download,
  Route as RouteIcon, Plus, Upload as UploadIcon,
} from "lucide-react";
import { api } from "../api.js";
import { AGENT_ROLES } from "../config.js";
import { invalidateSettingsCache } from "../queryClient.js";
import {
  useSettingsBundleQuery,
  useMembersQuery,
  useRecycleBinQuery,
  useOllamaStatusQuery,
} from "../hooks/queries/useSettingsQueries.js";
import { invalidateConfigCache } from "../components/layout/ProviderBadge.jsx";
import { resetOnboarding, emitTourEvent } from "../hooks/useOnboarding.js";
import usePageTitle from "../hooks/usePageTitle.js";
import { useAuth } from "../context/AuthContext.jsx";

const OPENAI_COMPAT_HINTS = ["https://api.deepseek.com/v1", "https://api.groq.com/openai/v1", "https://api.mistral.ai/v1", "https://api.x.ai/v1"];

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
    id: "openrouter",
    name: "OpenRouter",
    company: "OpenRouter",
    model: "openrouter/auto",
    placeholder: "sk-or-v1-...",
    docsUrl: "https://openrouter.ai/keys",
    color: "#8385f4",
    borderColor: "rgba(100,102,241,0.3)",
    bg: "rgba(100,102,241,0.06)",
    description: "Unified gateway to 200+ models (Claude, GPT, Llama, Mixtral, etc.) with one key.",
    badge: "Multi-model",
    badgeColor: "var(--accent)",
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
  // Refs avoid re-triggering the model-sync effect when model/callback change.
  const modelRef = useRef(model);
  const onModelChangeRef = useRef(onModelChange);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { onModelChangeRef.current = onModelChange; }, [onModelChange]);

  const statusQuery = useOllamaStatusQuery();

  const status = statusQuery.data ?? null;
  const checking = statusQuery.isFetching;

  const check = useCallback(() => statusQuery.refetch(), [statusQuery]);

  // Sync model state to the exact option value returned by Ollama so the
  // controlled <select> stays in sync. Ollama tags include a suffix like
  // ":latest" that the saved config may omit (e.g. "mistral:7b" vs
  // "mistral:7b:latest"), causing a value mismatch → flicker loop.
  useEffect(() => {
    if (!status?.availableModels?.length) return;
    const cur = modelRef.current;
    if (!status.availableModels.includes(cur)) {
      const match = status.availableModels.find(m => m.split(":")[0] === cur.split(":")[0]);
      if (match) onModelChangeRef.current(match);
    }
  }, [status]);

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
          {provider.id === "anthropic" ? "🔶" : provider.id === "openai" ? "🟢" : provider.id === "openrouter" ? "🧭" : provider.id === "local" ? "🦙" : "🔷"}
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
  { key: "providers",   label: "AI Providers",  icon: <Zap size={14} />,          adminOnly: true },
  { key: "provider_routes", label: "Provider Routes", icon: <RouteIcon size={14} />, adminOnly: true },
  { key: "agent_roles", label: "Agent Roles", icon: <Users size={14} />, adminOnly: true },
  { key: "members",     label: "Members",       icon: <Users size={14} />,        adminOnly: true },
  { key: "execution",   label: "Execution",     icon: <Cpu size={14} />,          adminOnly: false },
  // Integrations is gated by qa_lead on the backend (GET /settings/github-checks).
  // Keep it after `execution` so viewers (who lack qa_lead) don't land on a tab
  // whose data fetch immediately 403s — `execution` stays the safe default for
  // all non-admin roles. See review thread on this file (line 543).
  { key: "integrations", label: "Integrations", icon: <ExternalLink size={14} />, adminOnly: false },
  { key: "data",        label: "Data",          icon: <Database size={14} />,     adminOnly: true },
  // SEC-004: MFA / passkey management. Available to every user (each
  // manages their own factors); the admin-only enforcement panel inside the
  // tab is gated client-side AND on the backend.
  { key: "security",    label: "Security",      icon: <KeyRound size={14} />,     adminOnly: false },
  { key: "account",     label: "Account",       icon: <Shield size={14} />,       adminOnly: false },
];

// Renders in place of an admin-only tab body when a non-admin lands on it
// (e.g. via deep link / stale tab state). UI gate only — backend mutation
// routes still enforce requireRole("admin") as the authoritative ACL.
function AdminLockedSection({ feature, role }) {
  return (
    <div className="card card-padded" style={{ textAlign: "center", padding: "40px 24px" }}>
      <Shield size={28} color="var(--text3)" style={{ marginBottom: 12 }} />
      <div className="font-bold" style={{ fontSize: "1.05rem", marginBottom: 6 }}>
        {feature} requires admin access
      </div>
      <div className="text-sm text-muted" style={{ maxWidth: 420, margin: "0 auto" }}>
        Your current role is <strong>{role || "viewer"}</strong>. Ask a workspace admin to grant you
        the <strong>admin</strong> role if you need to change these settings.
      </div>
    </div>
  );
}



function AgentRolesTab() {
  const empty = { role: AGENT_ROLES[0], provider: "", model: "", systemPromptOverride: "", temperature: 0.2, maxTokens: "", fallbackRole: "" };
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(empty);
  const [editingRole, setEditingRole] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // AI-005 — per-row probe state keyed by role. Each entry is
  // `{ status: "running" | "ok" | "err", reason?: string, provider?: string }`
  // so the inline badge can render the live result of the last
  // `api.testAgentRole(role)` call without blocking the rest of the form.
  const [probes, setProbes] = useState({});
  const load = useCallback(async () => {
    try { const r = await api.getAgentRoles(); setRows(r.roles || []); }
    catch (err) { setError(err.message || "Failed to load agent roles."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload = {
        ...form,
        provider: form.provider || null,
        model: form.model || null,
        systemPromptOverride: form.systemPromptOverride || null,
        maxTokens: form.maxTokens ? Number(form.maxTokens) : null,
        // B3.2 — `fallbackRole` UI is deprecated. Always send `null`
        // for new saves so the DB column drifts toward unused while we
        // keep it around for one release per the rollback contract.
        // Existing rows with non-null fallbackRole are not migrated
        // here — operators clear them by re-saving the role in the
        // Provider Routes tab via the route-level fallback.
        fallbackRole: null,
      };
      if (editingRole) await api.updateAgentRole(editingRole, payload);
      else await api.createAgentRole(payload);
      setEditingRole("");
      setForm(empty);
      await load();
    } catch (err) {
      setError(err.message || "Failed to save agent role.");
    } finally {
      setBusy(false);
    }
  }
  function edit(row) {
    setError("");
    setEditingRole(row.role);
    setForm({ role: row.role, provider: row.provider || "", model: row.model || "", systemPromptOverride: row.systemPromptOverride || "", temperature: row.temperature ?? 0.2, maxTokens: row.maxTokens ?? "", fallbackRole: row.fallbackRole || "" });
  }
  async function del(role) {
    setError("");
    try {
      await api.deleteAgentRole(role);
      if (editingRole === role) { setEditingRole(""); setForm(empty); }
      await load();
    } catch (err) {
      setError(err.message || "Failed to delete agent role.");
    }
  }
  // AI-005 — Fire a 1-token probe against the configured (provider, role).
  // The backend route returns `{ ok, reason, provider }`. We never throw to
  // the caller — every failure path (404, 500, network) ends up as a red
  // badge so the operator can see what went wrong inline.
  async function runProbe(role) {
    setProbes((s) => ({ ...s, [role]: { status: "running" } }));
    try {
      const res = await api.testAgentRole(role);
      setProbes((s) => ({
        ...s,
        [role]: {
          status: res.ok ? "ok" : "err",
          reason: res.reason || null,
          provider: res.provider || null,
        },
      }));
    } catch (err) {
      setProbes((s) => ({
        ...s,
        [role]: { status: "err", reason: err?.body?.error || err?.message || "probe_failed", provider: null },
      }));
    }
  }
  return <div className="card card-padded">
    <h3>Agent Roles</h3>
    {error && (
      <div className="st-status-err st-agent-error">
        <AlertCircle size={12} /> {error}
      </div>
    )}
    <form onSubmit={save} className="st-agent-form">
      <select className="input" value={form.role} onChange={(e) => setForm((s) => ({ ...s, role: e.target.value }))} disabled={!!editingRole}>{AGENT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
      <input className="input" placeholder="provider (optional)" value={form.provider} onChange={(e) => setForm((s) => ({ ...s, provider: e.target.value }))} />
      <input className="input" placeholder="model (optional)" value={form.model} onChange={(e) => setForm((s) => ({ ...s, model: e.target.value }))} />
      <textarea className="input" placeholder="system prompt override" value={form.systemPromptOverride} onChange={(e) => setForm((s) => ({ ...s, systemPromptOverride: e.target.value }))} />
      <input className="input" type="number" step="0.1" value={form.temperature} onChange={(e) => setForm((s) => ({ ...s, temperature: Number(e.target.value) }))} />
      <input className="input" type="number" placeholder="max tokens" value={form.maxTokens} onChange={(e) => setForm((s) => ({ ...s, maxTokens: e.target.value }))} />
      {/* B3.2 — `fallbackRole` is deprecated. The canonical per-route
          fallback lives on `provider_routes.fallbackRouteId` and is
          edited in the Provider Routes tab. The DB column on
          `agent_configs.fallbackRole` is preserved for one release so a
          rollback to pre-B3 dispatch keeps working; the UI no longer
          exposes it. New role configs leave `fallbackRole` as null —
          dispatch resolves the fallback chain via the assigned
          provider_route. Restore the dropdown here ONLY if the
          rollback path needs to be re-enabled. */}
      <div className="st-agent-fallback-deprecation">
        <Info size={11} />
        <span>
          Per-role fallback is now configured on the provider route's
          {" "}<strong>Fallback route</strong> field (Provider Routes tab).
        </span>
      </div>
      <div className="st-agent-form-actions">
        <button className="btn btn-primary btn-sm" disabled={busy}>{editingRole ? "Update role config" : "Save role config"}</button>
        {editingRole && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditingRole(""); setForm(empty); setError(""); }}>Cancel edit</button>}
      </div>
    </form>
    <div className="st-agent-rows">{rows.map((r) => {
      const probe = probes[r.role];
      return (
        <div key={r.role} className="card-padded-sm st-agent-row">
          <span className="st-agent-row-meta">{r.role} · {r.provider || "workspace-default"} · {r.model || "provider-default"} · temp {r.temperature}</span>
          {probe && probe.status !== "running" && (
            <span
              className={`${probe.status === "ok" ? "st-status-ok" : "st-status-err"} st-agent-row-badge`}
              title={probe.reason || (probe.status === "ok" ? "OK" : "Failed")}
            >
              {probe.status === "ok" ? <Check size={11} /> : <AlertCircle size={11} />}
              {probe.status === "ok"
                ? `OK · ${probe.provider || "provider"}`
                : `${probe.reason || "failed"}${probe.provider ? ` · ${probe.provider}` : ""}`}
            </span>
          )}
          <div className="st-agent-row-actions">
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => runProbe(r.role)}
              disabled={probe?.status === "running"}
              title="Send a 1-token probe to validate this (provider, role) without kicking off a real run."
            >
              {probe?.status === "running" ? <RefreshCw size={11} className="spin" /> : <Activity size={11} />}
              {probe?.status === "running" ? "Testing…" : "Test"}
            </button>
            <button className="btn btn-ghost btn-xs" onClick={() => edit(r)}>Edit</button>
            <button className="btn btn-danger btn-xs" onClick={() => del(r.role)}>Delete</button>
          </div>
        </div>
      );
    })}</div>
  </div>;
}

// ── Provider Routes tab (B3.1) ────────────────────────────────────────────────
//
// Per-row CRUD for `provider_routes` — the dispatch target every agent role
// pins via `routeId`. Surfaces name / family / protocol / baseUrl / model /
// apiKey (write-only, shows `••••<lastFour>`) / enabled / rpmLimit / tpmLimit
// / cacheEnabled / cacheTtlSec / fallbackRouteId plus three actions:
//
//   • Test / Re-probe → POST /settings/provider-routes/:id/probe.
//     Renders an inline green / red badge from the persisted
//     `capabilities.reachable` flag (B2.2 contract — every probe row is a
//     real network call, never a catalog copy).
//   • Rotate key (B3.6) → POST /settings/provider-routes/:id/rotate-key
//     with a fresh plaintext key. Server gates on a successful probe before
//     accepting the new key, so the inline confirmation reflects whether
//     the rotation actually went through.
//
// Mirrors the `AgentRolesTab` pattern (form on top, list below, per-row
// inline badges) so admins moving between the two tabs don't context-switch.
// No inline styles — every layout class lives in
// `frontend/src/styles/pages/settings.css` so future theme work hits one file.

// Supported families + protocols, mirrored from migration 035's enum
// comments and `protocolForProvider.PROTOCOL_MAP`. Kept inline rather than
// fetched at runtime — the set is process-stable across deployments and a
// round-trip to populate two dropdowns would be noise on every render.
const PR_FAMILIES = ["anthropic", "openai", "google", "openrouter", "local", "custom"];
const PR_PROTOCOLS = ["openai", "anthropic", "gemini", "ollama"];

const PR_FORM_EMPTY = {
  id: null,
  name: "",
  family: "openai",
  protocol: "openai",
  baseUrl: "",
  model: "",
  apiKey: "",
  enabled: true,
  rpmLimit: "",
  tpmLimit: "",
  cacheEnabled: false,
  cacheTtlSec: "",
  fallbackRouteId: "",
};

function maskedKeyDisplay(lastFour) {
  if (!lastFour) return "—";
  return `••••${lastFour}`;
}

// B3.2 — Client-side fallback-cycle preview. Walks the `fallbackRouteId`
// chain starting from the proposed fallback and returns the offending
// route id when the walk revisits `startRouteId` (or hits the depth cap).
// Mirrors `providerRouteRepo.wouldCreateCycle` so the UI matches the
// authoritative backend check; the backend still wins on save (it sees
// concurrent edits we can't), but the inline warning lets the operator
// fix the loop without round-tripping through `ERR_ROUTE_FALLBACK_CYCLE`.
//
// `startRouteId` is `null` for the create form (no id yet, no self-loop
// possible) and the current row's id for the edit form. Returns `null`
// when no cycle exists.
function detectFallbackCycle(rows, startRouteId, proposedFallbackId) {
  if (!proposedFallbackId) return null;
  if (startRouteId && proposedFallbackId === startRouteId) return startRouteId;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set();
  if (startRouteId) seen.add(startRouteId);
  let cur = proposedFallbackId;
  // Bounded — caps at 64 hops (same as the repo). Any legitimate chain
  // is far shorter; the cap defends against malformed local state.
  for (let i = 0; i < 64 && cur; i += 1) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    cur = byId.get(cur)?.fallbackRouteId || null;
  }
  return null;
}

// Inline probe-result badge. Reads the row's persisted `capabilities`
// payload + the optional `live` override (the result of the current Test
// click before the parent has refetched). `live` wins so the admin sees
// the click respond instantly, then the badge stabilises once the row
// data comes back from the refetch.
function ProbeBadge({ capabilities, live }) {
  const caps = live || capabilities;
  if (!caps) return <span className="st-pr-badge st-pr-badge--unprobed">Unprobed</span>;
  if (caps.reachable && caps.auth !== false && caps.model !== false) {
    return (
      <span className="st-status-ok st-pr-badge" title={`Probed at ${caps.probedAt || "unknown"}`}>
        <Check size={11} /> Reachable
      </span>
    );
  }
  const reason = caps.errorReason || "unreachable";
  return (
    <span className="st-status-err st-pr-badge" title={reason}>
      <AlertCircle size={11} /> {reason.slice(0, 24)}
    </span>
  );
}

// Create / edit form. Pulled into its own component so the parent
// `ProviderRoutesTabView` JSX stays scannable — the form has ten fields
// and would otherwise dominate the surrounding list rendering.
function ProviderRoutesForm({ form, setForm, busy, showKey, setShowKey, fallbackOptions, cycleAtName, onSave, onCancel }) {
  return (
    <form onSubmit={onSave} className="st-pr-form">
      <div className="st-pr-form-grid">
        <label className="st-pr-field">
          <span className="st-pr-field-label">Name</span>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
            placeholder="anthropic-primary"
            required
          />
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Family</span>
          <select
            className="input"
            value={form.family}
            onChange={(e) => setForm((s) => ({ ...s, family: e.target.value }))}
          >
            {PR_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Protocol</span>
          <select
            className="input"
            value={form.protocol}
            onChange={(e) => setForm((s) => ({ ...s, protocol: e.target.value }))}
          >
            {PR_PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Model</span>
          <input
            className="input"
            value={form.model}
            onChange={(e) => setForm((s) => ({ ...s, model: e.target.value }))}
            placeholder="claude-3-5-sonnet"
            required
          />
        </label>
        <label className="st-pr-field st-pr-field--wide">
          <span className="st-pr-field-label">Base URL (optional)</span>
          <input
            className="input"
            value={form.baseUrl}
            onChange={(e) => setForm((s) => ({ ...s, baseUrl: e.target.value }))}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label className="st-pr-field st-pr-field--wide">
          <span className="st-pr-field-label">
            API key {form.id && <span className="text-xs text-muted">(leave empty to keep existing)</span>}
          </span>
          <div className="st-key-input-wrap">
            <input
              className="input"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              value={form.apiKey}
              onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))}
              placeholder={form.id ? "•••• keep stored key" : "sk-..."}
            />
            <button type="button" className="st-key-toggle" onClick={() => setShowKey((v) => !v)}>
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">RPM limit</span>
          <input
            className="input" type="number" min={0}
            value={form.rpmLimit}
            onChange={(e) => setForm((s) => ({ ...s, rpmLimit: e.target.value }))}
            placeholder="—"
          />
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">TPM limit</span>
          <input
            className="input" type="number" min={0}
            value={form.tpmLimit}
            onChange={(e) => setForm((s) => ({ ...s, tpmLimit: e.target.value }))}
            placeholder="—"
          />
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Cache TTL (s)</span>
          <input
            className="input" type="number" min={0}
            value={form.cacheTtlSec}
            onChange={(e) => setForm((s) => ({ ...s, cacheTtlSec: e.target.value }))}
            placeholder="0"
            disabled={!form.cacheEnabled}
          />
        </label>
        <label className="st-pr-field st-pr-field--wide">
          <span className="st-pr-field-label">Fallback route</span>
          <select
            className="input"
            value={form.fallbackRouteId}
            onChange={(e) => setForm((s) => ({ ...s, fallbackRouteId: e.target.value }))}
          >
            <option value="">No fallback</option>
            {fallbackOptions.map((r) => (
              <option key={r.id} value={r.id}>{r.name} ({r.family})</option>
            ))}
          </select>
          {/* B3.2 — Inline cycle preview. The backend's
              `ERR_ROUTE_FALLBACK_CYCLE` is the authoritative check; this
              warning fires on the same data the operator is editing
              client-side so they can fix the loop before submitting.
              `cycleAtName` is the human name of the route where the walk
              revisits its origin. */}
          {cycleAtName && (
            <div className="st-status-err st-pr-cycle-warning">
              <AlertTriangle size={11} /> Fallback chain loops at "{cycleAtName}". Pick a different route.
            </div>
          )}
        </label>
      </div>

      <div className="st-pr-form-checks">
        <label className="st-pr-check">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm((s) => ({ ...s, enabled: e.target.checked }))}
          />
          Enabled
        </label>
        <label className="st-pr-check">
          <input
            type="checkbox"
            checked={form.cacheEnabled}
            onChange={(e) => setForm((s) => ({ ...s, cacheEnabled: e.target.checked }))}
          />
          Cache responses
        </label>
      </div>

      <div className="st-agent-form-actions">
        {/* B3.2 — Disable save when a fallback cycle was detected
            client-side. The backend would reject the save with
            `ERR_ROUTE_FALLBACK_CYCLE` anyway; disabling here saves
            the round-trip and surfaces the issue immediately. */}
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !!cycleAtName}>
          {busy ? <RefreshCw size={13} className="spin" /> : (form.id ? <Check size={13} /> : <Plus size={13} />)}
          {form.id ? "Update route" : "Create route"}
        </button>
        {form.id && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            Cancel edit
          </button>
        )}
      </div>
    </form>
  );
}

// Per-row card. Carries its own action bar + rotate-key inline panel.
// Pulled into a separate component so the table-of-rows render in
// `ProviderRoutesTabView` stays a clean `rows.map`. Action handlers are
// passed in as props — the row is otherwise stateless.
function ProviderRouteRow({ row, rows, rowState, rotateOpen, setRotateOpen, rotateBuf, setRotateBuf, onEdit, onDelete, onProbe, onRotate }) {
  const probing = rowState?.kind === "probing";
  const rotating = rowState?.kind === "rotating";
  const deleting = rowState?.kind === "deleting";
  const liveCaps = rowState?.kind === "ok" && rowState.caps ? rowState.caps : null;
  const fallbackName = row.fallbackRouteId
    ? (rows.find((r) => r.id === row.fallbackRouteId)?.name || row.fallbackRouteId)
    : null;
  return (
    <div className="card-padded-sm st-pr-row">
      <div className="st-pr-row-header">
        <div className="st-pr-row-name">
          <span className="font-semi">{row.name}</span>
          {!row.enabled && <span className="st-pr-badge st-pr-badge--disabled">Disabled</span>}
          <ProbeBadge capabilities={row.capabilities} live={liveCaps} />
        </div>
        <div className="text-xs text-muted st-pr-row-meta">
          {row.family} · {row.protocol} · {row.model || "—"}
          {row.baseUrl && ` · ${row.baseUrl}`}
          {" · "}<span className="text-mono">{maskedKeyDisplay(row.apiKeyLastFour)}</span>
        </div>
        <div className="text-xs text-muted st-pr-row-meta">
          rpm {row.rpmLimit ?? "∞"} · tpm {row.tpmLimit ?? "∞"}
          {row.cacheEnabled ? ` · cache ${row.cacheTtlSec || 0}s` : " · no cache"}
          {fallbackName && ` · fallback ${fallbackName}`}
        </div>
        {rowState?.kind === "err" && (
          <div className="st-status-err st-pr-row-error">
            <AlertCircle size={11} /> {rowState.msg}
          </div>
        )}
      </div>
      <div className="st-pr-row-actions">
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => onProbe(row.id)}
          disabled={probing}
          title="Send a real network probe to verify reachability, auth, model, and JSON mode."
        >
          {probing ? <RefreshCw size={11} className="spin" /> : <Activity size={11} />}
          {row.capabilities ? "Re-probe" : "Test"}
        </button>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => setRotateOpen(rotateOpen ? null : row.id)}
          disabled={rotating}
          title="Replace the stored API key. Server gates on a successful probe."
        >
          <KeyRound size={11} />
          Rotate key
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => onEdit(row)}>
          Edit
        </button>
        <button className="btn btn-danger btn-xs" onClick={() => onDelete(row.id)} disabled={deleting}>
          {deleting ? <RefreshCw size={11} className="spin" /> : <Trash2 size={11} />}
          Delete
        </button>
      </div>
      {rotateOpen && (
        <div className="st-pr-rotate-panel">
          <div className="st-key-input-wrap st-pr-rotate-input">
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={rotateBuf[row.id] || ""}
              onChange={(e) => setRotateBuf((b) => ({ ...b, [row.id]: e.target.value }))}
              placeholder="New API key (plaintext — encrypted server-side)"
            />
          </div>
          <button
            className="btn btn-primary btn-xs"
            onClick={() => onRotate(row.id)}
            disabled={rotating || !(rotateBuf[row.id] || "").trim()}
          >
            {rotating ? <RefreshCw size={11} className="spin" /> : <Check size={11} />}
            Rotate
          </button>
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => {
              setRotateOpen(null);
              setRotateBuf((b) => { const n = { ...b }; delete n[row.id]; return n; });
            }}
            disabled={rotating}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// Presentational shell for the Provider Routes tab. Receives every
// piece of state + every action callback as a prop so the JSX is
// trivially testable in isolation and the parent function stays a
// pure orchestrator over `api.*` calls.
function ProviderRoutesTabView(props) {
  const {
    rows, form, setForm, loading, error, busy,
    rowState, rotateBuf, setRotateBuf, rotateOpen, setRotateOpen,
    showKey, setShowKey, fallbackOptions, cycleAtName,
    ioBusy, importMsg,
    onSave, onCancel, onEdit, onDelete, onProbe, onRotate,
    onExport, onImport,
  } = props;
  return (
    <div className="card card-padded">
      <SectionTitle
        icon={<RouteIcon size={16} color="var(--accent)" />}
        title="Provider Routes"
        sub="Bundle protocol + endpoint + model + encrypted API key. Agent roles pin a route via routeId."
      />
      {error && (
        <div className="st-status-err st-agent-error">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      {/* B3.7 — workspace spend caps. Renders above the import/export
          bar so the most consequential setting is closest to the
          section title. */}
      <WorkspaceSpendCapsPanel />
      <ProviderRoutesIO
        onExport={onExport}
        onImport={onImport}
        busy={ioBusy}
        importMsg={importMsg}
      />
      <ProviderRoutesForm
        form={form}
        setForm={setForm}
        busy={busy}
        showKey={showKey}
        setShowKey={setShowKey}
        fallbackOptions={fallbackOptions}
        cycleAtName={cycleAtName}
        onSave={onSave}
        onCancel={onCancel}
      />
      {loading ? (
        <div className="text-sm text-muted st-pr-loading">Loading provider routes…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted st-pr-empty">
          No provider routes configured. Create one above — agent roles need a routeId to dispatch.
        </div>
      ) : (
        <div className="st-pr-rows">
          {rows.map((row) => (
            <ProviderRouteRow
              key={row.id}
              row={row}
              rows={rows}
              rowState={rowState[row.id]}
              rotateOpen={rotateOpen === row.id}
              setRotateOpen={setRotateOpen}
              rotateBuf={rotateBuf}
              setRotateBuf={setRotateBuf}
              onEdit={onEdit}
              onDelete={onDelete}
              onProbe={onProbe}
              onRotate={onRotate}
            />
          ))}
        </div>
      )}
      {/* B3.9 — audit log viewer at the bottom of the tab. Below the
          route list because admins read it last (after seeing the
          current state); above the next tab boundary so it stays
          discoverable without a separate menu entry. */}
      <AuditLogSubtab rows={rows} />
    </div>
  );
}

// B3.9 — Audit log viewer subtab. Renders below the route list inside
// the Provider Routes tab so admins can see every mutation in
// chronological order without leaving the page.
//
// Filters: action enum + free-form routeId. Pagination is cursor-based
// via `before` (matches the backend repo's keyset). The "Load more"
// button stays visible whenever the previous page returned `limit`
// rows — an empty page or a partial page hides it.
//
// `metadata` is a JSON string on the wire (per repo contract). We
// parse defensively per row so a malformed entry never blanks the
// whole list.
const AUDIT_ACTIONS = ["create", "update", "delete", "rotate_key", "probe", "export", "import"];
const AUDIT_PAGE_SIZE = 50;

function fmtAuditTimestamp(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return iso; }
}

function AuditLogSubtab({ rows: routeRows }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [filterRouteId, setFilterRouteId] = useState("");
  const [hasMore, setHasMore] = useState(false);

  // Build a routeId → name lookup so the table can render route names
  // instead of opaque `pr-...` ids. Falls back to the id when the
  // route has been deleted (audit rows survive route deletion by
  // design — the FK is nullable).
  const routeNameById = useMemo(() => {
    const m = new Map();
    for (const r of (routeRows || [])) m.set(r.id, r.name);
    return m;
  }, [routeRows]);

  const load = useCallback(async ({ before, append } = {}) => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listProviderRouteAudit({
        action: filterAction || undefined,
        routeId: filterRouteId || undefined,
        before: before || undefined,
        limit: AUDIT_PAGE_SIZE,
      });
      const next = res?.items || [];
      setItems((prev) => append ? [...prev, ...next] : next);
      setHasMore(next.length >= AUDIT_PAGE_SIZE);
    } catch (err) {
      setError(err.message || "Failed to load audit log.");
    } finally {
      setLoading(false);
    }
  }, [filterAction, filterRouteId]);

  // Reload when filters change. `load` is stable per-filter via
  // useCallback dependencies, so this fires exactly once per filter
  // edit.
  useEffect(() => { load({}); }, [load]);

  function loadMore() {
    if (!items.length) return;
    load({ before: items[items.length - 1].createdAt, append: true });
  }

  // Defensive metadata parse — repo stores JSON-as-string, but a
  // hand-edited row or a future schema change shouldn't blank the row.
  function renderMetadata(row) {
    if (!row.metadata) return "—";
    try {
      const obj = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      // Compact one-line summary for the most common audit shapes.
      // Full payload visible on hover via title.
      const summary = [];
      if (obj.changed && Array.isArray(obj.changed)) summary.push(`changed: ${obj.changed.join(", ")}`);
      if (obj.lastFour) summary.push(`lastFour: ${obj.lastFour}`);
      if (obj.reachable != null) summary.push(`reachable: ${obj.reachable}`);
      if (obj.errorReason) summary.push(`error: ${obj.errorReason}`);
      if (obj.count != null) summary.push(`count: ${obj.count}`);
      if (obj.mode) summary.push(`mode: ${obj.mode}`);
      const text = summary.length ? summary.join(" · ") : JSON.stringify(obj).slice(0, 80);
      return <span title={JSON.stringify(obj, null, 2)}>{text}</span>;
    } catch {
      return <span className="text-mono">{String(row.metadata).slice(0, 80)}</span>;
    }
  }

  return (
    <div className="card-padded-sm st-pr-audit-panel">
      <div className="font-semi st-pr-audit-title">
        <FileText size={13} /> Audit log
      </div>
      <div className="text-xs text-muted st-pr-audit-sub">
        Every mutation to provider routes (create / update / delete / rotate-key) plus reads with side effects (probe / export / import). Retention defaults to 90 days; tune via <code>SENTRI_AUDIT_RETENTION_DAYS</code>.
      </div>
      <div className="st-pr-audit-filters">
        <label className="st-pr-field">
          <span className="st-pr-field-label">Action</span>
          <select className="input" value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Route</span>
          <select className="input" value={filterRouteId} onChange={(e) => setFilterRouteId(e.target.value)}>
            <option value="">All routes</option>
            {(routeRows || []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <div className="st-status-err"><AlertCircle size={12} /> {error}</div>
      )}
      {loading && items.length === 0 ? (
        <div className="text-sm text-muted st-pr-audit-empty">Loading audit log…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted st-pr-audit-empty">
          No audit entries match the current filters.
        </div>
      ) : (
        <div className="st-pr-audit-table">
          {items.map((row) => (
            <div key={row.id} className="st-pr-audit-row">
              <span className="text-xs text-muted text-mono">{fmtAuditTimestamp(row.createdAt)}</span>
              <span className={`st-pr-badge st-pr-audit-action st-pr-audit-action--${row.action}`}>{row.action}</span>
              <span className="text-xs text-mono">{routeNameById.get(row.routeId) || row.routeId || "—"}</span>
              <span className="text-xs text-muted st-pr-audit-meta">{renderMetadata(row)}</span>
            </div>
          ))}
        </div>
      )}
      {hasMore && (
        <div className="st-pr-audit-actions">
          <button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loading}>
            {loading ? <RefreshCw size={13} className="spin" /> : null}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

// B3.7 — Workspace-level spend caps. Reads the workspace via
// `api.getWorkspace()` on mount, posts via `api.updateWorkspace()`
// with the three new B3.7 fields. Sits above the per-route form so
// admins see workspace-wide limits before per-route limits — the
// "blast radius" frames the conversation.
function WorkspaceSpendCapsPanel() {
  const [ws, setWs] = useState(null);
  const [draft, setDraft] = useState({ daily: "", monthly: "", threshold: 80 });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const w = await api.getWorkspace();
      setWs(w);
      setDraft({
        daily: w.dailySpendCapUsd ?? "",
        monthly: w.monthlySpendCapUsd ?? "",
        threshold: w.spendAlertThresholdPct ?? 80,
      });
    } catch (err) {
      setStatus({ type: "err", text: err.message || "Failed to load workspace." });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Coerce empty string → null (clear cap) so the backend receives the
  // explicit "no cap" sentinel, not a 400-rejected empty string.
  function valueOrNull(v) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const daily = valueOrNull(draft.daily);
      const monthly = valueOrNull(draft.monthly);
      if (Number.isNaN(daily)) throw new Error("Daily cap must be a non-negative number or empty.");
      if (Number.isNaN(monthly)) throw new Error("Monthly cap must be a non-negative number or empty.");
      const threshold = Number(draft.threshold);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
        throw new Error("Alert threshold must be between 0 and 100.");
      }
      await api.updateWorkspace({
        dailySpendCapUsd: daily,
        monthlySpendCapUsd: monthly,
        spendAlertThresholdPct: threshold,
      });
      setStatus({ type: "ok", text: "Spend caps updated." });
      await load();
    } catch (err) {
      setStatus({ type: "err", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (!ws) return null;

  return (
    <div className="card-padded-sm st-pr-spend-panel">
      <div className="font-semi st-pr-spend-title">
        <Activity size={13} /> Workspace spend caps
      </div>
      <div className="text-xs text-muted st-pr-spend-sub">
        Hard cap on AI cost per workspace. Leave a field empty for "unlimited".
        The dispatcher rejects new calls with <code>ERR_SPEND_CAP_EXCEEDED</code>
        once the cap is reached, and emits a warning when spend crosses the alert threshold.
      </div>
      <div className="st-pr-spend-grid">
        <label className="st-pr-field">
          <span className="st-pr-field-label">Daily cap (USD)</span>
          <input
            className="input" type="number" min={0} step="0.01"
            value={draft.daily}
            onChange={(e) => setDraft((s) => ({ ...s, daily: e.target.value }))}
            placeholder="—"
          />
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Monthly cap (USD)</span>
          <input
            className="input" type="number" min={0} step="0.01"
            value={draft.monthly}
            onChange={(e) => setDraft((s) => ({ ...s, monthly: e.target.value }))}
            placeholder="—"
          />
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Alert at (% of cap)</span>
          <input
            className="input" type="number" min={0} max={100}
            value={draft.threshold}
            onChange={(e) => setDraft((s) => ({ ...s, threshold: e.target.value }))}
          />
        </label>
      </div>
      <div className="st-pr-spend-actions">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
          {busy ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
          Save caps
        </button>
        {status && (
          <span className={status.type === "ok" ? "st-status-ok" : "st-status-err"}>
            {status.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {status.text}
          </span>
        )}
      </div>
    </div>
  );
}

// B3.5 — Export/import action bar. Rendered above the form so admins
// can bulk-move routes between workspaces without scrolling past the
// per-row list. Mode selector defaults to "skip" — the safest option
// when re-importing into a workspace that already has routes (no
// existing data is touched). The file input is rendered hidden + driven
// by a button click so the styling matches the rest of the action bar.
function ProviderRoutesIO({ onExport, onImport, busy, importMsg }) {
  const fileRef = useRef(null);
  const [mode, setMode] = useState("skip");
  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    onImport(file, mode);
    // Reset so re-selecting the same file fires onChange again. Without
    // this, importing the same file twice in a row silently no-ops.
    e.target.value = "";
  }
  return (
    <div className="st-pr-io-bar">
      <div className="st-pr-io-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onExport}
          disabled={busy}
          title="Download every provider route in this workspace as a schema-v1 JSON file. Secrets are never included."
        >
          <Download size={13} /> Export
        </button>
        <label className="st-pr-io-mode">
          <span className="text-xs text-muted">On collision</span>
          <select
            className="input st-pr-io-mode-select"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            disabled={busy}
          >
            <option value="skip">Skip existing</option>
            <option value="overwrite">Overwrite by name</option>
            <option value="rename">Rename (append -2, -3, …)</option>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Upload a schema-v1 JSON file to upsert routes into this workspace. Each imported route is re-probed; you'll still need to supply API keys via Rotate key."
        >
          <UploadIcon size={13} /> Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFileChange}
          className="st-pr-io-file"
        />
      </div>
      {importMsg && (
        <div className={importMsg.type === "ok" ? "st-status-ok" : "st-status-err"}>
          {importMsg.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {importMsg.text}
        </div>
      )}
    </div>
  );
}

function ProviderRoutesTab() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(PR_FORM_EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // B3.5 — Separate busy flag for export/import so the per-row CRUD
  // form isn't disabled while a probe sweep is running.
  const [ioBusy, setIoBusy] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  // Per-row in-flight state keyed by route id. Entries are one of:
  //   { kind: "probing" } | { kind: "rotating" } | { kind: "deleting" }
  //   | { kind: "ok", caps?: object, lastFour?: string }
  //   | { kind: "err", msg: string }
  // Scoped per-row so probing route A doesn't grey out route B's actions.
  const [rowState, setRowState] = useState({});
  // Plaintext key buffer for the rotate-key inline form, per row. Never
  // mirrored into `rows` — only used at submit time.
  const [rotateBuf, setRotateBuf] = useState({});
  // Which row's rotate panel is open. Closing the panel clears the
  // plaintext buffer so a partially-typed key doesn't linger in memory.
  const [rotateOpen, setRotateOpen] = useState(null);
  // apiKey visibility toggle on the create+edit form.
  const [showKey, setShowKey] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listProviderRoutes();
      setRows(res?.routes || []);
    } catch (err) {
      setError(err.message || "Failed to load provider routes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setForm(PR_FORM_EMPTY);
    setError("");
    setShowKey(false);
  }

  // Normalise the form payload before sending. The form keeps numeric
  // fields as strings so empty inputs round-trip cleanly; here we coerce
  // to `Number | null` so the backend doesn't receive "" for an INTEGER
  // column. Empty `baseUrl` collapses to `null` so non-default endpoints
  // can be cleared without leaving a sentinel "".
  function buildPayload(src) {
    const numOrNull = (v) => {
      if (v === "" || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const payload = {
      name: src.name.trim(),
      family: src.family,
      protocol: src.protocol,
      baseUrl: src.baseUrl.trim() || null,
      model: src.model.trim(),
      enabled: !!src.enabled,
      rpmLimit: numOrNull(src.rpmLimit),
      tpmLimit: numOrNull(src.tpmLimit),
      cacheEnabled: !!src.cacheEnabled,
      cacheTtlSec: numOrNull(src.cacheTtlSec) ?? 0,
      fallbackRouteId: src.fallbackRouteId || null,
    };
    // Only send `apiKey` when the admin actually typed one. Editing a
    // row without retyping the key MUST leave the stored ciphertext
    // untouched — rotation goes through a separate endpoint that audits
    // with `action: "rotate_key"` and bumps the breaker.
    if (src.apiKey && src.apiKey.trim()) payload.apiKey = src.apiKey.trim();
    return payload;
  }

  async function save(e) {
    e.preventDefault();
    setError("");
    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!form.model.trim()) { setError("Model is required."); return; }
    setBusy(true);
    try {
      const payload = buildPayload(form);
      if (form.id) await api.updateProviderRoute(form.id, payload);
      else await api.createProviderRoute(payload);
      resetForm();
      await load();
    } catch (err) {
      setError(err.message || "Failed to save provider route.");
    } finally {
      setBusy(false);
    }
  }

  function edit(row) {
    setError("");
    setForm({
      id: row.id,
      name: row.name || "",
      family: row.family || "openai",
      protocol: row.protocol || "openai",
      baseUrl: row.baseUrl || "",
      model: row.model || "",
      // Never prefill apiKey — the repo doesn't return the ciphertext
      // to list reads (B1.4), and we don't want the input to pretend it
      // has a stored value the user could accidentally clobber.
      apiKey: "",
      enabled: row.enabled === 1 || row.enabled === true,
      rpmLimit: row.rpmLimit ?? "",
      tpmLimit: row.tpmLimit ?? "",
      cacheEnabled: row.cacheEnabled === 1 || row.cacheEnabled === true,
      cacheTtlSec: row.cacheTtlSec ?? "",
      fallbackRouteId: row.fallbackRouteId || "",
    });
  }

  async function probe(id) {
    setRowState((s) => ({ ...s, [id]: { kind: "probing" } }));
    try {
      const res = await api.probeProviderRoute(id);
      setRowState((s) => ({ ...s, [id]: { kind: "ok", caps: res.capabilities } }));
      // Refetch the list so the persisted capabilities (stamped on the
      // row by the backend) replace the live override on the next render.
      // Not awaited — the badge already updated from `live` and the
      // refetch is opportunistic.
      load();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message || "probe_failed" } }));
    }
  }

  async function rotate(id) {
    const key = (rotateBuf[id] || "").trim();
    if (!key) return;
    setRowState((s) => ({ ...s, [id]: { kind: "rotating" } }));
    try {
      const res = await api.rotateProviderRouteKey(id, key);
      setRowState((s) => ({ ...s, [id]: { kind: "ok", lastFour: res?.lastFour } }));
      setRotateBuf((b) => { const n = { ...b }; delete n[id]; return n; });
      setRotateOpen(null);
      await load();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message || "rotate_failed" } }));
    }
  }

  async function del(id) {
    if (!window.confirm("Delete this provider route? Agent roles pinned to it will fall back to env detection.")) return;
    setRowState((s) => ({ ...s, [id]: { kind: "deleting" } }));
    try {
      await api.deleteProviderRoute(id);
      if (form.id === id) resetForm();
      await load();
      setRowState((s) => { const n = { ...s }; delete n[id]; return n; });
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message || "delete_failed" } }));
    }
  }

  // B3.5 — Export handler. Triggers a Blob download via `api.exportRoutes`
  // (the helper handles cross-origin + Content-Disposition); inline
  // status message confirms the count so the operator knows they didn't
  // accidentally download an empty workspace dump.
  async function exportRoutes() {
    setIoBusy(true);
    setImportMsg(null);
    try {
      const payload = await api.exportRoutes();
      const count = payload?.routes?.length ?? 0;
      setImportMsg({ type: "ok", text: `Exported ${count} route(s).` });
    } catch (err) {
      setImportMsg({ type: "err", text: err.message || "Export failed." });
    } finally {
      setIoBusy(false);
    }
  }

  // B3.5 — Import handler. Reads the file, posts the payload + mode,
  // refreshes the list, and surfaces the per-mode stats inline so the
  // operator can confirm the apply matched their intent. Errors in
  // individual rows (returned via the response's `errors` array) are
  // summarised in the status message; the full per-row error list is
  // dropped to the console for debugging.
  async function importRoutes(file, mode) {
    setIoBusy(true);
    setImportMsg(null);
    try {
      const res = await api.importRoutes(file, mode);
      await load();
      const parts = [];
      if (res.created) parts.push(`${res.created} created`);
      if (res.overwritten) parts.push(`${res.overwritten} overwritten`);
      if (res.renamed) parts.push(`${res.renamed} renamed`);
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      if (res.errors?.length) {
        // Surface count inline + dump details to the console so the
        // operator can see WHICH rows failed without us blowing up the
        // UI with a multi-line error list. (A dedicated import-result
        // modal is the right long-term home for this; the console
        // is the cheap version.)
        parts.push(`${res.errors.length} error${res.errors.length === 1 ? "" : "s"}`);
        // eslint-disable-next-line no-console
        console.warn("[Provider Routes import] errors:", res.errors);
      }
      setImportMsg({
        type: res.errors?.length ? "err" : "ok",
        text: parts.length ? parts.join(" · ") : "No changes applied.",
      });
    } catch (err) {
      setImportMsg({ type: "err", text: err.message || "Import failed." });
    } finally {
      setIoBusy(false);
    }
  }

  // Fallback dropdown options — exclude the row being edited so the UI
  // can't offer a self-loop. The repo's `wouldCreateCycle` catches
  // longer cycles server-side, so this is a UX nicety, not a security
  // boundary.
  const fallbackOptions = rows.filter((r) => r.id !== form.id);

  // B3.2 — Run the client-side cycle check on every keystroke against the
  // current `form.fallbackRouteId`. `cycleAt` is the routeId where the
  // walk loops (or `null` when no cycle). Passed to the view so the
  // form can render an inline warning + disable save without round-
  // tripping through the backend's `ERR_ROUTE_FALLBACK_CYCLE`.
  const cycleAt = detectFallbackCycle(rows, form.id, form.fallbackRouteId);
  const cycleAtName = cycleAt ? (rows.find((r) => r.id === cycleAt)?.name || cycleAt) : null;

  return <ProviderRoutesTabView
    rows={rows}
    form={form}
    setForm={setForm}
    loading={loading}
    error={error}
    busy={busy}
    rowState={rowState}
    rotateBuf={rotateBuf}
    setRotateBuf={setRotateBuf}
    rotateOpen={rotateOpen}
    setRotateOpen={setRotateOpen}
    showKey={showKey}
    setShowKey={setShowKey}
    fallbackOptions={fallbackOptions}
    cycleAtName={cycleAtName}
    ioBusy={ioBusy}
    importMsg={importMsg}
    onSave={save}
    onCancel={resetForm}
    onEdit={edit}
    onDelete={del}
    onProbe={probe}
    onRotate={rotate}
    onExport={exportRoutes}
    onImport={importRoutes}
  />;
}

// ── Members tab (ACL-002) ─────────────────────────────────────────────────────

const ROLE_OPTIONS = [
  { value: "admin",   label: "Admin",   desc: "Full access — manage members, settings, and all data" },
  { value: "qa_lead", label: "QA Lead", desc: "Create, edit, run, and delete tests and projects" },
  { value: "viewer",  label: "Viewer",  desc: "Read-only access to all data" },
];

function MembersTab() {
  const { user } = useAuth();
  const [error, setError]         = useState(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole]   = useState("viewer");
  const [inviting, setInviting]   = useState(false);
  const [inviteMsg, setInviteMsg] = useState(null);

  const membersQuery = useMembersQuery();

  const members = membersQuery.data || [];
  const loading = membersQuery.isLoading;

  const load = useCallback(() => membersQuery.refetch(), [membersQuery]);

  // Display query and mutation errors in the same banner. Query errors come
  // straight from the query (auto-clear when the query recovers); mutation
  // errors live in `error` state set by the action handlers below.
  const displayError = error || membersQuery.error?.message || null;

  async function handleInvite(e) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteMsg(null);
    try {
      await api.inviteMember({ email: inviteEmail.trim().toLowerCase(), role: inviteRole });
      setInviteEmail("");
      setInviteRole("viewer");
      setInviteMsg({ type: "ok", text: "Member invited successfully." });
      await load();
    } catch (err) {
      setInviteMsg({ type: "err", text: err.message });
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(userId, role) {
    try {
      await api.updateMemberRole(userId, role);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRemove(userId, name) {
    if (!window.confirm(`Remove ${name} from this workspace?`)) return;
    try {
      await api.removeMember(userId);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return (
    <div className="text-sm text-muted" style={{ padding: "32px 0", textAlign: "center" }}>
      Loading members…
    </div>
  );

  return (
    <div className="flex-col gap-lg">
      <SectionTitle
        icon={<Users size={16} color="var(--accent)" />}
        title="Workspace Members"
        sub={`${members.length} member${members.length !== 1 ? "s" : ""}`}
      />

      {displayError && (
        <div className="card card-padded" style={{ borderColor: "var(--danger)", color: "var(--danger)", display: "flex", gap: 8, alignItems: "center" }}>
          <AlertCircle size={15} /> {displayError}
        </div>
      )}

      {/* Invite form */}
      <form onSubmit={handleInvite} className="card card-padded" style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 180 }}>
          <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>
            <UserPlus size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />
            Invite by email
          </label>
          <input
            className="input"
            type="email"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
            placeholder="colleague@company.com"
            style={{ height: 36, fontSize: "0.85rem" }}
            required
          />
        </div>
        <div style={{ flex: "0 0 130px" }}>
          <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>
            Role
          </label>
          <select
            className="input"
            value={inviteRole}
            onChange={e => setInviteRole(e.target.value)}
            style={{ height: 36, fontSize: "0.85rem" }}
          >
            {ROLE_OPTIONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary btn-sm" type="submit" disabled={inviting || !inviteEmail.trim()} style={{ height: 36 }}>
          {inviting ? <RefreshCw size={13} className="spin" /> : <UserPlus size={13} />}
          Invite
        </button>
      </form>
      {inviteMsg && (
        <div className={inviteMsg.type === "ok" ? "st-status-ok" : "st-status-err"}>
          {inviteMsg.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {inviteMsg.text}
        </div>
      )}

      {/* Member list */}
      <div className="flex-col gap-xs">
        {members.map(m => {
          const isCurrentUser = m.userId === user?.id;
          return (
            <div key={m.userId} className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
              {/* Avatar / initial */}
              <div style={{
                width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
                background: "var(--bg3)", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "0.82rem", fontWeight: 700, color: "var(--text2)",
                overflow: "hidden",
              }}>
                {m.avatar
                  ? <img src={m.avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : (m.name || m.email || "?").charAt(0).toUpperCase()}
              </div>

              {/* Name + email */}
              <div className="flex-1" style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="font-semi text-sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.name || m.email}
                  </span>
                  {isCurrentUser && (
                    <span className="badge" style={{ fontSize: "0.65rem", padding: "1px 6px" }}>You</span>
                  )}
                  {m.role === "admin" && (
                    <Crown size={12} color="var(--amber)" title="Admin" />
                  )}
                </div>
                <div className="text-xs text-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.email}
                </div>
              </div>

              {/* Role selector */}
              <select
                className="input"
                value={m.role}
                onChange={e => handleRoleChange(m.userId, e.target.value)}
                disabled={isCurrentUser}
                style={{ width: 110, height: 32, fontSize: "0.8rem", flexShrink: 0 }}
                title={isCurrentUser ? "You cannot change your own role" : `Change role for ${m.name || m.email}`}
              >
                {ROLE_OPTIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>

              {/* Remove button */}
              <button
                className="btn btn-ghost btn-xs"
                style={{ color: "var(--text3)", flexShrink: 0 }}
                onClick={() => handleRemove(m.userId, m.name || m.email)}
                disabled={isCurrentUser}
                title={isCurrentUser ? "You cannot remove yourself" : `Remove ${m.name || m.email}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Role legend */}
      <div className="card card-padded" style={{ background: "var(--bg3)" }}>
        <div className="font-semi text-xs" style={{ marginBottom: 10, color: "var(--text2)" }}>Role permissions</div>
        <div className="flex-col gap-xs">
          {ROLE_OPTIONS.map(r => (
            <div key={r.value} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <span className="text-sm font-semi" style={{ width: 70, flexShrink: 0 }}>{r.label}</span>
              <span className="text-xs text-muted">{r.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Recycle Bin helpers ────────────────────────────────────────────────────────

function fmtDeletedDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function RecycleBinSection({ title, icon, items, type, nameKey = "name", subKey = null, busy, onRestore, onPurge }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-xs text-muted font-semi" style={{ marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {icon} {title} ({items.length})
      </div>
      <div className="flex-col gap-xs">
        {items.map(item => {
          const key = `${type}:${item.id}`;
          const busyState = busy[key];
          return (
            <div key={item.id} className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
              <div className="flex-1" style={{ minWidth: 0 }}>
                <div className="text-sm font-semi" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item[nameKey] || item.id}
                </div>
                {subKey && item[subKey] && (
                  <div className="text-xs text-muted" style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item[subKey]}
                  </div>
                )}
                <div className="text-xs text-muted" style={{ marginTop: 2 }}>
                  Deleted {fmtDeletedDate(item.deletedAt)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button
                  className="btn btn-ghost btn-xs"
                  disabled={!!busyState}
                  onClick={() => onRestore(type, item.id)}
                  title="Restore"
                  aria-label={`Restore ${item[nameKey] || item.id}`}
                >
                  {busyState === "restore" ? <RefreshCw size={11} className="spin" /> : <RotateCcw size={11} />}
                  Restore
                </button>
                <button
                  className="btn btn-danger btn-xs"
                  disabled={!!busyState}
                  onClick={() => onPurge(type, item.id, item[nameKey] || item.id)}
                  title="Permanently delete"
                  aria-label={`Permanently delete ${item[nameKey] || item.id}`}
                >
                  {busyState === "purge" ? <RefreshCw size={11} className="spin" /> : <Trash2 size={11} />}
                  Purge
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Recycle Bin tab ───────────────────────────────────────────────────────────
function RecycleBinTab() {
  const [busy, setBusy]         = useState({});
  const [error, setError]       = useState(null);

  const recycleQuery = useRecycleBinQuery();

  const data = recycleQuery.data ?? null;
  const loading = recycleQuery.isLoading;

  const load = useCallback(() => recycleQuery.refetch(), [recycleQuery]);

  // Display query and mutation errors in the same banner. Query errors come
  // straight from the query (auto-clear when the query recovers); mutation
  // errors live in `error` state set by the action handlers below.
  const displayError = error || recycleQuery.error?.message || null;

  async function handleRestore(type, id) {
    setError(null);
    setBusy(b => ({ ...b, [`${type}:${id}`]: "restore" }));
    try {
      await api.restoreItem(type, id);
      await load();
    } catch (e) {
      setError(e.message || "Restore failed");
    } finally {
      setBusy(b => { const n = { ...b }; delete n[`${type}:${id}`]; return n; });
    }
  }

  async function handlePurge(type, id, name) {
    if (!window.confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
    setError(null);
    setBusy(b => ({ ...b, [`${type}:${id}`]: "purge" }));
    try {
      await api.purgeItem(type, id);
      await load();
    } catch (e) {
      setError(e.message || "Purge failed");
    } finally {
      setBusy(b => { const n = { ...b }; delete n[`${type}:${id}`]; return n; });
    }
  }

  const total = data ? (data.projects.length + data.tests.length + data.runs.length) : 0;

  if (loading) return (
    <div className="text-sm text-muted" style={{ padding: "32px 0", textAlign: "center" }}>
      Loading recycle bin…
    </div>
  );

  if (displayError) return (
    <div className="card card-padded" style={{ borderColor: "var(--danger)", color: "var(--danger)", display: "flex", gap: 8, alignItems: "center" }}>
      <AlertCircle size={15} /> {displayError}
    </div>
  );

  return (
    <div className="flex-col gap-lg">
      <SectionTitle
        icon={<Trash2 size={16} color="var(--amber)" />}
        title="Recycle Bin"
        sub={total === 0 ? "No deleted items" : `${total} deleted item${total !== 1 ? "s" : ""} — restore or permanently purge`}
      />
      {total === 0 ? (
        <div className="card card-padded" style={{ textAlign: "center", color: "var(--text-muted)" }}>
          <div style={{ fontSize: "2rem", marginBottom: 8 }}>🗑️</div>
          <div className="text-sm">The recycle bin is empty.</div>
          <div className="text-xs text-muted" style={{ marginTop: 4 }}>
            Deleted tests, projects, and runs will appear here.
          </div>
        </div>
      ) : (
        <div className="flex-col gap-lg">
          <RecycleBinSection
            title="Projects"
            icon={<FolderOpen size={12} style={{ display: "inline", marginRight: 4 }} />}
            items={data.projects}
            type="project"
            nameKey="name"
            subKey="url"
            busy={busy}
            onRestore={handleRestore}
            onPurge={handlePurge}
          />
          <RecycleBinSection
            title="Tests"
            icon={<FileText size={12} style={{ display: "inline", marginRight: 4 }} />}
            items={data.tests}
            type="test"
            nameKey="name"
            subKey="description"
            busy={busy}
            onRestore={handleRestore}
            onPurge={handlePurge}
          />
          <RecycleBinSection
            title="Runs"
            icon={<Play size={12} style={{ display: "inline", marginRight: 4 }} />}
            items={data.runs}
            type="run"
            nameKey="id"
            subKey="type"
            busy={busy}
            onRestore={handleRestore}
            onPurge={handlePurge}
          />
        </div>
      )}
    </div>
  );
}

// ── Security tab (SEC-004: MFA / passkeys / workspace enforcement) ──────────

/**
 * One-time display of freshly minted recovery codes. Renders a download
 * button + clipboard copy + an "I've saved them" dismiss so the user can
 * never see them again. Codes are NEVER persisted on the client.
 *
 * @param {Object}   props
 * @param {string[]} props.codes
 * @param {string}   props.userEmail - Used in the download filename.
 * @param {Function} props.onDismiss
 */
function RecoveryCodesPanel({ codes, userEmail, onDismiss }) {
  const [confirmed, setConfirmed] = useState(false);

  function handleDownload() {
    const body = [
      "Sentri MFA recovery codes",
      "================================",
      `Account: ${userEmail}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "Each code can be used once. Store them somewhere safe.",
      "",
      ...codes,
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sentri-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function handleCopy() {
    navigator.clipboard?.writeText(codes.join("\n")).catch(() => { /* user denied clipboard */ });
  }

  return (
    <div className="card card-padded recovery-panel">
      <div className="recovery-panel__header">
        <AlertTriangle size={18} color="var(--amber)" className="shrink-0 recovery-panel__icon" />
        <div>
          <div className="font-bold recovery-panel__title">Save these recovery codes now</div>
          <div className="text-xs text-muted recovery-panel__hint">
            Each code can be used once to sign in if you lose your authenticator. They will not be shown again.
          </div>
        </div>
      </div>
      <div className="text-mono text-sm recovery-panel__grid">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="recovery-panel__actions">
        <button className="btn btn-ghost btn-sm" onClick={handleDownload}>
          <Download size={13} /> Download .txt
        </button>
        <button className="btn btn-ghost btn-sm" onClick={handleCopy}>
          <FileText size={13} /> Copy
        </button>
        <label className="text-xs text-muted recovery-panel__confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I've saved them
        </label>
        <button className="btn btn-primary btn-sm" disabled={!confirmed} onClick={onDismiss}>
          <Check size={13} /> Done
        </button>
      </div>
    </div>
  );
}

/**
 * Small inline modal with a password input. Used to confirm sensitive
 * actions (disable MFA, regenerate recovery codes, remove a passkey).
 * OAuth-only users have no password — caller skips this modal entirely.
 */
function PasswordConfirmModal({ title, description, busy, error, onConfirm, onCancel }) {
  const [password, setPassword] = useState("");
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onCancel(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwd-modal-title"
      className="pwd-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        className="card card-padded pwd-modal"
        onSubmit={(e) => { e.preventDefault(); onConfirm(password); }}
      >
        <h3 id="pwd-modal-title" className="pwd-modal__title">{title}</h3>
        {description && <p className="text-sm text-muted pwd-modal__desc">{description}</p>}
        <label className="text-sm font-semi pwd-modal__label">
          Password
          <input
            ref={inputRef}
            className="input pwd-modal__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && (
          <div className="st-status-err pwd-modal__error">
            <AlertCircle size={12} /> {error}
          </div>
        )}
        <div className="pwd-modal__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !password.trim()}>
            {busy ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Render the otpauth URL as a scannable QR via api.qrserver.com (no auth /
 * no rate limit on small images, zero JS dependency). Falls back to the raw
 * base32 secret for users who can't scan.
 */
function TotpEnrollmentPanel({ enrollment, onEnable, onCancel, busy, error }) {
  const [token, setToken] = useState("");
  const qrUrl = enrollment?.otpauth
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(enrollment.otpauth)}`
    : null;

  return (
    <form
      className="card card-padded flex-col gap-md totp-enroll"
      onSubmit={(e) => { e.preventDefault(); onEnable(token); }}
    >
      <div className="font-bold">Scan with your authenticator app</div>
      <div className="text-sm text-muted">
        Use Google Authenticator, 1Password, Authy, or any TOTP-compatible app.
      </div>
      {qrUrl && (
        <div className="totp-enroll__qr-wrap">
          <img
            src={qrUrl}
            width="200"
            height="200"
            alt="MFA QR code — scan with your authenticator app"
            className="totp-enroll__qr"
          />
        </div>
      )}
      <div>
        <div className="text-xs text-muted totp-enroll__secret-label">
          Or enter this secret manually:
        </div>
        <div className="text-mono text-sm totp-enroll__secret">
          {enrollment?.secret}
        </div>
      </div>
      <label className="text-sm font-semi">
        6-digit code from your app
        <input
          className="input totp-enroll__code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={token}
          onChange={(e) => setToken(e.target.value.replace(/[^\d]/g, ""))}
          placeholder="123456"
          required
        />
      </label>
      {error && (
        <div className="st-status-err">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      <div className="totp-enroll__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || token.length < 6}>
          {busy ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
          Verify &amp; enable
        </button>
      </div>
    </form>
  );
}

/**
 * Main Security tab — TOTP, recovery codes, passkeys, and (for admins)
 * workspace enforcement. Loads factor state on mount via `api.mfaFactors()`
 * and refetches after every mutation.
 */
function SecurityTab() {
  // eslint-disable-next-line no-use-before-define
  return <SecurityTabInner />;
}

/**
 * Admin-only workspace enforcement panel. Toggles `mfaRequired` + grace
 * period, with a live compliance preview so the admin knows how many
 * members would be impacted at grace=0.
 */
function WorkspaceMfaPolicyPanel() {
  const [ws, setWs] = useState(null);
  const [compliance, setCompliance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftGrace, setDraftGrace] = useState(7);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [wsRes, compRes] = await Promise.all([
        api.getWorkspace(),
        api.getWorkspaceMfaCompliance(),
      ]);
      setWs(wsRes);
      setCompliance(compRes);
      setDraftEnabled(wsRes.mfaRequired === 1);
      setDraftGrace(wsRes.mfaGracePeriodDays ?? 7);
    } catch (err) {
      setStatus({ type: "err", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty = ws && (
    (draftEnabled ? 1 : 0) !== (ws.mfaRequired || 0) ||
    Number(draftGrace) !== Number(ws.mfaGracePeriodDays ?? 7)
  );

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await api.updateWorkspace({
        mfaRequired: draftEnabled ? 1 : 0,
        mfaGracePeriodDays: Number(draftGrace),
      });
      setStatus({ type: "ok", text: "Workspace MFA policy updated." });
      await load();
    } catch (err) {
      setStatus({ type: "err", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return (
    <div className="text-sm text-muted" style={{ padding: "16px 0" }}>Loading workspace policy…</div>
  );

  return (
    <div className="card card-padded flex-col gap-md">
      <div className="font-bold" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Crown size={14} color="var(--amber)" /> Workspace enforcement
      </div>
      <div className="text-sm text-muted">
        Require all members of this workspace to enable MFA before signing in.
        New members get the grace window before they are blocked.
      </div>

      {compliance && (
        <div className="card-padded-sm ws-enforce__compliance">
          <div className="text-xs text-muted font-semi ws-enforce__compliance-title">
            Current enrollment
          </div>
          <div className="text-sm">
            <strong>{compliance.enrolled}</strong> of {compliance.totalMembers} members have MFA enabled.
            {compliance.notEnrolled > 0 && (
              <span className="text-muted" style={{ marginLeft: 6 }}>
                {compliance.notEnrolled} would be impacted at grace = 0.
              </span>
            )}
          </div>
        </div>
      )}

      <label className="text-sm" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={draftEnabled}
          onChange={(e) => setDraftEnabled(e.target.checked)}
        />
        Require MFA for all workspace members
      </label>

      <label className="text-sm font-semi mfa-label">
        Grace period (days)
        <input
          className="input ws-enforce__grace-input"
          type="number"
          min={0}
          max={90}
          value={draftGrace}
          onChange={(e) => setDraftGrace(e.target.value)}
          disabled={!draftEnabled}
        />
        <div className="hint ws-enforce__grace-hint">
          Members have this many days from when the policy is enabled (or from
          when they join) to enroll before they are blocked at login.
        </div>
      </label>

      {status && (
        <div className={status.type === "ok" ? "st-status-ok" : "st-status-err"}>
          {status.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {status.text}
        </div>
      )}

      <div>
        <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
          Save policy
        </button>
      </div>
    </div>
  );
}

function SecurityTabInner() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.workspaceRole === "admin";
  // OAuth-only users have no password — destructive actions skip the modal
  // entirely (the OAuth session itself proves identity, matching backend
  // `verifyAccountPassword` semantics).
  const needsPassword = user?.hasPassword !== false;

  const [factors, setFactors] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [enrollment, setEnrollment] = useState(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollErr, setEnrollErr] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  // Pending destructive action awaiting password confirmation. Shape:
  //   { kind: "disable" } | { kind: "regenerate" } | { kind: "removePasskey", credentialId }
  const [pendingAction, setPendingAction] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  // SEC-004: When recovery codes are regenerated, the backend revokes the
  // current session AND we still need to show the new codes one final time.
  // This flag tells the RecoveryCodesPanel.onDismiss handler to chain
  // logout+redirect after the user confirms they've saved the codes.
  const [sessionRevokedPending, setSessionRevokedPending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.mfaFactors();
      setFactors(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleStartEnroll() {
    setEnrollBusy(true);
    setEnrollErr(null);
    try {
      const data = await api.mfaEnroll();
      setEnrollment(data);
    } catch (err) {
      setEnrollErr(err.message);
    } finally {
      setEnrollBusy(false);
    }
  }

  async function handleVerifyEnroll(token) {
    setEnrollBusy(true);
    setEnrollErr(null);
    try {
      const data = await api.mfaEnable(token);
      setRecoveryCodes(data.recoveryCodes);
      setEnrollment(null);
      // SEC-004: clear the grace-period banner — the user is now enrolled
      // so the workspace enforcement check will pass on next login. The
      // banner re-checks sessionStorage on window focus.
      try { sessionStorage.removeItem("mfa_grace_banner"); } catch { /* unavailable */ }
      await load();
    } catch (err) {
      setEnrollErr(err.message);
    } finally {
      setEnrollBusy(false);
    }
  }

  const runAction = useCallback(async (action, password) => {
    setActionBusy(true);
    setActionErr(null);
    try {
      // SEC-004: All three destructive actions revoke the current session on
      // the backend (see `_internalRevokeCurrentSession` in routes/auth.js +
      // routes/webauthn.js). The response carries `sessionRevoked: true` so
      // we know to redirect to /login instead of refetching factor state on
      // a now-invalid cookie. Matches the industry baseline (Auth0, Clerk,
      // Okta, GitHub) — security-posture changes terminate the session.
      let response;
      if (action.kind === "disable") {
        response = await api.mfaDisable(needsPassword ? password : "");
      } else if (action.kind === "regenerate") {
        response = await api.mfaRegenerateRecoveryCodes(needsPassword ? password : "");
        // Show the new codes one last time before the session ends — the
        // recovery panel has its own "I've saved them" gate. The user can
        // download / copy before they're forced out.
        setRecoveryCodes(response.recoveryCodes);
      } else if (action.kind === "removePasskey") {
        response = await api.webauthnDeleteCredential(action.credentialId, needsPassword ? password : "");
      }
      setPendingAction(null);

      if (response?.sessionRevoked) {
        // For regenerate, defer the redirect until the user dismisses the
        // recovery-codes panel — otherwise we'd kick them out before they can
        // save the codes. The other two actions have no follow-up UI.
        if (action.kind === "regenerate") {
          // Stash a flag the RecoveryCodesPanel.onDismiss handler reads to
          // chain the logout+redirect after the user confirms they saved.
          setSessionRevokedPending(true);
        } else {
          await logout();
          navigate("/login", {
            state: { notice: "Your session was ended for security. Please sign in again." },
          });
        }
        return;
      }

      await load();
    } catch (err) {
      setActionErr(err.message);
    } finally {
      setActionBusy(false);
    }
  }, [needsPassword, load, logout, navigate]);

  // OAuth-only path: no password modal — run the action immediately.
  useEffect(() => {
    if (!pendingAction || needsPassword) return;
    runAction(pendingAction, "");
  }, [pendingAction, needsPassword, runAction]);

  async function handleAddPasskey() {
    setError(null);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options, challengeToken } = await api.webauthnRegisterOptions();
      // SimpleWebAuthn v11 takes `{ optionsJSON }`; v10 takes the options
      // object directly. Try v11 first, fall back to v10 on TypeError.
      let attestation;
      try {
        attestation = await startRegistration({ optionsJSON: options });
      } catch (e) {
        if (e?.name === "TypeError") attestation = await startRegistration(options);
        else throw e;
      }
      const deviceName = window.prompt("Name this passkey (e.g. \"YubiKey\", \"iPhone\"):", "")?.slice(0, 80) || null;
      await api.webauthnRegisterVerify(challengeToken, attestation, deviceName);
      // SEC-004: passkey counts as a second factor — clear the grace banner.
      try { sessionStorage.removeItem("mfa_grace_banner"); } catch { /* unavailable */ }
      await load();
    } catch (err) {
      const msg = err?.name === "NotAllowedError"
        ? "Passkey enrollment was cancelled or denied by the browser."
        : err.message;
      setError(msg);
    }
  }

  if (loading) return (
    <div className="text-sm text-muted" style={{ padding: "32px 0", textAlign: "center" }}>
      Loading security settings…
    </div>
  );

  const totpEnabled = factors?.totp === true;
  const passkeys = factors?.webauthn || [];

  return (
    <div className="flex-col gap-lg">
      <SectionTitle
        icon={<Shield size={16} color="var(--accent)" />}
        title="Security"
        sub="Multi-factor authentication, passkeys, and workspace policy"
      />

      {error && (
        <div className="card card-padded" style={{ borderColor: "var(--danger)", color: "var(--danger)", display: "flex", gap: 8, alignItems: "center" }}>
          <AlertCircle size={15} /> {error}
        </div>
      )}

      {recoveryCodes && (
        <RecoveryCodesPanel
          codes={recoveryCodes}
          userEmail={user?.email || "account"}
          onDismiss={async () => {
            setRecoveryCodes(null);
            // SEC-004: if regenerate revoked the session, complete the
            // logout chain now that the user has confirmed they saved the
            // new codes. Without this, the next API call would 401 with
            // no explanation.
            if (sessionRevokedPending) {
              setSessionRevokedPending(false);
              await logout();
              navigate("/login", {
                state: { notice: "Your session was ended for security. Please sign in again." },
              });
            }
          }}
        />
      )}

      {enrollment ? (
        <TotpEnrollmentPanel
          enrollment={enrollment}
          onEnable={handleVerifyEnroll}
          onCancel={() => { setEnrollment(null); setEnrollErr(null); }}
          busy={enrollBusy}
          error={enrollErr}
        />
      ) : (
        <div className="card card-padded flex-col gap-md">
          <div className="factor-row">
            <Smartphone size={18} color={totpEnabled ? "var(--green)" : "var(--text3)"} />
            <div className="factor-row__info">
              <div className="font-bold">Authenticator app (TOTP)</div>
              <div className="text-xs text-muted factor-row__sub">
                {totpEnabled
                  ? `Enabled · ${factors.recoveryCodesRemaining} recovery code${factors.recoveryCodesRemaining === 1 ? "" : "s"} remaining`
                  : "Not enrolled"}
              </div>
            </div>
            {totpEnabled ? (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setPendingAction({ kind: "regenerate" })}>
                  <RefreshCw size={13} /> Regenerate codes
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => setPendingAction({ kind: "disable" })}>
                  <Trash2 size={13} /> Disable
                </button>
              </>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={handleStartEnroll} disabled={enrollBusy}>
                {enrollBusy ? <RefreshCw size={13} className="spin" /> : <KeyRound size={13} />}
                Enable TOTP
              </button>
            )}
          </div>
          {enrollErr && (
            <div className="st-status-err">
              <AlertCircle size={12} /> {enrollErr}
            </div>
          )}
        </div>
      )}

      <div className="card card-padded flex-col gap-md">
        <div className="factor-row">
          <KeyRound size={18} color={passkeys.length > 0 ? "var(--green)" : "var(--text3)"} />
          <div className="factor-row__info">
            <div className="font-bold">Passkeys</div>
            <div className="text-xs text-muted factor-row__sub">
              {passkeys.length === 0
                ? "No passkeys registered"
                : `${passkeys.length} passkey${passkeys.length === 1 ? "" : "s"} registered`}
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={handleAddPasskey}>
            <UserPlus size={13} /> Add passkey
          </button>
        </div>
        {passkeys.length > 0 && (
          <div className="flex-col gap-xs">
            {passkeys.map((cred) => (
              <div key={cred.id} className="passkey-item">
                <div className="passkey-item__info">
                  <div className="text-sm font-semi passkey-item__name">
                    {cred.deviceName || "Unnamed passkey"}
                  </div>
                  <div className="text-xs text-muted passkey-item__meta">
                    Added {fmtDeletedDate(cred.createdAt)}
                    {cred.lastUsedAt && ` · last used ${fmtDeletedDate(cred.lastUsedAt)}`}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-xs"
                  style={{ color: "var(--text3)" }}
                  onClick={() => setPendingAction({ kind: "removePasskey", credentialId: cred.id })}
                  title={`Remove ${cred.deviceName || "passkey"}`}
                >
                  <Trash2 size={11} /> Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {isAdmin && <WorkspaceMfaPolicyPanel />}

      {pendingAction && needsPassword && (
        <PasswordConfirmModal
          title={
            pendingAction.kind === "disable" ? "Disable MFA?"
            : pendingAction.kind === "regenerate" ? "Regenerate recovery codes?"
            : "Remove passkey?"
          }
          description={
            pendingAction.kind === "disable" ? "This clears your TOTP secret and all recovery codes. You can re-enroll afterwards."
            : pendingAction.kind === "regenerate" ? "Your existing recovery codes will stop working immediately. A fresh set will be shown once."
            : "This passkey will no longer be accepted at sign-in."
          }
          busy={actionBusy}
          error={actionErr}
          onConfirm={(pwd) => runAction(pendingAction, pwd)}
          onCancel={() => { setPendingAction(null); setActionErr(null); }}
        />
      )}
    </div>
  );
}

function AccountTab() {
  const { logout, user } = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // OAuth-only users have no password — skip the password confirmation field.
  const needsPassword = user?.hasPassword !== false;

  // Auto-disarm delete confirmation after 5s; clean up on unmount.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  async function handleExport() {
    if (needsPassword && !password.trim()) {
      setStatus({ type: "err", text: "Enter your password to export account data." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const data = await api.exportAccountData(needsPassword ? password.trim() : "");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sentri-account-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
      setStatus({ type: "ok", text: "Account export downloaded." });
    } catch (err) {
      setStatus({ type: "err", text: err.message || "Export failed." });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (needsPassword && !password.trim()) {
      setStatus({ type: "err", text: "Enter your password to delete your account." });
      return;
    }
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.deleteAccount(needsPassword ? password.trim() : "");
      await logout();
    } catch (err) {
      setStatus({ type: "err", text: err.message || "Account deletion failed." });
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="flex-col gap-lg">
      <SectionTitle icon={<Shield size={16} color="var(--red)" />} title="Account & Privacy" sub="Export your data or permanently delete your account." />
      <div className="card card-padded flex-col gap-md">
        {needsPassword ? (
          <label className="text-sm font-semi">
            Confirm password
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your current password"
              style={{ marginTop: 8 }}
            />
          </label>
        ) : (
          <div className="text-sm text-muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Info size={13} /> You signed in via OAuth — no password confirmation needed.
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={handleExport}>
            {busy ? <RefreshCw size={13} className="spin" /> : <ExternalLink size={13} />} Export account data
          </button>
          <button className={`btn btn-sm ${confirmDelete ? "btn-danger" : "btn-ghost"}`} disabled={busy} onClick={handleDelete}>
            {busy ? <RefreshCw size={13} className="spin" /> : <Trash2 size={13} />}
            {confirmDelete ? "Confirm delete account" : "Delete account"}
          </button>
        </div>
        {status && (
          <div className={status.type === "ok" ? "st-status-ok" : "st-status-err"}>
            {status.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {status.text}
          </div>
        )}
      </div>
    </div>
  );
}


function IntegrationsTab({ isAdmin }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(null);
  const [installing, setInstalling] = useState(null);
  const [status, setStatus] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getGithubCheckSettings();
      setRows(data.projects || []);
    } catch (err) {
      setError(err.message || "Failed to load GitHub settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("github") === "installed") {
      setStatus({ type: "ok", text: "GitHub App installed. Settings were refreshed with the selected repository." });
      load();
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [load]);

  function updateRow(projectId, patch) {
    setRows(prev => prev.map(row => row.projectId === projectId ? { ...row, ...patch } : row));
  }

  async function installGithubApp(projectId) {
    setInstalling(projectId);
    setError("");
    setStatus(null);
    try {
      const data = await api.getGithubInstallStartUrl(projectId);
      window.location.assign(data.url);
    } catch (err) {
      setError(err.message || "Failed to start GitHub App install.");
      setInstalling(null);
    }
  }

  async function saveRow(row) {
    setSaving(row.projectId);
    setError("");
    try {
      await api.updateGithubCheckSettings(row.projectId, {
        enabled: !!row.enabled,
        repo: row.repo || "",
        installationId: row.installationId || "",
      });
      await load();
    } catch (err) {
      setError(err.message || "Failed to save GitHub settings.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex-col gap-lg">
      <SectionTitle icon={<ExternalLink size={16} color="var(--accent)" />} title="Integrations" sub="Connect Sentri to developer workflows" />
      <div className="card card-padded">
        <div className="font-bold" style={{ marginBottom: 6 }}>GitHub PR checks</div>
        <div className="text-sm text-muted" style={{ marginBottom: 14 }}>
          Install the Sentri GitHub App, then enable native Check Runs per project. Existing projects stay disabled until toggled on.
        </div>
        <div className="text-xs text-muted">
          Use the per-project install button below to authorize the GitHub App and auto-fill the selected repository.
        </div>
      </div>

      {status && <div className={status.type === "ok" ? "st-status-ok" : "st-status-err"}>{status.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {status.text}</div>}
      {error && <div className="st-status-err"><AlertCircle size={12} /> {error}</div>}
      {loading ? <div className="text-sm text-muted">Loading GitHub integration settings…</div> : rows.map(row => (
        <div key={row.projectId} className="card card-padded" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr auto auto", gap: 12, alignItems: "end" }}>
          <div>
            <div className="font-bold">{row.projectName}</div>
            <label className="text-xs text-muted" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input
                type="checkbox"
                checked={!!row.enabled}
                disabled={!isAdmin}
                onChange={e => updateRow(row.projectId, { enabled: e.target.checked })}
              />
              Post PR checks
            </label>
          </div>
          <div>
            <label className="text-xs text-muted">Repository</label>
            <input className="input" value={row.repo || ""} disabled={!isAdmin} placeholder="owner/repo" onChange={e => updateRow(row.projectId, { repo: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-muted">Installation ID</label>
            <input className="input" value={row.installationId || ""} disabled={!isAdmin} placeholder="123456" onChange={e => updateRow(row.projectId, { installationId: e.target.value })} />
          </div>
          <button className="btn btn-ghost btn-sm" disabled={!isAdmin || installing === row.projectId} onClick={() => installGithubApp(row.projectId)}>
            {installing === row.projectId ? <RefreshCw size={13} className="spin" /> : <ExternalLink size={13} />} Install App
          </button>
          <button className="btn btn-primary btn-sm" disabled={!isAdmin || saving === row.projectId} onClick={() => saveRow(row)}>
            {saving === row.projectId ? <RefreshCw size={13} className="spin" /> : <Check size={13} />} Save
          </button>
        </div>
      ))}
      {!isAdmin && <div className="hint">QA leads can view integration status. Admin access is required to change GitHub App settings.</div>}
    </div>
  );
}

export default function Settings() {
  usePageTitle("Settings");
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.workspaceRole === "admin";
  const visibleTabs = SETTINGS_TABS.filter(t => isAdmin || !t.adminOnly);
  // Honour `?tab=<key>` deep links (e.g. the GitHub App install callback
  // redirects to `/settings?tab=integrations&github=installed&…` and the
  // IntegrationsTab success banner only renders when that tab is active).
  // Fall back to the first visible tab so non-admins don't land on a locked
  // section. Computed once at mount via lazy init — subsequent navigations
  // within Settings use the in-component `setTab`.
  const [tab, setTab]           = useState(() => {
    const urlTab = new URLSearchParams(window.location.search).get("tab");
    if (urlTab && visibleTabs.some(t => t.key === urlTab)) return urlTab;
    return visibleTabs[0]?.key || "account";
  });

  const bundleQuery = useSettingsBundleQuery();

  const settings = bundleQuery.data?.settings ?? null;
  const config   = bundleQuery.data?.config ?? null;
  const sysInfo  = bundleQuery.data?.sysInfo ?? null;
  const loading  = bundleQuery.isLoading;

  // After a save/delete we want sibling tabs (members, recycleBin, ollamaStatus)
  // to also refresh, since adding/removing an API key affects config and
  // system info displayed elsewhere on the page.
  const reload = useCallback(() => invalidateSettingsCache(), []);

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

  const [compatForm, setCompatForm] = useState({ slotId: "", displayName: "", baseUrl: "", model: "", apiKey: "" });
  const [compatSaving, setCompatSaving] = useState(false);
  const [compatError, setCompatError] = useState("");

  async function handleCompatSave(e) {
    e.preventDefault();
    setCompatError("");
    const slot = compatForm.slotId.trim().toLowerCase();
    if (!slot || !/^[a-z0-9_-]+$/.test(slot)) return setCompatError("Slot ID is required (letters, numbers, _ or -).");
    if (!compatForm.baseUrl.trim() || !compatForm.model.trim() || !compatForm.apiKey.trim()) return setCompatError("baseUrl, model, and apiKey are required.");
    setCompatSaving(true);
    try {
      await api.saveApiKey(`compat:${slot}`, compatForm.apiKey.trim(), {
        baseUrl: compatForm.baseUrl.trim(),
        model: compatForm.model.trim(),
        displayName: compatForm.displayName.trim() || slot,
      });
      invalidateConfigCache();
      await reload();
      setCompatForm({ slotId: "", displayName: "", baseUrl: "", model: "", apiKey: "" });
    } catch (err) {
      setCompatError(err.message || "Failed to save provider.");
    } finally {
      setCompatSaving(false);
    }
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
        {visibleTabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`tab-btn${tab === t.key ? " tab-btn--active" : ""}`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Defense-in-depth: if `tab` ever points at an admin-only section for a
          non-admin (stale state, deep link), short-circuit with a locked card
          instead of rendering the admin UI. */}
      {!isAdmin && SETTINGS_TABS.find(t => t.key === tab)?.adminOnly && (
        <AdminLockedSection
          feature={SETTINGS_TABS.find(t => t.key === tab)?.label}
          role={user?.workspaceRole}
        />
      )}

      {/* ── Tab: AI Providers ── */}
      {tab === "providers" && isAdmin && <>
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

      {/* Persistence note */}
      <div className="st-env-tip">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <Info size={13} className="shrink-0" style={{ marginTop: 2, color: "var(--text3)" }} />
          <div className="text-sm text-sub" style={{ lineHeight: 1.6 }}>
            Keys saved here are stored in memory and will reset when the server restarts.
            For persistent configuration, see the deployment documentation.
          </div>
        </div>
      </div>

      <div className="card-padded" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 10 }}>OpenAI-compatible providers</h3>
        <form onSubmit={handleCompatSave} style={{ display: "grid", gap: 8 }}>
          <input className="input" placeholder="Slot id (e.g. deepseek)" value={compatForm.slotId} onChange={(e) => setCompatForm((s) => ({ ...s, slotId: e.target.value }))} />
          <input className="input" placeholder="Display name" value={compatForm.displayName} onChange={(e) => setCompatForm((s) => ({ ...s, displayName: e.target.value }))} />
          <input className="input" placeholder="Base URL" list="compat-baseurl-hints" value={compatForm.baseUrl} onChange={(e) => setCompatForm((s) => ({ ...s, baseUrl: e.target.value }))} />
          <datalist id="compat-baseurl-hints">
            {OPENAI_COMPAT_HINTS.map((url) => <option key={url} value={url} />)}
          </datalist>
          <input className="input" placeholder="Model" value={compatForm.model} onChange={(e) => setCompatForm((s) => ({ ...s, model: e.target.value }))} />
          <input className="input" type="password" autoComplete="off" placeholder="API key" value={compatForm.apiKey} onChange={(e) => setCompatForm((s) => ({ ...s, apiKey: e.target.value }))} />
          {compatError && <div className="text-sm" style={{ color: "var(--red)" }}>{compatError}</div>}
          <button className="btn btn-primary btn-sm" disabled={compatSaving}>{compatSaving ? "Saving..." : "Save compat provider"}</button>
        </form>
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          {(settings?.compatProviders || []).map((p) => (
            <div key={p.provider} className="card-padded-sm" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div className="font-semi">{p.displayName} <span className="text-mono text-sub">({p.provider})</span></div>
                <div className="text-xs text-sub">{p.baseUrl} · {p.model} · {p.apiKey}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-ghost btn-xs" onClick={() => setCompatForm({ slotId: p.provider.replace("compat:", ""), displayName: p.displayName || "", baseUrl: p.baseUrl || "", model: p.model || "", apiKey: "" })}>Edit</button>
                <button className="btn btn-danger btn-xs" onClick={() => handleDelete(p.provider)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      </>}

      {/* ── Tab: Provider Routes (B3.1) ── */}
      {tab === "provider_routes" && isAdmin && <ProviderRoutesTab />}

      {/* ── Tab: Members ── */}
      {tab === "agent_roles" && isAdmin && <AgentRolesTab />}

      {tab === "members" && isAdmin && <MembersTab />}

      {/* ── Tab: Integrations ── */}
      {tab === "integrations" && <IntegrationsTab isAdmin={isAdmin} />}

      {/* ── Tab: Execution (runtime defaults + system info) ── */}
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

      <div style={{ height: 32 }} />

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

      {/* ── Tab: Data (data management + recycle bin) ── */}
      {tab === "data" && isAdmin && <>
      <SectionTitle icon={<Database size={16} color="var(--amber)" />} title="Data Management" sub="Clear in-memory data — all data is ephemeral and resets on server restart" />
      <div className="flex-col gap-md">
        <DataAction icon={<Activity size={16} />} label="Run History" sub="All crawl and test run records, including logs and results" count={sysInfo?.runs} btnLabel="Clear Runs" onAction={async () => { const r = await api.clearRuns(); await reload(); return r; }} />
        <DataAction icon={<Clock size={16} />} label="Activity Log" sub="Timeline of all user and system actions" count={sysInfo?.activities} btnLabel="Clear Log" onAction={async () => { const r = await api.clearActivities(); await reload(); return r; }} />
        <DataAction icon={<Shield size={16} />} label="Self-Healing History" sub="Learned selector strategies — clearing forces the waterfall to start fresh" count={sysInfo?.healingEntries} btnLabel="Clear History" onAction={async () => { const r = await api.clearHealing(); await reload(); return r; }} />
      </div>

      <div style={{ height: 32 }} />

      <RecycleBinTab />
      </>}

      {/* ── Tab: Security (SEC-004) ── */}
      {tab === "security" && <SecurityTab />}

      {/* ── Tab: Account ── */}
      {tab === "account" && <AccountTab />}

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

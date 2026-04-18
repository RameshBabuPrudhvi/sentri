import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Check, Eye, EyeOff, ExternalLink, AlertTriangle,
  RefreshCw, Trash2, Zap, Database, Server, Clock, Cpu,
  Activity, Shield, HardDrive, Info, Wifi, WifiOff, Terminal,
  Compass, RotateCcw, FolderOpen, FileText, Play, AlertCircle,
  Users, UserPlus, Crown, ChevronDown,
} from "lucide-react";
import { api } from "../api.js";
import { invalidateConfigCache } from "../components/layout/ProviderBadge.jsx";
import { resetOnboarding, emitTourEvent } from "../hooks/useOnboarding.js";
import usePageTitle from "../hooks/usePageTitle.js";
import { useAuth } from "../context/AuthContext.jsx";

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
  { key: "providers",   label: "AI Providers",  icon: <Zap size={14} /> },
  { key: "members",     label: "Members",       icon: <Users size={14} /> },
  { key: "execution",   label: "Execution",     icon: <Cpu size={14} /> },
  { key: "account",     label: "Account",       icon: <Shield size={14} /> },
  { key: "data",        label: "Data",          icon: <Database size={14} /> },
  { key: "recycle-bin", label: "Recycle Bin",   icon: <Trash2 size={14} /> },
  { key: "system",      label: "System",        icon: <Server size={14} /> },
];


// ── Members tab (ACL-002) ─────────────────────────────────────────────────────

const ROLE_OPTIONS = [
  { value: "admin",   label: "Admin",   desc: "Full access — manage members, settings, and all data" },
  { value: "qa_lead", label: "QA Lead", desc: "Create, edit, run, and delete tests and projects" },
  { value: "viewer",  label: "Viewer",  desc: "Read-only access to all data" },
];

function MembersTab() {
  const { user } = useAuth();
  const [members, setMembers]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole]   = useState("viewer");
  const [inviting, setInviting]   = useState(false);
  const [inviteMsg, setInviteMsg] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getMembers();
      setMembers(data);
    } catch (e) {
      setError(e.message || "Failed to load members");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

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

      {error && (
        <div className="card card-padded" style={{ borderColor: "var(--danger)", color: "var(--danger)", display: "flex", gap: 8, alignItems: "center" }}>
          <AlertCircle size={15} /> {error}
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
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState({});
  const [error, setError]       = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getRecycleBin();
      setData(result);
    } catch (e) {
      setError(e.message || "Failed to load recycle bin");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

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

  if (error) return (
    <div className="card card-padded" style={{ borderColor: "var(--danger)", color: "var(--danger)", display: "flex", gap: 8, alignItems: "center" }}>
      <AlertCircle size={15} /> {error}
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

function AccountTab() {
  const { logout } = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Auto-disarm delete confirmation after 5s; clean up on unmount.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  async function handleExport() {
    if (!password.trim()) {
      setStatus({ type: "err", text: "Enter your password to export account data." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const data = await api.exportAccountData(password.trim());
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
    if (!password.trim()) {
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
      await api.deleteAccount(password.trim());
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
      </>}

      {/* ── Tab: Members ── */}
      {tab === "members" && <MembersTab />}

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

      {/* ── Tab: Account ── */}
      {tab === "account" && <AccountTab />}

      {/* ── Tab: Data ── */}
      {tab === "data" && <>
      <SectionTitle icon={<Database size={16} color="var(--amber)" />} title="Data Management" sub="Clear in-memory data — all data is ephemeral and resets on server restart" />
      <div className="flex-col gap-md">
        <DataAction icon={<Activity size={16} />} label="Run History" sub="All crawl and test run records, including logs and results" count={sysInfo?.runs} btnLabel="Clear Runs" onAction={async () => { const r = await api.clearRuns(); await reload(); return r; }} />
        <DataAction icon={<Clock size={16} />} label="Activity Log" sub="Timeline of all user and system actions" count={sysInfo?.activities} btnLabel="Clear Log" onAction={async () => { const r = await api.clearActivities(); await reload(); return r; }} />
        <DataAction icon={<Shield size={16} />} label="Self-Healing History" sub="Learned selector strategies — clearing forces the waterfall to start fresh" count={sysInfo?.healingEntries} btnLabel="Clear History" onAction={async () => { const r = await api.clearHealing(); await reload(); return r; }} />
      </div>
      </>}

      {/* ── Tab: Recycle Bin ── */}
      {tab === "recycle-bin" && <RecycleBinTab />}

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

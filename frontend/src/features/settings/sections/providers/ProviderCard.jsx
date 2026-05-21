import React, { useEffect, useState } from "react";
import {
  AlertTriangle, Check, ExternalLink, Eye, EyeOff, RefreshCw, Trash2, Zap,
} from "lucide-react";
import OllamaStatusPanel from "./OllamaStatusPanel.jsx";
import { PROVIDER_EMOJI } from "./providers.constants.js";

/**
 * Cloud + local provider card. Cloud providers render an API-key input;
 * the local (Ollama) provider renders `OllamaStatusPanel` instead. Beforeunload
 * warns if the user is mid-type on a key field.
 *
 * AGENT.md §127 carve-out: the background / border-color inline styles are
 * data-driven from `PROVIDERS` (per-provider brand colors), and the active
 * pill / icon background depend on `isActive` state. These satisfy the
 * "data-driven values" exception. All other styling is class-based.
 * Extracted from Settings.jsx (GAP-002).
 */
export default function ProviderCard({ provider, activeProvider, maskedKey, ollamaBaseUrl, ollamaModel, onSave, onDelete }) {
  const [input, setInput]                       = useState("");
  const [show, setShow]                         = useState(false);
  const [saving, setSaving]                     = useState(false);
  const [status, setStatus]                     = useState(null);
  const [error, setError]                       = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Auto-reset confirmation state after 4s if user doesn't follow through.
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  // Warn before navigating away with unsaved API key input.
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

  // Data-driven brand colors (AGENT.md §127 carve-out — driven by the
  // PROVIDERS constant, not a fixed value).
  const cardStyle = {
    background: isActive ? provider.bg : "var(--surface)",
    border: `1px solid ${isActive ? provider.borderColor : "var(--border)"}`,
  };
  const pillStyle = { background: provider.bg, border: `1px solid ${provider.borderColor}` };
  const iconStyle = {
    background: isActive ? provider.bg : "var(--bg3)",
    border: `1px solid ${isActive ? provider.borderColor : "var(--border)"}`,
  };
  const activeTextStyle = { color: provider.color };
  const badgeStyle = { color: provider.badgeColor, background: `${provider.badgeColor}18` };
  const docsLinkStyle = { color: provider.color };

  return (
    <div className="st-provider-card" style={cardStyle}>
      {/* Active indicator */}
      {isActive && (
        <div className="st-provider-active-pill" style={pillStyle}>
          <Zap size={11} color={provider.color} />
          <span className="st-provider-active-text" style={activeTextStyle}>Active</span>
        </div>
      )}

      {/* Header */}
      <div className="st-provider-header">
        <div className="st-provider-icon st-provider-icon-emoji" style={iconStyle}>
          {PROVIDER_EMOJI[provider.id] || "🔷"}
        </div>
        <div className="flex-1">
          <div className="st-provider-name-row">
            <span className="font-bold">{provider.name}</span>
            <span className="st-provider-badge" style={badgeStyle}>
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
          <AlertTriangle size={13} color="var(--amber)" className="shrink-0 ollama-tip__icon" />
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
          <div className="st-provider-actions">
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
            className="st-docs-link" style={docsLinkStyle}>
            ollama.ai <ExternalLink size={11} />
          </a>
        </>
      ) : (
        /* ── Cloud provider section ── */
        <>
          {/* Current key status */}
          {hasKey && (
            <div className="st-key-status">
              <div className="st-key-status-inner">
                <Check size={13} color="var(--green)" />
                <span className="text-mono text-sm text-sub">{maskedKey}</span>
              </div>
              <button
                className={`btn btn-sm ${confirmingDelete ? "btn-danger" : "btn-ghost"} st-key-remove-btn`}
                onClick={handleDeleteClick}
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
                className="input st-provider-key-input"
                type={show ? "text" : "password"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                placeholder={hasKey ? "Enter new key to replace..." : provider.placeholder}
              />
              <button onClick={() => setShow((s) => !s)} className="st-key-toggle">
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <button className="btn btn-primary btn-sm st-data-action__btn" onClick={handleSave}
              disabled={saving || !input.trim()}>
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
            className="st-docs-link" style={docsLinkStyle}>
            Get {provider.company} API key <ExternalLink size={11} />
          </a>
        </>
      )}
    </div>
  );
}

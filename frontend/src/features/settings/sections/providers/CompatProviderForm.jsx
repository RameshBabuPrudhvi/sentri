import React, { useState } from "react";
import {
  Check, ExternalLink, RefreshCw, Server, Trash2, Zap,
} from "lucide-react";
import { api } from "../../../../api.js";
import { invalidateConfigCache } from "../../../../components/layout/ProviderBadge.jsx";
import { useSettingsBundleQuery } from "../../../../hooks/queries/useSettingsQueries.js";
import { OPENAI_COMPAT_HINTS } from "./providers.constants.js";

/**
 * OpenAI-compatible provider config (AI-001).
 *
 * UX-AUDIT (May 2026): operators previously saw their DeepSeek / Groq /
 * Mistral / vLLM / LiteLLM slots rendered as a bare `.card-padded-sm` row
 * with three muted text spans — visually disconnected from the built-in
 * `ProviderCard` list above, with no "Active" pill, no masked-key affordance,
 * and no one-click activate button. This component now renders each existing
 * compat slot as a full `.st-provider-card` mirroring `ProviderCard.jsx` so
 * DeepSeek looks and behaves identically to GPT-4o-mini / Claude. Pattern
 * mirrors Vercel AI Gateway, OpenRouter, Helicone, LangSmith, Braintrust —
 * all render BYO providers using the same card shape as first-party ones.
 *
 * Brand palette uses the same purple tint as the local/Ollama card so the
 * "self-hosted / custom" provider family reads as one visual group. Each
 * slot is still keyed `compat:<slot>` in the provider registry.
 */

// Shared compat palette — picked once so every compat card uses the same
// tint. Mirrors the purple used by Ollama in providers.constants.js so the
// "custom / self-hosted" provider family reads as one visual group.
const COMPAT_COLOR = "#7c3aed";
const COMPAT_BG = "rgba(124,58,237,0.06)";
const COMPAT_BORDER = "rgba(124,58,237,0.3)";

export default function CompatProviderForm({ compatProviders, reload, onDelete }) {
  const [form, setForm] = useState({ slotId: "", displayName: "", baseUrl: "", model: "", apiKey: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);

  // Read active-provider so each compat card can render its own "Active"
  // pill (parity with ProviderCard.jsx). Bundle is already cached by the
  // parent ProvidersSection, so this is a free read.
  const bundleQuery = useSettingsBundleQuery();
  const activeProvider = bundleQuery.data?.settings?.activeProvider || null;

  async function handleSave(e) {
    e.preventDefault();
    setError("");
    const slot = form.slotId.trim().toLowerCase();
    if (!slot || !/^[a-z0-9_-]+$/.test(slot)) {
      return setError("Slot ID is required (letters, numbers, _ or -).");
    }
    if (!form.baseUrl.trim() || !form.model.trim() || !form.apiKey.trim()) {
      return setError("baseUrl, model, and apiKey are required.");
    }
    setSaving(true);
    try {
      await api.saveApiKey(`compat:${slot}`, form.apiKey.trim(), {
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        displayName: form.displayName.trim() || slot,
      });
      invalidateConfigCache();
      await reload();
      setForm({ slotId: "", displayName: "", baseUrl: "", model: "", apiKey: "" });
    } catch (err) {
      setError(err.message || "Failed to save provider.");
    } finally {
      setSaving(false);
    }
  }

  // One-click "Activate" without re-entering the API key. Uses the
  // `__use_existing__` quick-switch path in `backend/src/routes/settings.js`
  // so the saved key is reused server-side.
  async function handleActivate(providerKey) {
    setActivating(providerKey);
    setError("");
    try {
      await api.saveApiKey(providerKey, "__use_existing__");
      invalidateConfigCache();
      await reload();
    } catch (err) {
      setError(err.message || "Failed to activate provider.");
    } finally {
      setActivating(null);
    }
  }

  function startEdit(p) {
    setForm({
      slotId: p.provider.replace("compat:", ""),
      displayName: p.displayName || "",
      baseUrl: p.baseUrl || "",
      model: p.model || "",
      apiKey: "",
    });
  }

  // Two-tap delete to prevent accidental key removal (matches the
  // confirm-then-delete pattern from ProviderCard.jsx).
  function handleDeleteClick(providerKey) {
    if (confirmingDelete !== providerKey) {
      setConfirmingDelete(providerKey);
      setTimeout(() => {
        setConfirmingDelete((curr) => (curr === providerKey ? null : curr));
      }, 4000);
      return;
    }
    setConfirmingDelete(null);
    onDelete(providerKey);
  }

  return (
    <div className="st-compat-card">
      <div className="st-section-title">
        <div className="st-section-icon">
          <Server size={16} color={COMPAT_COLOR} />
        </div>
        <div>
          <div className="font-bold st-section-title__heading">Custom OpenAI-compatible providers</div>
          <div className="text-xs text-sub st-section-title__sub">
            Any vendor that speaks the OpenAI Chat Completions wire format — DeepSeek, Groq, Mistral, xAI, Azure OpenAI, Together, Fireworks, vLLM, LM Studio, LiteLLM.
          </div>
        </div>
      </div>
      {/* Add-provider form wrapped in its own card box so it visually matches
          the built-in ProviderCard list above (each provider sits in its own
          surface-coloured card). Without this wrapper the form inputs floated
          against the page background and the section read as a broken layout
          compared to GPT-4o-mini / Claude / Gemini cards. */}
      {/* Add-provider form — `.card` supplies the surface/border/shadow,
          `.card-padded` supplies the 24px inner padding. Without the leading
          `.card` class the inputs floated against the page background with
          no visible box (matched the legacy bug that shipped with the
          extracted component). */}
      <div className="card card-padded st-compat-form-card">
        <h3 className="st-compat-card__title">Add provider</h3>
        {/*
          autoComplete="off" + non-credential `name` attributes on every input
          prevent password managers (1Password, Chrome, Safari Keychain) from
          misidentifying this as a login form and autofilling stored credentials
          into the "Slot id" / "Display name" fields. The API-key field uses
          autoComplete="new-password" which is the WHATWG-recommended value for
          one-off secret entry (it suppresses the "Save password?" prompt that
          fires on plain `autoComplete="off"` in Chrome).
        */}
        <form onSubmit={handleSave} className="st-compat-form" autoComplete="off">
          <input className="input" name="compat-slot-id"      autoComplete="off" placeholder="Slot id (e.g. deepseek)" value={form.slotId}        onChange={(e) => setForm((s) => ({ ...s, slotId:      e.target.value }))} />
          <input className="input" name="compat-display-name" autoComplete="off" placeholder="Display name"             value={form.displayName}  onChange={(e) => setForm((s) => ({ ...s, displayName: e.target.value }))} />
          <input className="input" name="compat-base-url"     autoComplete="off" placeholder="Base URL"                  value={form.baseUrl}      onChange={(e) => setForm((s) => ({ ...s, baseUrl:     e.target.value }))} list="compat-baseurl-hints" />
          <datalist id="compat-baseurl-hints">
            {OPENAI_COMPAT_HINTS.map((url) => <option key={url} value={url} />)}
          </datalist>
          <input className="input" name="compat-model"        autoComplete="off" placeholder="Model" value={form.model}  onChange={(e) => setForm((s) => ({ ...s, model:  e.target.value }))} />
          <input className="input" name="compat-api-key"      type="password" autoComplete="new-password" placeholder="API key" value={form.apiKey} onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))} />
          {error && <div className="text-sm st-compat-form__error">{error}</div>}
          {/* Action row uses the same `.st-provider-actions` container as
              the Ollama "Activate" button at ProviderCard.jsx:154-172 so the
              CTA visually matches the rest of the providers page (icon +
              label, 14px top margin, flex-wrap on narrow viewports). */}
          <div className="st-provider-actions">
            <button className="btn btn-primary btn-sm" disabled={saving}>
              {saving ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
              {saving ? "Saving…" : "Save provider"}
            </button>
          </div>
        </form>
      </div>
      {/* Existing compat slots as full provider cards (parity with the
          built-in ProviderCard list above). Empty state is intentionally
          silent — the "Add provider" form sits right above this block. */}
      <div className="st-provider-cards">
        {(compatProviders || []).map((p) => {
          const isActive = activeProvider === p.provider;
          const slotId = p.provider.replace("compat:", "");
          const isActivating = activating === p.provider;
          const isConfirmingDelete = confirmingDelete === p.provider;
          const cardStyle = {
            background: isActive ? COMPAT_BG : "var(--surface)",
            border: `1px solid ${isActive ? COMPAT_BORDER : "var(--border)"}`,
          };
          const pillStyle = { background: COMPAT_BG, border: `1px solid ${COMPAT_BORDER}` };
          const iconStyle = {
            background: isActive ? COMPAT_BG : "var(--bg3)",
            border: `1px solid ${isActive ? COMPAT_BORDER : "var(--border)"}`,
          };
          const badgeStyle = { color: COMPAT_COLOR, background: "rgba(124,58,237,0.12)" };
          const docsStyle = { color: COMPAT_COLOR };
          const activeTextStyle = { color: COMPAT_COLOR };
          return (
            <div key={p.provider} className="st-provider-card" style={cardStyle}>
              {isActive && (
                <div className="st-provider-active-pill" style={pillStyle}>
                  <Zap size={11} color={COMPAT_COLOR} />
                  <span className="st-provider-active-text" style={activeTextStyle}>Active</span>
                </div>
              )}

              <div className="st-provider-header">
                <div className="st-provider-icon st-provider-icon-emoji" style={iconStyle}>
                  🔷
                </div>
                <div className="flex-1">
                  <div className="st-provider-name-row">
                    <span className="font-bold">{p.displayName || slotId}</span>
                    <span className="st-provider-badge" style={badgeStyle}>Custom</span>
                  </div>
                  <div className="text-xs text-sub">
                    OpenAI-compatible · <span className="text-mono">{p.model}</span>
                  </div>
                </div>
              </div>

              <div className="st-provider-desc text-mono">{p.baseUrl}</div>

              {/* Masked-key row — mirrors the cloud-provider branch of
                  ProviderCard.jsx so the saved-key affordance is identical. */}
              <div className="st-key-status">
                <div className="st-key-status-inner">
                  <Check size={13} color="var(--green)" />
                  <span className="text-mono text-sm text-sub">{p.apiKey}</span>
                </div>
                <button
                  className={`btn btn-sm ${isConfirmingDelete ? "btn-danger" : "btn-ghost"} st-key-remove-btn`}
                  onClick={() => handleDeleteClick(p.provider)}
                >
                  <Trash2 size={11} />
                  {isConfirmingDelete ? "Confirm remove?" : "Remove"}
                </button>
              </div>

              <div className="st-provider-actions">
                {!isActive && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handleActivate(p.provider)}
                    disabled={!!isActivating}
                  >
                    {isActivating ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
                    {isActivating ? "Activating…" : "Activate"}
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => startEdit(p)}>
                  Edit
                </button>
              </div>

              {p.baseUrl && (
                <a
                  href={p.baseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="st-docs-link"
                  style={docsStyle}
                >
                  Open endpoint <ExternalLink size={11} />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import React, { useState } from "react";
import { api } from "../../../../api.js";
import { invalidateConfigCache } from "../../../../components/layout/ProviderBadge.jsx";
import { OPENAI_COMPAT_HINTS } from "./providers.constants.js";

/**
 * OpenAI-compatible provider config form (AI-001). Operators can wire any
 * OpenAI-API-compatible endpoint (DeepSeek, Groq, Mistral, xAI, LiteLLM, etc.)
 * as a custom provider slot. The slot id appears as `compat:<slot>` in the
 * provider registry. Existing slots can be edited via the per-slot edit
 * button; deletion is delegated to the parent so it can refresh the bundle.
 * Extracted from Settings.jsx (GAP-002).
 */
export default function CompatProviderForm({ compatProviders, reload, onDelete }) {
  const [form, setForm] = useState({ slotId: "", displayName: "", baseUrl: "", model: "", apiKey: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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

  return (
    <div className="card-padded st-compat-card">
      <h3 className="st-compat-card__title">OpenAI-compatible providers</h3>
      <form onSubmit={handleSave} className="st-compat-form">
        <input className="input" placeholder="Slot id (e.g. deepseek)" value={form.slotId}        onChange={(e) => setForm((s) => ({ ...s, slotId:      e.target.value }))} />
        <input className="input" placeholder="Display name"             value={form.displayName}  onChange={(e) => setForm((s) => ({ ...s, displayName: e.target.value }))} />
        <input className="input" placeholder="Base URL"                  value={form.baseUrl}      onChange={(e) => setForm((s) => ({ ...s, baseUrl:     e.target.value }))} list="compat-baseurl-hints" />
        <datalist id="compat-baseurl-hints">
          {OPENAI_COMPAT_HINTS.map((url) => <option key={url} value={url} />)}
        </datalist>
        <input className="input" placeholder="Model" value={form.model}  onChange={(e) => setForm((s) => ({ ...s, model:  e.target.value }))} />
        <input className="input" type="password" autoComplete="off" placeholder="API key" value={form.apiKey} onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))} />
        {error && <div className="text-sm st-compat-form__error">{error}</div>}
        <button className="btn btn-primary btn-sm" disabled={saving}>
          {saving ? "Saving..." : "Save compat provider"}
        </button>
      </form>
      <div className="st-compat-list">
        {(compatProviders || []).map((p) => (
          <div key={p.provider} className="card-padded-sm st-compat-row">
            <div>
              <div className="font-semi">{p.displayName} <span className="text-mono text-sub">({p.provider})</span></div>
              <div className="text-xs text-sub">{p.baseUrl} · {p.model} · {p.apiKey}</div>
            </div>
            <div className="st-compat-row__actions">
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setForm({
                  slotId: p.provider.replace("compat:", ""),
                  displayName: p.displayName || "",
                  baseUrl: p.baseUrl || "",
                  model: p.model || "",
                  apiKey: "",
                })}
              >
                Edit
              </button>
              <button className="btn btn-danger btn-xs" onClick={() => onDelete(p.provider)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

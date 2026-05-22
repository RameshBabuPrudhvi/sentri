import React from "react";
import {
  AlertTriangle, Check, Eye, EyeOff, Plus, RefreshCw,
} from "lucide-react";
import { PR_FAMILIES, PR_PROTOCOLS } from "./providerRoutes.constants.js";

/**
 * Create / edit form for a Provider Route. Pulled into its own file so the
 * parent section JSX stays scannable — the form carries ten fields and would
 * otherwise dominate the surrounding render. Extracted from Settings.jsx
 * (GAP-002).
 */
export default function ProviderRoutesForm({
  form, setForm, busy, showKey, setShowKey, fallbackOptions, cycleAtName, onSave, onCancel,
}) {
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
          {cycleAtName && (
            <div className="st-status-err st-pr-cycle-warning">
              <AlertTriangle size={11} /> Fallback chain loops at &quot;{cycleAtName}&quot;. Pick a different route.
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

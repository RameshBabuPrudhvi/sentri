import React, { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertCircle, Check, ChevronDown, ChevronUp,
  Eye, EyeOff, KeyRound, Plus, RefreshCw, Trash2, X,
} from "lucide-react";
import { api } from "../../../../api.js";
import SectionTitle from "../../shared/SectionTitle.jsx";
import { detectFallbackCycle, maskedKeyDisplay } from "../provider-routes/providerRoutes.utils.js";
import ProbeBadge from "../provider-routes/ProbeBadge.jsx";
import WorkspaceSpendCapsPanel from "../provider-routes/WorkspaceSpendCapsPanel.jsx";
import ProviderRoutesIO from "../provider-routes/ProviderRoutesIO.jsx";
import AuditLogSubtab from "../provider-routes/AuditLogSubtab.jsx";
import AiRequestLogSubtab from "../provider-routes/AiRequestLogSubtab.jsx";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Quick-start provider templates shown in the empty state. */
const QUICK_START = [
  {
    family: "anthropic", protocol: "anthropic",
    label: "Anthropic", emoji: "🔶", color: "#e8965a",
    model: "claude-sonnet-4-20250514",
    placeholder: "sk-ant-api03-…",
    docsUrl: "https://console.anthropic.com/settings/keys",
    hint: "Best quality. Claude Sonnet / Opus.",
  },
  {
    family: "openai", protocol: "openai",
    label: "OpenAI", emoji: "🟢", color: "#10a37f",
    model: "gpt-4o-mini",
    placeholder: "sk-proj-…",
    docsUrl: "https://platform.openai.com/api-keys",
    hint: "Fast & affordable. GPT-4o / GPT-4o-mini.",
  },
  {
    family: "google", protocol: "gemini",
    label: "Google", emoji: "🔷", color: "#4285f4",
    model: "gemini-2.5-flash",
    placeholder: "AIza…",
    docsUrl: "https://aistudio.google.com/apikey",
    hint: "Free tier available (20 req/day).",
  },
  {
    family: "openrouter", protocol: "openai",
    label: "OpenRouter", emoji: "🧭", color: "#6466f1",
    model: "openrouter/auto",
    placeholder: "sk-or-v1-…",
    docsUrl: "https://openrouter.ai/keys",
    hint: "200+ models with one key. DeepSeek, Llama, Mistral, etc.",
  },
  {
    family: "local", protocol: "ollama",
    label: "Ollama (Local)", emoji: "🦙", color: "#7c3aed",
    model: "llama3.2:3b",
    placeholder: null,
    docsUrl: "https://ollama.ai",
    hint: "Free, private. Runs on your machine.",
  },
  {
    family: "custom", protocol: "openai",
    label: "Custom / OpenAI-compat", emoji: "🔧", color: "#6b7280",
    model: "",
    placeholder: "sk-…",
    docsUrl: null,
    hint: "Any OpenAI-compatible endpoint (DeepSeek, Groq, xAI, LiteLLM, etc.).",
  },
];

const FORM_EMPTY = {
  id: null,
  name: "",
  family: "anthropic",
  protocol: "anthropic",
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

// ── Small helpers ─────────────────────────────────────────────────────────────

function familyEmoji(row) {
  return row.familyEmoji || { anthropic: "🔶", openai: "🟢", google: "🔷", openrouter: "🧭", local: "🦙", custom: "🔧" }[row.family] || "🤖";
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPayload(form) {
  const payload = {
    name: form.name.trim(),
    family: form.family,
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim() || null,
    model: form.model.trim(),
    enabled: !!form.enabled,
    rpmLimit: numOrNull(form.rpmLimit),
    tpmLimit: numOrNull(form.tpmLimit),
    cacheEnabled: !!form.cacheEnabled,
    cacheTtlSec: numOrNull(form.cacheTtlSec) ?? 0,
    fallbackRouteId: form.fallbackRouteId || null,
  };
  if (form.apiKey && form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
  return payload;
}

// ── Sub-components ────────────────────────────────────────────────────────────

/**
 * Quick-start grid shown when no AI Providers have been configured yet.
 * Clicking a tile pre-fills the Add form with sane defaults for that family.
 */
function EmptyState({ onQuickStart }) {
  return (
    <div className="st-ai-empty">
      <div className="st-ai-empty-title">No AI Providers configured</div>
      <div className="st-ai-empty-sub">
        Each AI Provider is one configured model — add as many as you need.
        Different agents can use different providers.
      </div>
      <div className="st-ai-qs-grid">
        {QUICK_START.map((qs) => (
          <button
            key={qs.family}
            type="button"
            className="st-ai-qs-tile"
            style={{ "--qs-color": qs.color }}
            onClick={() => onQuickStart(qs)}
          >
            <span className="st-ai-qs-emoji">{qs.emoji}</span>
            <span className="st-ai-qs-label">{qs.label}</span>
            <span className="st-ai-qs-hint">{qs.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Add / edit form. Shown inline above the provider list.
 */
function ProviderForm({
  form, setForm, rows, busy, showKey, setShowKey, error, onSave, onCancel,
}) {
  const qs = QUICK_START.find((q) => q.family === form.family) || {};
  const cycleAt = detectFallbackCycle(rows, form.id, form.fallbackRouteId);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Auto-derive protocol when family changes (unless user has touched it)
  function handleFamilyChange(fam) {
    const template = QUICK_START.find((q) => q.family === fam);
    setForm((s) => ({
      ...s,
      family: fam,
      protocol: template?.protocol || s.protocol,
      model: s.model || template?.model || "",
    }));
  }

  return (
    <div className="st-ai-form-wrap card card-padded">
      <div className="st-ai-form-header">
        <span className="font-bold">{form.id ? "Edit AI Provider" : "Add AI Provider"}</span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onCancel}>
          <X size={13} /> Cancel
        </button>
      </div>

      {error && (
        <div className="st-status-err st-ai-form-err">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      <form onSubmit={onSave} className="st-ai-form">
        {/* Row 1: Name + Family + Protocol */}
        <div className="st-pr-form-grid">
          <label className="st-pr-field">
            <span className="st-pr-field-label">Display name</span>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder={qs.label ? `${qs.label} Primary` : "My Provider"}
              required
            />
          </label>

          <label className="st-pr-field">
            <span className="st-pr-field-label">Family</span>
            <select
              className="input"
              value={form.family}
              onChange={(e) => handleFamilyChange(e.target.value)}
            >
              {QUICK_START.map((q) => (
                <option key={q.family} value={q.family}>
                  {q.emoji} {q.label}
                </option>
              ))}
            </select>
          </label>

          <label className="st-pr-field">
            <span className="st-pr-field-label">Protocol</span>
            <select
              className="input"
              value={form.protocol}
              onChange={(e) => setForm((s) => ({ ...s, protocol: e.target.value }))}
            >
              {["openai", "anthropic", "gemini", "ollama"].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>

          <label className="st-pr-field">
            <span className="st-pr-field-label">Model</span>
            <input
              className="input"
              value={form.model}
              onChange={(e) => setForm((s) => ({ ...s, model: e.target.value }))}
              placeholder={qs.model || "model-name"}
              required
            />
          </label>

          {/* Base URL — always shown for custom/openrouter/local; hidden-but-accessible for others */}
          <label className="st-pr-field st-pr-field--wide">
            <span className="st-pr-field-label">
              Base URL
              {!["custom", "local", "openrouter"].includes(form.family) && (
                <span className="text-xs text-muted"> (optional — leave blank for default API)</span>
              )}
            </span>
            <input
              className="input"
              value={form.baseUrl}
              onChange={(e) => setForm((s) => ({ ...s, baseUrl: e.target.value }))}
              placeholder={
                form.family === "local"
                  ? "http://localhost:11434"
                  : form.family === "custom"
                  ? "https://api.example.com/v1"
                  : ""
              }
            />
          </label>

          {/* API key — hidden for Ollama */}
          {form.family !== "local" && (
            <label className="st-pr-field st-pr-field--wide">
              <span className="st-pr-field-label">
                API key
                {form.id && (
                  <span className="text-xs text-muted"> (leave empty to keep existing)</span>
                )}
                {qs.docsUrl && (
                  <a
                    href={qs.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted st-ai-docs-link"
                  >
                    Get key ↗
                  </a>
                )}
              </span>
              <div className="st-key-input-wrap">
                <input
                  className="input"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  value={form.apiKey}
                  onChange={(e) => setForm((s) => ({ ...s, apiKey: e.target.value }))}
                  placeholder={form.id ? "•••• keep stored key" : (qs.placeholder || "sk-…")}
                />
                <button type="button" className="st-key-toggle" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
          )}
        </div>

        {/* Advanced section (rate limits, caching, fallback) */}
        <button
          type="button"
          className="btn btn-ghost btn-xs st-ai-adv-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {showAdvanced ? "Hide advanced" : "Advanced (rate limits, caching, fallback)"}
        </button>

        {showAdvanced && (
          <div className="st-pr-form-grid st-ai-adv-grid">
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
              <span className="st-pr-field-label">Fallback AI Provider</span>
              <select
                className="input"
                value={form.fallbackRouteId}
                onChange={(e) => setForm((s) => ({ ...s, fallbackRouteId: e.target.value }))}
              >
                <option value="">— none —</option>
                {rows
                  .filter((r) => r.id !== form.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {familyEmoji(r)} {r.name}
                      {r.id === cycleAt ? " ⚠ cycle" : ""}
                    </option>
                  ))}
              </select>
              {cycleAt && (
                <span className="st-status-err hint">
                  <AlertCircle size={11} /> Fallback chain would create a cycle.
                </span>
              )}
            </label>
            <label className="st-pr-field st-pr-field--checkbox">
              <input
                type="checkbox"
                checked={form.cacheEnabled}
                onChange={(e) => setForm((s) => ({ ...s, cacheEnabled: e.target.checked }))}
              />
              <span className="st-pr-field-label">Enable response cache</span>
            </label>
            <label className="st-pr-field st-pr-field--checkbox">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((s) => ({ ...s, enabled: e.target.checked }))}
              />
              <span className="st-pr-field-label">Enabled</span>
            </label>
          </div>
        )}

        <div className="st-agent-form-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !!cycleAt}
          >
            {busy ? <RefreshCw size={12} className="spin" /> : null}
            {form.id ? "Update AI Provider" : "Add AI Provider"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Single provider row card in the list.
 */
function ProviderRow({
  row, rows, rowState, rotateOpen, setRotateOpen, rotateBuf, setRotateBuf,
  onEdit, onDelete, onProbe, onRotate,
}) {
  const probing  = rowState?.kind === "probing";
  const rotating = rowState?.kind === "rotating";
  const deleting = rowState?.kind === "deleting";
  const liveCaps = rowState?.kind === "ok" && rowState.caps ? rowState.caps : null;
  const fallbackRow = row.fallbackRouteId
    ? rows.find((r) => r.id === row.fallbackRouteId)
    : null;

  return (
    <div className={`card-padded-sm st-pr-row st-ai-row${!row.enabled ? " st-ai-row--disabled" : ""}`}>
      <div className="st-pr-row-header">
        <div className="st-pr-row-name">
          <span className="st-ai-row-emoji">{familyEmoji(row)}</span>
          <span className="font-semi">{row.name}</span>
          {!row.enabled && <span className="st-pr-badge st-pr-badge--disabled">Disabled</span>}
          <ProbeBadge capabilities={row.capabilities} live={liveCaps} />
        </div>
        <div className="text-xs text-muted st-pr-row-meta">
          {row.model || "—"}
          {row.costTier && <span className="st-ai-cost-tier"> · {row.costTier}</span>}
          {row.baseUrl && <span> · {row.baseUrl}</span>}
          {row.apiKeyLastFour && (
            <span className="text-mono"> · {maskedKeyDisplay(row.apiKeyLastFour)}</span>
          )}
        </div>
        <div className="text-xs text-muted st-pr-row-meta">
          {`rpm ${row.rpmLimit ?? "∞"} · tpm ${row.tpmLimit ?? "∞"}`}
          {row.cacheEnabled ? ` · cache ${row.cacheTtlSec || 0}s` : " · no cache"}
          {fallbackRow ? ` · fallback → ${familyEmoji(fallbackRow)} ${fallbackRow.name}` : ""}
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
          title="Send a real network probe to verify reachability, auth, and model."
        >
          {probing ? <RefreshCw size={11} className="spin" /> : <Activity size={11} />}
          {row.capabilities ? "Re-probe" : "Test"}
        </button>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => setRotateOpen(rotateOpen === row.id ? null : row.id)}
          disabled={rotating}
          title="Replace the stored API key."
        >
          <KeyRound size={11} /> Rotate key
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => onEdit(row)}>Edit</button>
        <button
          className="btn btn-danger btn-xs"
          onClick={() => onDelete(row.id)}
          disabled={deleting}
        >
          {deleting ? <RefreshCw size={11} className="spin" /> : <Trash2 size={11} />}
          Delete
        </button>
      </div>

      {rotateOpen === row.id && (
        <div className="st-pr-rotate-panel">
          <div className="st-key-input-wrap st-pr-rotate-input">
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder="New API key"
              value={rotateBuf[row.id] || ""}
              onChange={(e) => setRotateBuf((s) => ({ ...s, [row.id]: e.target.value }))}
            />
          </div>
          <button
            className="btn btn-primary btn-xs"
            disabled={rotating || !(rotateBuf[row.id] || "").trim()}
            onClick={() => onRotate(row.id, rotateBuf[row.id] || "")}
          >
            {rotating ? <RefreshCw size={11} className="spin" /> : <Check size={11} />}
            {rotating ? "Rotating…" : "Rotate & probe"}
          </button>
          {rowState?.kind === "ok" && <span className="st-status-ok"><Check size={11} /> Rotated</span>}
        </div>
      )}
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

/**
 * AI Providers section — merged replacement for the old "Providers" (family
 * key cards) and "Provider Routes" (named model CRUD) tabs (provider-rename).
 *
 * Mental model: each configured model = one AI Provider. 8 models → 8
 * independent selectable providers for Agent Roles. The old family-card
 * layer and the "route" abstraction are collapsed into one surface so
 * operators never have to configure the same endpoint in two places.
 */
export default function AiProvidersSection() {
  const [rows, setRows]           = useState([]);
  const [form, setForm]           = useState(FORM_EMPTY);
  const [showForm, setShowForm]   = useState(false);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [busy, setBusy]           = useState(false);
  const [showKey, setShowKey]     = useState(false);
  const [rowState, setRowState]   = useState({});   // { [id]: { kind, msg?, caps? } }
  const [rotateBuf, setRotateBuf] = useState({});   // plaintext key buffers, never persisted
  const [rotateOpen, setRotateOpen] = useState(null);
  const [ioBusy, setIoBusy]       = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [activeTab, setActiveTab] = useState("providers"); // "providers" | "spend" | "audit" | "requests"

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listAiProviders();
      setRows(res?.routes || []);
    } catch (err) {
      setError(err.message || "Failed to load AI Providers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setForm(FORM_EMPTY);
    setError("");
    setShowKey(false);
    setShowForm(false);
  }

  function openAddForm() {
    setError("");
    setForm(FORM_EMPTY);
    setShowKey(false);
    setShowForm(true);
  }

  function quickStart(template) {
    setError("");
    setForm({
      ...FORM_EMPTY,
      family:   template.family,
      protocol: template.protocol,
      model:    template.model,
      name:     `${template.label} (primary)`,
    });
    setShowForm(true);
  }

  function editRow(row) {
    setError("");
    setForm({
      id:            row.id,
      name:          row.name || "",
      family:        row.family || "openai",
      protocol:      row.protocol || "openai",
      baseUrl:       row.baseUrl || "",
      model:         row.model || "",
      apiKey:        "",
      enabled:       row.enabled === 1 || row.enabled === true,
      rpmLimit:      row.rpmLimit ?? "",
      tpmLimit:      row.tpmLimit ?? "",
      cacheEnabled:  row.cacheEnabled === 1 || row.cacheEnabled === true,
      cacheTtlSec:   row.cacheTtlSec ?? "",
      fallbackRouteId: row.fallbackRouteId || "",
    });
    setShowForm(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError("");
    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!form.model.trim()) { setError("Model is required."); return; }
    setBusy(true);
    try {
      const payload = buildPayload(form);
      if (form.id) {
        await api.updateAiProvider(form.id, payload);
      } else {
        await api.createAiProvider(payload);
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err.message || "Failed to save AI Provider.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this AI Provider? Agent roles using it will need to be reassigned.")) return;
    setRowState((s) => ({ ...s, [id]: { kind: "deleting" } }));
    try {
      await api.deleteAiProvider(id);
      await load();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message } }));
    }
  }

  async function handleProbe(id) {
    setRowState((s) => ({ ...s, [id]: { kind: "probing" } }));
    try {
      const res = await api.probeAiProvider(id);
      setRowState((s) => ({
        ...s,
        [id]: { kind: res.ok ? "ok" : "err", caps: res.capabilities, msg: !res.ok ? "Probe failed" : null },
      }));
      // Refresh so capabilities badge updates
      await load();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message } }));
    }
  }

  async function handleRotate(id, key) {
    setRowState((s) => ({ ...s, [id]: { kind: "rotating" } }));
    try {
      await api.rotateAiProviderKey(id, key);
      setRotateBuf((s) => ({ ...s, [id]: "" }));
      setRotateOpen(null);
      setRowState((s) => ({ ...s, [id]: { kind: "ok" } }));
      await load();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { kind: "err", msg: err.message } }));
    }
  }

  // ── Import / export ─────────────────────────────────────────────────────

  async function handleExport() {
    setIoBusy(true);
    setImportMsg(null);
    try {
      const payload = await api.exportRoutes();
      const count = payload?.routes?.length ?? 0;
      setImportMsg({ type: "ok", text: `Exported ${count} provider(s).` });
    } catch (err) {
      setImportMsg({ type: "err", text: err.message || "Export failed." });
    } finally {
      setIoBusy(false);
    }
  }

  async function handleImport(file, mode) {
    setIoBusy(true);
    setImportMsg(null);
    try {
      const res = await api.importRoutes(file, mode);
      await load();
      const parts = [];
      if (res.created)    parts.push(`${res.created} created`);
      if (res.overwritten) parts.push(`${res.overwritten} overwritten`);
      if (res.renamed)    parts.push(`${res.renamed} renamed`);
      if (res.skipped)    parts.push(`${res.skipped} skipped`);
      if (res.errors?.length) {
        parts.push(`${res.errors.length} error${res.errors.length === 1 ? "" : "s"}`);
        // eslint-disable-next-line no-console
        console.warn("[AI Providers import] errors:", res.errors);
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

  // ── Render ───────────────────────────────────────────────────────────────

  const TAB_LABELS = [
    { key: "providers", label: "AI Providers" },
    { key: "spend",     label: "Spend Caps" },
    { key: "audit",     label: "Audit Log" },
    { key: "requests",  label: "Request Log" },
  ];

  return (
    <div>
      <SectionTitle
        title="AI Providers"
        sub={
          "Each configured model is one AI Provider. Add as many as you need — " +
          "every provider can be independently assigned to an Agent Role."
        }
      />

      {/* Section tabs */}
      <div className="st-pr-subtabs">
        {TAB_LABELS.map((t) => (
          <button
            key={t.key}
            className={`btn btn-ghost btn-xs${activeTab === t.key ? " st-pr-subtab--active" : ""}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── AI Providers list tab ── */}
      {activeTab === "providers" && (
        <div className="card card-padded">
          {error && (
            <div className="st-status-err st-ai-error">
              <AlertCircle size={12} /> {error}
            </div>
          )}

          {/* Add form (shown inline) */}
          {showForm && (
            <ProviderForm
              form={form}
              setForm={setForm}
              rows={rows}
              busy={busy}
              showKey={showKey}
              setShowKey={setShowKey}
              error={error}
              onSave={handleSave}
              onCancel={resetForm}
            />
          )}

          {/* Header: count + add button */}
          {!showForm && (
            <div className="st-ai-list-header">
              <span className="text-xs text-muted">
                {loading ? "Loading…" : `${rows.length} AI Provider${rows.length !== 1 ? "s" : ""} configured`}
              </span>
              <div className="st-ai-list-actions">
                <ProviderRoutesIO
                  busy={ioBusy}
                  onExport={handleExport}
                  onImport={handleImport}
                  importMsg={importMsg}
                />
                <button className="btn btn-primary btn-sm" onClick={openAddForm}>
                  <Plus size={13} /> Add AI Provider
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!loading && !showForm && rows.length === 0 && (
            <EmptyState onQuickStart={quickStart} />
          )}

          {/* Provider list */}
          {!loading && rows.length > 0 && (
            <div className="st-ai-rows">
              {rows.map((row) => (
                <ProviderRow
                  key={row.id}
                  row={row}
                  rows={rows}
                  rowState={rowState[row.id]}
                  rotateOpen={rotateOpen}
                  setRotateOpen={setRotateOpen}
                  rotateBuf={rotateBuf}
                  setRotateBuf={setRotateBuf}
                  onEdit={editRow}
                  onDelete={handleDelete}
                  onProbe={handleProbe}
                  onRotate={handleRotate}
                />
              ))}
            </div>
          )}

          {/* Tip when providers exist and form is hidden */}
          {!showForm && rows.length > 0 && (
            <div className="hint st-ai-tip">
              💡 Assign providers to pipeline agents in <strong>Agent Roles</strong>.
              Each provider above is independently selectable.
            </div>
          )}
        </div>
      )}

      {activeTab === "spend"    && <WorkspaceSpendCapsPanel />}
      {activeTab === "audit"    && <AuditLogSubtab rows={rows} />}
      {activeTab === "requests" && <AiRequestLogSubtab rows={rows} />}
    </div>
  );
}

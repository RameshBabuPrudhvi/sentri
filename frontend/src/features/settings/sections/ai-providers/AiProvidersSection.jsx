import React, { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertCircle, Check, ChevronDown, ChevronUp,
  Eye, EyeOff, Info, KeyRound, Plus, RefreshCw, Star, Trash2, Wifi, WifiOff, X,
} from "lucide-react";
import { api } from "../../../../api.js";
import { FAMILY_EMOJI } from "../../../../config.js";
import SectionTitle from "../../shared/SectionTitle.jsx";
import { useOllamaStatusQuery } from "../../../../hooks/queries/useSettingsQueries.js";
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
  return row.familyEmoji || FAMILY_EMOJI[row.family] || "🤖";
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Translate the GET /settings response (env-detected provider keys + Ollama
 * config + compat slots) into a flat list of read-only provider rows for the
 * "Configured via .env" banner. Skips families that already have a
 * provider_routes row (operator has migrated them) so we don't double-list.
 *
 * @param {Object|null} settings - GET /settings payload (`getConfiguredKeys()`).
 * @param {Array} dbRows - Existing AI Providers (from listAiProviders()).
 * @returns {Array<{family,label,emoji,detail}>}
 */
function buildEnvProviderList(settings, dbRows) {
  if (!settings) return [];
  const haveFamily = new Set(dbRows.map((r) => r.family));
  const out = [];
  // Cloud providers — `settings[family]` is a masked key string when set.
  const CLOUD = [
    { family: "anthropic",  label: "Anthropic",  emoji: "🔶", env: "ANTHROPIC_API_KEY" },
    { family: "openai",     label: "OpenAI",     emoji: "🟢", env: "OPENAI_API_KEY" },
    { family: "google",     label: "Google",     emoji: "🔷", env: "GOOGLE_API_KEY" },
    { family: "openrouter", label: "OpenRouter", emoji: "🧭", env: "OPENROUTER_API_KEY" },
  ];
  for (const c of CLOUD) {
    const masked = settings[c.family];
    if (!masked || haveFamily.has(c.family)) continue;
    out.push({
      family: c.family,
      label: c.label,
      emoji: c.emoji,
      detail: `${c.env} · ${masked}`,
    });
  }
  // Ollama — env-driven via OLLAMA_BASE_URL + AI_PROVIDER=local.
  if (settings.ollamaConfigured && !haveFamily.has("local")) {
    out.push({
      family: "local",
      label: "Ollama (Local)",
      emoji: "🦙",
      detail: `${settings.ollamaBaseUrl || "http://localhost:11434"} · ${settings.ollamaModel || "model?"}`,
    });
  }
  // Compat slots (any OpenAI-compatible endpoint persisted via the legacy
  // compat form). These pre-date the merged section and remain visible here
  // so operators don't lose sight of them.
  for (const cp of settings.compatProviders || []) {
    out.push({
      family: "custom",
      label: cp.displayName || cp.provider,
      emoji: "🔧",
      detail: `${cp.baseUrl || "—"} · ${cp.model || "model?"}`,
    });
  }
  return out;
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
 * Compact Ollama connectivity badge shown inside the form when `family === "local"`.
 * Replaces the deleted OllamaStatusPanel.jsx with a single-line status +
 * available-models dropdown. Uses the existing `useOllamaStatusQuery` hook
 * (GET /ollama/status) which auto-refreshes every 15s.
 */
function OllamaStatusHint({ form, setForm }) {
  const statusQuery = useOllamaStatusQuery();
  const status = statusQuery.data ?? null;
  const checking = statusQuery.isFetching;

  return (
    <div className="st-pr-field st-pr-field--wide">
      <div className="st-ai-ollama-status">
        {checking
          ? <><RefreshCw size={12} className="spin" /> <span className="text-xs text-muted">Checking Ollama…</span></>
          : status?.ok
          ? <><Wifi size={12} className="st-ai-ollama-ok-icon" /> <span className="text-xs st-ai-ollama-ok">Connected · {status.model}</span></>
          : <><WifiOff size={12} className="st-ai-ollama-err-icon" /> <span className="text-xs st-ai-ollama-err">{status?.error?.slice(0, 80) || "Ollama not reachable"}</span></>}
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => statusQuery.refetch()}
          disabled={checking}
        >
          <RefreshCw size={10} /> Check
        </button>
      </div>
      {status?.availableModels?.length > 0 && (
        <select
          className="input"
          value={form.model}
          onChange={(e) => setForm((s) => ({ ...s, model: e.target.value }))}
        >
          {status.availableModels.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      )}
      {!status?.ok && !checking && (
        <div className="hint text-xs text-muted st-ai-ollama-hint">
          Install: <code>curl -fsSL https://ollama.ai/install.sh | sh && ollama pull {form.model || "llama3.2:3b"}</code>
        </div>
      )}
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

      <form onSubmit={onSave} className="st-ai-form" aria-label={form.id ? "Edit AI Provider" : "Add AI Provider"}>
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

          {/* Ollama status — inline connectivity check when configuring a local provider.
              Replaces the deleted OllamaStatusPanel.jsx with a compact badge + model
              suggestions. Uses the same useOllamaStatusQuery hook (GET /ollama/status). */}
          {form.family === "local" && <OllamaStatusHint form={form} setForm={setForm} />}

          {/* Base URL — always shown for custom/openrouter/local; hidden-but-accessible for others.
              name="ai-provider-base-url" + autoComplete="off" prevent password managers
              from filling this with the user's email (Chrome/Safari/1Password all
              match unlabelled inputs inside a <form> as login fields). */}
          <label className="st-pr-field st-pr-field--wide">
            <span className="st-pr-field-label">
              Base URL
              {!["custom", "local", "openrouter"].includes(form.family) && (
                <span className="text-xs text-muted"> (optional — leave blank for default API)</span>
              )}
            </span>
            <input
              className="input"
              name="ai-provider-base-url"
              autoComplete="off"
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

          {/* API key — hidden for Ollama.
              autoComplete="new-password" is the WHATWG-recommended value for
              one-off secret entry — it suppresses the "Save password?" prompt
              that fires on plain autoComplete="off" in Chrome and prevents
              password managers from autofilling stored credentials. */}
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
                  name="ai-provider-api-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="new-password"
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

        {/* Fallback provider — promoted out of "Advanced" because for an
            autonomous-QA platform this is the central multi-provider story.
            Runtime fallback (registry.js + retry.js) walks this chain when
            the primary hits 429/5xx, sticks to the survivor for the rest of
            the run, and only stops calling once every fallback is exhausted. */}
        {rows.filter((r) => r.id !== form.id).length > 0 && (
          <div className="st-ai-fallback-field">
            <label className="st-pr-field">
              <span className="st-pr-field-label">
                Fallback AI Provider <span className="text-xs text-muted">(used on rate-limit or outage)</span>
              </span>
              <select
                className="input"
                value={form.fallbackRouteId}
                onChange={(e) => setForm((s) => ({ ...s, fallbackRouteId: e.target.value }))}
              >
                <option value="">— none (fail when this provider is exhausted) —</option>
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
          </div>
        )}

        {/* Advanced section (rate limits, caching, enabled toggle) */}
        <button
          type="button"
          className="btn btn-ghost btn-xs st-ai-adv-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {showAdvanced ? "Hide advanced" : "Advanced (rate limits, caching)"}
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
 * Walk the fallback chain starting at `startId` and return the ordered list
 * of routes the dispatcher would try on durable failure. Stops at the first
 * cycle or missing link, capped at 8 hops (industry-standard autonomous-QA
 * runs never need deeper chains; the backend caps cycles at 64).
 *
 * @param {string|null} startId
 * @param {Array} allRows
 * @returns {Array} Chain WITHOUT the starting row (so it can be rendered as `start → chain[0] → chain[1]…`).
 */
function walkFallbackChain(startId, allRows) {
  const byId = new Map(allRows.map((r) => [r.id, r]));
  const chain = [];
  const seen = new Set();
  let next = startId;
  while (next && chain.length < 8) {
    if (seen.has(next)) break;
    seen.add(next);
    const row = byId.get(next);
    if (!row) break;
    chain.push(row);
    next = row.fallbackRouteId || null;
  }
  return chain;
}

/**
 * Single provider row card in the list.
 */
function ProviderRow({
  row, rows, rowState, rotateOpen, setRotateOpen, rotateBuf, setRotateBuf,
  onEdit, onDelete, onProbe, onRotate, onSetDefault,
}) {
  const probing  = rowState?.kind === "probing";
  const rotating = rowState?.kind === "rotating";
  const deleting = rowState?.kind === "deleting";
  const settingDefault = rowState?.kind === "default";
  const liveCaps = rowState?.kind === "ok" && rowState.caps ? rowState.caps : null;
  // Migration 059 — workspace default flag. Backend returns `1` (pinned)
  // or `null` (not pinned). The star action toggles between the two via
  // POST /settings/ai-providers/:id/default.
  const isDefault = row.isWorkspaceDefault === 1 || row.isWorkspaceDefault === true;
  // Walk the full fallback chain so operators see the actual runtime
  // dispatch order at a glance — not just the next hop. This is the central
  // visual story for the autonomous-QA fallback model.
  const fallbackChain = walkFallbackChain(row.fallbackRouteId, rows);
  // Reverse reference from agent_configs (backend joins on every list call).
  // Tells operators which pipeline agents actually dispatch against this
  // provider — closing the loop between AI Providers and Agent Roles
  // without forcing a tab switch.
  const usedByRoles = row.usedByRoles || [];

  return (
    <div className={`card-padded-sm st-pr-row st-ai-row${!row.enabled ? " st-ai-row--disabled" : ""}`} role="listitem" aria-label={`${row.name} — ${row.family}`}>
      <div className="st-pr-row-header">
        <div className="st-pr-row-name">
          <span className="st-ai-row-emoji">{familyEmoji(row)}</span>
          <span className="font-semi">{row.name}</span>
          {isDefault && (
            <span
              className="st-pr-badge st-ai-default-badge"
              title="Workspace default — used by every agent role that has no per-role override."
            >
              <Star size={10} /> Default
            </span>
          )}
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
        </div>

        {/* Fallback chain — rendered as a visible sequence so operators see
            the actual runtime dispatch order. Hidden when no fallback is
            configured (the most common single-provider case). */}
        {fallbackChain.length > 0 && (
          <div className="st-ai-fallback-chain" title="Runtime fallback order — used when a provider hits rate limits or 5xx errors.">
            <span className="st-ai-fallback-label">Fallback:</span>
            <span className="st-ai-fallback-step">
              <span className="st-ai-row-emoji">{familyEmoji(row)}</span>
              {row.name}
            </span>
            {fallbackChain.map((step) => (
              <React.Fragment key={step.id}>
                <span className="st-ai-fallback-arrow">→</span>
                <span className="st-ai-fallback-step">
                  <span className="st-ai-row-emoji">{familyEmoji(step)}</span>
                  {step.name}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Reverse reference — which pipeline agent roles dispatch through
            this provider. Critical for the multi-agent mental model: an
            unassigned provider is dead weight; a provider assigned to many
            roles is load-bearing infrastructure. */}
        {usedByRoles.length > 0 ? (
          <div className="st-ai-used-by">
            <span className="text-xs text-muted">Used by:</span>
            {usedByRoles.map((role) => (
              <span key={role} className="st-pr-badge st-ai-role-chip">{role}</span>
            ))}
          </div>
        ) : isDefault ? (
          <div className="st-ai-used-by">
            <span className="text-xs text-muted">
              Used by every agent role with no per-role override (workspace default).
            </span>
          </div>
        ) : (
          <div className="st-ai-used-by st-ai-used-by--none">
            <span className="text-xs text-muted">
              Not assigned to any role — pin as workspace default or assign in Agent Roles.
            </span>
          </div>
        )}

        {rowState?.kind === "err" && (
          <div className="st-status-err st-pr-row-error">
            <AlertCircle size={11} /> {rowState.msg}
          </div>
        )}
      </div>

      <div className="st-pr-row-actions">
        <button
          className={`btn btn-xs ${isDefault ? "btn-primary" : "btn-ghost"} st-ai-default-btn`}
          onClick={() => onSetDefault(row.id, !isDefault)}
          disabled={settingDefault || !row.enabled}
          title={
            isDefault
              ? "Clear workspace default — unassigned roles will fall back to env detection."
              : "Pin as the workspace default. Every agent role with no per-role override will dispatch through this provider."
          }
        >
          {settingDefault
            ? <RefreshCw size={11} className="spin" />
            : <Star size={11} fill={isDefault ? "currentColor" : "none"} />}
          {isDefault ? "Unpin default" : "Set as default"}
        </button>
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
        <button className="btn btn-ghost btn-xs" onClick={() => onEdit(row)} aria-label={`Edit ${row.name}`}>Edit</button>
        <button
          className="btn btn-danger btn-xs"
          onClick={() => onDelete(row.id)}
          disabled={deleting}
          aria-label={`Delete ${row.name}`}
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
  // Env-injected providers (ANTHROPIC_API_KEY / GOOGLE_API_KEY / OLLAMA_BASE_URL,
  // etc.) live outside `provider_routes` — they're surfaced via GET /settings
  // (`getConfiguredKeys()` in backend/src/aiProvider/providerInfo.js). Fetched
  // alongside the DB routes so operators see env-configured Gemini / Ollama in
  // this section instead of wondering "why isn't my .env key showing up?".
  const [envProviders, setEnvProviders] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [routesRes, settingsRes] = await Promise.all([
        api.listAiProviders(),
        api.getSettings().catch(() => null),
      ]);
      setRows(routesRes?.routes || []);
      setEnvProviders(buildEnvProviderList(settingsRes, routesRes?.routes || []));
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

  // Migration 059 — pin / unpin the workspace default. Reloads after success
  // because setting THIS row as default clears the flag on whichever row had
  // it before, so we need the full list to refresh.
  async function handleSetDefault(id, isDefault) {
    setRowState((s) => ({ ...s, [id]: { kind: "default" } }));
    try {
      await api.setAiProviderDefault(id, isDefault);
      await load();
      setRowState((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
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

      {/* Section tabs — WAI-ARIA tablist pattern (matches TestLab topbar). */}
      <div className="st-pr-subtabs" role="tablist" aria-label="AI Providers sections">
        {TAB_LABELS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={activeTab === t.key}
            aria-controls={`st-ai-tabpanel-${t.key}`}
            className={`btn btn-ghost btn-xs${activeTab === t.key ? " st-pr-subtab--active" : ""}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── AI Providers list tab ── */}
      {activeTab === "providers" && (
        <div className="card card-padded" id="st-ai-tabpanel-providers" role="tabpanel" aria-label="AI Providers">
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

          {/* Env-injected providers (read-only) — surfaces ANTHROPIC_API_KEY /
              GOOGLE_API_KEY / OLLAMA_BASE_URL / compat-slot configs that
              aren't backed by a provider_routes row. Without this banner,
              env-only deployments saw an empty section after the
              providers ↔ provider_routes merge. */}
          {!showForm && envProviders.length > 0 && (
            <div className="st-ai-env-banner">
              <div className="st-ai-env-banner-title">
                <Info size={12} /> Configured via environment variables
              </div>
              <div className="st-ai-env-banner-sub">
                These are detected from your <code>.env</code> file and used as
                fallback providers. To assign them to specific Agent Roles or
                set rate limits, click <strong>Adopt</strong> to create a
                manageable AI Provider row.
              </div>
              <div className="st-ai-env-rows">
                {envProviders.map((p, i) => (
                  <div key={`${p.family}-${i}`} className="st-ai-env-row">
                    <span className="st-ai-row-emoji">{p.emoji}</span>
                    <span className="font-semi">{p.label}</span>
                    <span className="text-xs text-muted st-pr-row-meta">
                      {p.detail}
                    </span>
                    <span className="st-pr-badge st-ai-env-badge">from .env</span>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => quickStart(
                        QUICK_START.find((q) => q.family === p.family) || QUICK_START[0],
                      )}
                      title="Pre-fill the Add form with this family so you can save it as a managed AI Provider."
                    >
                      Adopt
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {!loading && !showForm && rows.length === 0 && envProviders.length === 0 && (
            <EmptyState onQuickStart={quickStart} />
          )}

          {/* Provider list */}
          {!loading && rows.length > 0 && (
            <div className="st-ai-rows" role="list" aria-label="Configured AI Providers">
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
                  onSetDefault={handleSetDefault}
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

      {activeTab === "spend"    && <div id="st-ai-tabpanel-spend" role="tabpanel" aria-label="Spend Caps"><WorkspaceSpendCapsPanel /></div>}
      {activeTab === "audit"    && <div id="st-ai-tabpanel-audit" role="tabpanel" aria-label="Audit Log"><AuditLogSubtab rows={rows} /></div>}
      {activeTab === "requests" && <div id="st-ai-tabpanel-requests" role="tabpanel" aria-label="Request Log"><AiRequestLogSubtab rows={rows} /></div>}
    </div>
  );
}

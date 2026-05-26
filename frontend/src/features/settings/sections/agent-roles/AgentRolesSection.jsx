import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, Check, Info, RefreshCw,
} from "lucide-react";
import { api } from "../../../../api.js";
import { AGENT_ROLES, FAMILY_EMOJI } from "../../../../config.js";
import SectionTitle from "../../shared/SectionTitle.jsx";

/**
 * Agent Roles section (AI-005 + provider-rename refactor).
 *
 * Maps each pipeline agent role to an AI Provider (formerly "provider route").
 * The rich dropdown now shows: familyEmoji + provider name + cost tier so
 * operators can make informed choices without opening a second tab.
 *
 * Unassigned roles show "Workspace default (no per-role override)" and
 * dispatch falls back to the workspace-level env-var provider — same
 * behaviour as before, just surfaced more clearly.
 *
 * Extracted from Settings.jsx (GAP-002). Updated for provider-rename (B4.x).
 */

function providerEmoji(r) {
  return r.familyEmoji || FAMILY_EMOJI[r.family] || "🤖";
}

/** Human label for a saved row's linked provider. */
function resolveProviderLabel(routeId, providerMap) {
  if (!routeId) return "workspace default";
  const p = providerMap.get(routeId);
  if (!p) return `${routeId} (provider missing)`;
  return `${providerEmoji(p)} ${p.name}${p.costTier ? ` · ${p.costTier}` : ""}`;
}

const ROLE_DESCRIPTIONS = {
  supervisor: "Orchestrate autonomous-mode handoffs",
  explorer: "Crawl & classify pages",
  planner:  "Map user journeys",
  author:   "Write test code",
  oracle:   "Strengthen assertions",
  reviewer: "Quality gate",
  healer:   "Fix broken selectors",
  triager:  "Classify failures",
};

// AUTO-023 B4.1 — `supervisor` is a specialized orchestration role used
// only in autonomous mode. Default the "new role" form to the first
// non-supervisor role (`explorer`) so admins configuring per-role routes
// for the first time aren't dropped on a role most workspaces never
// configure explicitly.
const DEFAULT_NEW_ROLE = AGENT_ROLES.find((r) => r !== "supervisor") || AGENT_ROLES[0];

const EMPTY_FORM = {
  role: DEFAULT_NEW_ROLE,
  routeId: "",
  systemPromptOverride: "",
  temperature: 0.2,
  maxTokens: "",
};

export default function AgentRolesSection() {
  const [rows, setRows]           = useState([]);
  const [providers, setProviders] = useState([]);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [editingRole, setEditingRole] = useState("");
  const [error, setError]         = useState("");
  const [busy, setBusy]           = useState(false);
  const [probes, setProbes]       = useState({});
  const [agentMode, setAgentMode] = useState("pipeline");

  const load = useCallback(async () => {
    try {
      const [r, modeRes, provRes] = await Promise.all([
        api.getAgentRoles(),
        api.getAgentMode().catch(() => ({ mode: "pipeline" })),
        // Prefer the enriched ai-providers endpoint (displayLabel, familyEmoji,
        // costTier). Fall back to the old provider-routes endpoint gracefully.
        api.listAiProviders().catch(() => api.listProviderRoutes().catch(() => ({ routes: [] }))),
      ]);
      setRows(r.roles || []);
      setAgentMode(modeRes?.mode || "pipeline");
      setProviders((provRes?.routes || []).filter((p) => p.enabled !== false && p.enabled !== 0));
    } catch (err) {
      setError(err.message || "Failed to load agent roles.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const providerMap = useMemo(() => {
    const m = new Map();
    for (const p of providers) m.set(p.id, p);
    return m;
  }, [providers]);

  // Roles already configured — disable them in the "new role" select.
  const configuredRoles = useMemo(() => new Set(rows.map((r) => r.role)), [rows]);

  async function save(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const payload = {
        role: form.role,
        routeId: form.routeId || null,
        systemPromptOverride: form.systemPromptOverride || null,
        temperature: form.temperature,
        maxTokens: form.maxTokens ? Number(form.maxTokens) : null,
        fallbackRole: null, // deprecated B3.2 — fallback lives on the provider
      };
      if (editingRole) await api.updateAgentRole(editingRole, payload);
      else             await api.createAgentRole(payload);
      setEditingRole("");
      setForm(EMPTY_FORM);
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
    setForm({
      role:                 row.role,
      routeId:              row.routeId || "",
      systemPromptOverride: row.systemPromptOverride || "",
      temperature:          row.temperature ?? 0.2,
      maxTokens:            row.maxTokens ?? "",
    });
  }

  async function del(role) {
    setError("");
    try {
      await api.deleteAgentRole(role);
      if (editingRole === role) { setEditingRole(""); setForm(EMPTY_FORM); }
      await load();
    } catch (err) {
      setError(err.message || "Failed to delete agent role.");
    }
  }

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


  async function saveMode(nextMode) {
    try {
      setBusy(true);
      const res = await api.setAgentMode(nextMode);
      setAgentMode(res?.mode || nextMode);
    } catch (err) {
      setError(err.message || "Failed to save agent mode.");
    } finally {
      setBusy(false);
    }
  }

  // Roles available for new assignment (unassigned, or the one being edited)
  const availableRoles = AGENT_ROLES.filter(
    (r) => !configuredRoles.has(r) || r === editingRole,
  );

  return (
    <div>
      <SectionTitle
        title="Agent Roles"
        sub={
          "Assign an AI Provider to each pipeline agent. " +
          "Unassigned roles use the workspace default. " +
          "Each AI Provider is configured under AI Providers."
        }
      />


      <div className="card card-padded" style={{ marginBottom: 12 }}>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Mode</span>
          <select
            className="input"
            value={agentMode}
            onChange={(e) => saveMode(e.target.value)}
            title="Autonomous mode enables supervisor-driven orchestration (higher cost/latency, stronger adaptive routing)."
          >
            <option value="pipeline">Pipeline</option>
            <option value="envelope">Envelope</option>
            <option value="autonomous">Autonomous</option>
          </select>
        </label>
      </div>

      <div className="card card-padded">
        {error && (
          <div className="st-status-err st-agent-error">
            <AlertCircle size={12} /> {error}
          </div>
        )}

        {/* ── Form ── */}
        <form onSubmit={save} className="st-agent-form">
          {/* Role selector */}
          <label className="st-pr-field">
            <span className="st-pr-field-label">Agent role</span>
            <select
              className="input"
              value={form.role}
              onChange={(e) => setForm((s) => ({ ...s, role: e.target.value }))}
              disabled={!!editingRole}
            >
              {editingRole
                ? <option value={editingRole}>{editingRole}</option>
                : availableRoles.map((r) => (
                    <option key={r} value={r}>
                      {r}{ROLE_DESCRIPTIONS[r] ? ` — ${ROLE_DESCRIPTIONS[r]}` : ""}
                    </option>
                  ))}
            </select>
          </label>

          {/* AI Provider selector — the key UX improvement */}
          <label className="st-pr-field st-pr-field--wide">
            <span className="st-pr-field-label">AI Provider</span>
            <select
              className="input st-agent-provider-select"
              value={form.routeId}
              onChange={(e) => setForm((s) => ({ ...s, routeId: e.target.value }))}
              title="The AI Provider this role dispatches against. Leave empty to use the workspace default."
            >
              <option value="">⚙️ Workspace default (no per-role override)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerEmoji(p)} {p.name} · {p.model || "?"}
                  {p.costTier ? ` · ${p.costTier}` : ""}
                </option>
              ))}
            </select>
          </label>

          {providers.length === 0 && (
            <div className="hint st-agent-fallback-deprecation">
              <Info size={11} />
              <span>
                No AI Providers configured yet — add one in{" "}
                <a href="/settings/ai_providers"><strong>AI Providers</strong></a>.
              </span>
            </div>
          )}

          {/* Advanced: system prompt override + temperature + maxTokens */}
          <label className="st-pr-field st-pr-field--wide">
            <span className="st-pr-field-label">System prompt override <span className="text-muted">(optional)</span></span>
            <textarea
              className="input"
              placeholder="Leave blank to use the built-in system prompt for this agent"
              value={form.systemPromptOverride}
              onChange={(e) => setForm((s) => ({ ...s, systemPromptOverride: e.target.value }))}
              rows={3}
            />
          </label>

          <div className="st-pr-form-grid">
            <label className="st-pr-field">
              <span className="st-pr-field-label">Temperature</span>
              <input
                className="input"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={form.temperature}
                onChange={(e) => setForm((s) => ({ ...s, temperature: Number(e.target.value) }))}
              />
            </label>
            <label className="st-pr-field">
              <span className="st-pr-field-label">Max tokens <span className="text-muted">(optional)</span></span>
              <input
                className="input"
                type="number"
                placeholder="model default"
                value={form.maxTokens}
                onChange={(e) => setForm((s) => ({ ...s, maxTokens: e.target.value }))}
              />
            </label>
          </div>

          {/* Fallback-on-provider deprecation note */}
          <div className="hint st-agent-fallback-deprecation">
            <Info size={11} />
            <span>
              Per-role fallback is now configured on the provider's{" "}
              <strong>Fallback AI Provider</strong> field in AI Providers.
            </span>
          </div>

          <div className="st-agent-form-actions">
            <button className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? <RefreshCw size={11} className="spin" /> : null}
              {editingRole ? "Update role" : "Save role"}
            </button>
            {editingRole && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => { setEditingRole(""); setForm(EMPTY_FORM); setError(""); }}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>

        {/* ── Configured roles list ── */}
        <div className="st-agent-rows">
          {rows.length === 0 && (
            <div className="text-sm text-muted st-pr-empty">
              No agent roles configured — all pipeline agents use the workspace default AI Provider.
            </div>
          )}
          {rows.map((r) => {
            const probe = probes[r.role];
            const providerLabel = resolveProviderLabel(r.routeId, providerMap);
            const linkedProvider = r.routeId ? providerMap.get(r.routeId) : null;
            return (
              <div key={r.role} className="card-padded-sm st-agent-row">
                <div className="st-agent-row-meta">
                  <span className="font-semi">{r.role}</span>
                  {ROLE_DESCRIPTIONS[r.role] && (
                    <span className="text-muted"> — {ROLE_DESCRIPTIONS[r.role]}</span>
                  )}
                  <span className="st-agent-row-provider">
                    {linkedProvider
                      ? <><span>{providerEmoji(linkedProvider)}</span> {linkedProvider.name}
                          {linkedProvider.costTier && (
                            <span className="st-ai-cost-tier"> · {linkedProvider.costTier}</span>
                          )}
                        </>
                      : r.routeId
                      ? <><AlertCircle size={11} /> Provider missing</>
                      : <span className="text-muted">workspace default</span>
                    }
                  </span>
                  <span className="text-muted text-xs">temp {r.temperature}</span>
                </div>

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
                    title="Send a 1-token probe to validate this (provider, role) pair."
                  >
                    {probe?.status === "running"
                      ? <RefreshCw size={11} className="spin" />
                      : <Activity size={11} />}
                    {probe?.status === "running" ? "Testing…" : "Test"}
                  </button>
                  <button className="btn btn-ghost btn-xs" onClick={() => edit(r)}>Edit</button>
                  <button className="btn btn-danger btn-xs" onClick={() => del(r.role)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

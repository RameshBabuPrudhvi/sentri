import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, Check, Info, RefreshCw,
} from "lucide-react";
import { api } from "../../../../api.js";
import { AGENT_ROLES } from "../../../../config.js";

/**
 * Agent Roles section (AI-005). Per-role dispatch config: which provider route
 * to pin, optional system-prompt override, temperature, max tokens. `fallbackRole`
 * is deprecated (B3.2) — canonical fallback lives on the provider_route now.
 * Extracted from Settings.jsx (GAP-002).
 */
const EMPTY_FORM = {
  role: AGENT_ROLES[0],
  routeId: "",
  systemPromptOverride: "",
  temperature: 0.2,
  maxTokens: "",
  fallbackRole: "",
};

export default function AgentRolesSection() {
  const [rows, setRows] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingRole, setEditingRole] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [probes, setProbes] = useState({});

  const load = useCallback(async () => {
    try {
      const [r, routesRes] = await Promise.all([
        api.getAgentRoles(),
        api.listProviderRoutes().catch(() => ({ routes: [] })),
      ]);
      setRows(r.roles || []);
      setRoutes(routesRes?.routes || []);
    } catch (err) {
      setError(err.message || "Failed to load agent roles.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const routeById = useMemo(() => {
    const m = new Map();
    for (const r of routes) m.set(r.id, r);
    return m;
  }, [routes]);

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
        fallbackRole: null,
      };
      if (editingRole) await api.updateAgentRole(editingRole, payload);
      else await api.createAgentRole(payload);
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
      role: row.role,
      routeId: row.routeId || "",
      systemPromptOverride: row.systemPromptOverride || "",
      temperature: row.temperature ?? 0.2,
      maxTokens: row.maxTokens ?? "",
      fallbackRole: row.fallbackRole || "",
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

  return (
    <div className="card card-padded">
      <h3>Agent Roles</h3>
      {error && (
        <div className="st-status-err st-agent-error">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      <form onSubmit={save} className="st-agent-form">
        <select
          className="input"
          value={form.role}
          onChange={(e) => setForm((s) => ({ ...s, role: e.target.value }))}
          disabled={!!editingRole}
        >
          {AGENT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select
          className="input"
          value={form.routeId}
          onChange={(e) => setForm((s) => ({ ...s, routeId: e.target.value }))}
          title="The provider route this role dispatches against. Leave empty to use the workspace default."
        >
          <option value="">Workspace default (no per-role override)</option>
          {routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {r.family} · {r.model || "model?"}{!r.enabled ? " (disabled)" : ""}
            </option>
          ))}
        </select>
        {routes.length === 0 && (
          <div className="hint st-agent-fallback-deprecation">
            <Info size={11} />
            <span>No provider routes configured yet — create one in the <strong>Provider Routes</strong> section.</span>
          </div>
        )}
        <textarea
          className="input"
          placeholder="system prompt override"
          value={form.systemPromptOverride}
          onChange={(e) => setForm((s) => ({ ...s, systemPromptOverride: e.target.value }))}
        />
        <input
          className="input"
          type="number"
          step="0.1"
          value={form.temperature}
          onChange={(e) => setForm((s) => ({ ...s, temperature: Number(e.target.value) }))}
        />
        <input
          className="input"
          type="number"
          placeholder="max tokens"
          value={form.maxTokens}
          onChange={(e) => setForm((s) => ({ ...s, maxTokens: e.target.value }))}
        />
        <div className="st-agent-fallback-deprecation">
          <Info size={11} />
          <span>
            Per-role fallback is now configured on the provider route's
            {" "}<strong>Fallback route</strong> field (Provider Routes section).
          </span>
        </div>
        <div className="st-agent-form-actions">
          <button className="btn btn-primary btn-sm" disabled={busy}>
            {editingRole ? "Update role config" : "Save role config"}
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
      <div className="st-agent-rows">
        {rows.map((r) => {
          const probe = probes[r.role];
          const linkedRoute = r.routeId ? routeById.get(r.routeId) : null;
          const routeLabel = linkedRoute
            ? `${linkedRoute.name} · ${linkedRoute.family} · ${linkedRoute.model || "model?"}`
            : r.routeId
            ? `${r.routeId} (route missing)`
            : "workspace-default";
          return (
            <div key={r.role} className="card-padded-sm st-agent-row">
              <span className="st-agent-row-meta">{r.role} · {routeLabel} · temp {r.temperature}</span>
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
        })}
      </div>
    </div>
  );
}

/**
 * @module components/project/EnvironmentsTab
 * @description Environment management tab for ProjectDetail (DIF-012).
 *
 * Per-project environments (`staging`, `production`, etc.) each carry a
 * `baseUrl` override and optional encrypted credentials. Selecting an
 * environment on `RunRegressionModal.jsx` overrides `project.url` for
 * that run only — the project row itself is never mutated.
 *
 * Mutations are gated server-side on `admin` (see
 * `backend/src/middleware/permissions.json`); read is `qa_lead`+. We
 * still render the panel for `qa_lead` viewers but disable the mutation
 * buttons via the `canEdit` prop so they don't get a 403 toast.
 */
import React, { useEffect, useState, useCallback } from "react";
import { Plus, Trash2, Save, RefreshCw, Globe, Lock } from "lucide-react";
import { api } from "../../api.js";

const EMPTY_FORM = { name: "", baseUrl: "", username: "", password: "" };

export default function EnvironmentsTab({ projectId, canEdit, onToast }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getProjectEnvironments(projectId);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || "Failed to load environments");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  function startEdit(row) {
    setEditingId(row.id);
    setForm({
      name: row.name || "",
      baseUrl: row.baseUrl || "",
      username: row.credentials?.username || "",
      password: row.credentials?.password || "",
    });
  }

  async function handleSave() {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      onToast?.("Name and base URL are required", "error");
      return;
    }
    setBusy(true);
    try {
      // Only forward credentials when at least one field is non-empty so an
      // edit that touches name/baseUrl alone doesn't wipe the stored secret.
      const credentials = (form.username || form.password)
        ? { username: form.username, password: form.password }
        : undefined;
      const payload = { name: form.name.trim(), baseUrl: form.baseUrl.trim() };
      if (credentials !== undefined) payload.credentials = credentials;
      if (editingId) {
        await api.updateProjectEnvironment(projectId, editingId, payload);
        onToast?.("Environment updated", "success");
      } else {
        await api.createProjectEnvironment(projectId, payload);
        onToast?.("Environment created", "success");
      }
      resetForm();
      await load();
    } catch (err) {
      onToast?.(err.message || "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(row) {
    if (!window.confirm(`Delete environment "${row.name}"? Existing runs that targeted it will keep their environmentId but the override is gone.`)) return;
    setBusy(true);
    try {
      await api.deleteProjectEnvironment(projectId, row.id);
      if (editingId === row.id) resetForm();
      await load();
      onToast?.("Environment deleted", "info");
    } catch (err) {
      onToast?.(err.message || "Delete failed", "error");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
        <RefreshCw size={20} className="spin" style={{ opacity: 0.3, marginBottom: 12 }} />
        <div>Loading environments…</div>
      </div>
    );
  }

  return (
    <div>
      {error && <div className="alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ padding: "16px 20px 0", display: "flex", alignItems: "center", gap: 8 }}>
          <Globe size={15} color="var(--accent)" />
          <h3 style={{ fontWeight: 700, fontSize: "0.95rem", margin: 0 }}>
            Environments ({rows.length})
          </h3>
          <span style={{ fontSize: "0.73rem", color: "var(--text3)", marginLeft: 8 }}>
            Per-run base URL override — selecting one in the Run modal never mutates the project URL.
          </span>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: "20px", fontSize: "0.82rem", color: "var(--text3)" }}>
            No environments defined. Runs will target the project's default URL.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Base URL</th>
                <th>Credentials</th>
                <th style={{ width: 160 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={{ fontWeight: 600, fontSize: "0.82rem" }}>{row.name}</td>
                  <td style={{ fontSize: "0.78rem", color: "var(--text2)" }}>{row.baseUrl}</td>
                  <td>
                    {row.credentials?.username ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.73rem", color: "var(--text2)" }}>
                        <Lock size={11} /> {row.credentials.username}
                      </span>
                    ) : (
                      <span style={{ fontSize: "0.73rem", color: "var(--text3)" }}>—</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => startEdit(row)}
                        disabled={!canEdit || busy}
                      >Edit</button>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => handleDelete(row)}
                        disabled={!canEdit || busy}
                        title="Delete environment"
                      ><Trash2 size={11} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canEdit && (
        <div className="card" style={{ padding: "18px 20px" }}>
          <h3 style={{ fontWeight: 700, fontSize: "0.95rem", margin: "0 0 12px" }}>
            {editingId ? "Edit environment" : "Add environment"}
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: "0.78rem", color: "var(--text2)" }}>Name</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="staging"
                style={{ height: 38 }}
              />
            </div>
            <div>
              <label style={{ fontSize: "0.78rem", color: "var(--text2)" }}>Base URL</label>
              <input
                className="input"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://staging.example.com"
                style={{ height: 38 }}
              />
            </div>
            <div>
              <label style={{ fontSize: "0.78rem", color: "var(--text2)" }}>Username (optional)</label>
              <input
                className="input"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                style={{ height: 38 }}
                autoComplete="off"
              />
            </div>
            <div>
              <label style={{ fontSize: "0.78rem", color: "var(--text2)" }}>Password (optional)</label>
              <input
                type="password"
                className="input"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                style={{ height: 38 }}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {editingId && (
              <button className="btn btn-ghost btn-sm" onClick={resetForm} disabled={busy}>Cancel</button>
            )}
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={busy || !form.name.trim() || !form.baseUrl.trim()}
            >
              {busy ? <RefreshCw size={12} className="spin" /> : editingId ? <Save size={12} /> : <Plus size={12} />}
              {editingId ? "Save changes" : "Add environment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

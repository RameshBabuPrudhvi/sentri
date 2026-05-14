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
    // Server response only carries `{ username, _hasAuth: true }` (the
    // password is stripped via `sanitiseEnvCredentialsForClient` —
    // REVIEW.md forbids returning plaintext passwords). Username pre-fills
    // for "which account is this env using" continuity; password stays
    // blank by design. The PATCH route merges blank password with the
    // stored value, so leaving it empty preserves the existing secret —
    // the user only needs to type a new password when actually rotating.
    //
    // `_hadAuthAtEdit` snapshots whether the row had credentials at edit
    // start so `handleSave` can distinguish "user cleared both fields to
    // wipe stored credentials" (→ send `credentials: null`) from "user
    // opened a credential-less row and didn't add any" (→ omit the
    // `credentials` key entirely). Without this, clearing both fields
    // was indistinguishable from "leave the form alone" and silently
    // preserved the stored secret — see QA.md § Environments step 5.
    setEditingId(row.id);
    setForm({
      name: row.name || "",
      baseUrl: row.baseUrl || "",
      username: row.credentials?.username || "",
      password: "",
      _hadAuthAtEdit: !!row.credentials?._hasAuth,
    });
  }

  async function handleSave() {
    if (!form.name.trim() || !form.baseUrl.trim()) {
      onToast?.("Name and base URL are required", "error");
      return;
    }
    setBusy(true);
    try {
      // Three-way credentials decision (matches the PATCH route's three-case
      // contract in `backend/src/routes/projects.js`):
      //   1. At least one field non-empty → send object. Server's
      //      blank-password merge fills missing fields from the stored
      //      value, so changing only the username keeps the password.
      //   2. Both fields blank AND the row had credentials at edit start
      //      → explicit `credentials: null` to wipe the stored secret.
      //      This is the "Edit → clear both → save" flow QA.md § step 5
      //      requires; without it, blank fields were indistinguishable
      //      from "didn't touch credentials" and the secret silently
      //      persisted.
      //   3. Both fields blank AND no credentials existed → omit the key.
      //      Avoids a no-op PATCH that would re-encrypt nothing.
      const hasInput = !!(form.username || form.password);
      const wantsClear = !hasInput && editingId && form._hadAuthAtEdit;
      const payload = { name: form.name.trim(), baseUrl: form.baseUrl.trim() };
      if (hasInput) {
        payload.credentials = { username: form.username, password: form.password };
      } else if (wantsClear) {
        payload.credentials = null;
      }
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
      <div className="card pd-empty">
        <RefreshCw size={20} className="spin pd-env-loading-icon" />
        <div>Loading environments…</div>
      </div>
    );
  }

  return (
    <div>
      {error && <div className="alert-error mb-md">{error}</div>}

      <div className="card mb-md">
        <div className="pd-env-header">
          <Globe size={15} color="var(--accent)" />
          <h3 className="pd-env-heading">Environments ({rows.length})</h3>
          <span className="pd-env-hint">
            Per-run base URL override — selecting one in the Run modal never mutates the project URL.
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="pd-env-empty">
            No environments defined. Runs will target the project's default URL.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Base URL</th>
                <th>Credentials</th>
                <th className="pd-env-actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="pd-env-row-name">{row.name}</td>
                  <td className="pd-env-row-url">{row.baseUrl}</td>
                  <td>
                    {row.credentials?.username ? (
                      <span className="pd-env-row-cred">
                        <Lock size={11} /> {row.credentials.username}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </td>
                  <td>
                    <div className="pd-env-row-actions">
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
        <div className="card pd-env-form">
          <h3 className="pd-env-form-title">
            {editingId ? "Edit environment" : "Add environment"}
          </h3>
          <div className="pd-env-form-grid">
            <div>
              <label className="pd-env-form-label">Name</label>
              <input
                className="input pd-env-form-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="staging"
              />
            </div>
            <div>
              <label className="pd-env-form-label">Base URL</label>
              <input
                className="input pd-env-form-input"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://staging.example.com"
              />
            </div>
            <div>
              <label className="pd-env-form-label">Username (optional)</label>
              <input
                className="input pd-env-form-input"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="pd-env-form-label">Password (optional)</label>
              <input
                type="password"
                className="input pd-env-form-input"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="pd-env-form-actions">
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

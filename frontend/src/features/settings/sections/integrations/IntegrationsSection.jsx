import React, { useCallback, useEffect, useState } from "react";
import {
  AlertCircle, Check, ExternalLink, RefreshCw,
} from "lucide-react";
import { api } from "../../../../api.js";
import { useAuth } from "../../../../context/AuthContext.jsx";
import SectionTitle from "../../shared/SectionTitle.jsx";
import { useToast } from "../../../../context/ToastContext.jsx";

/**
 * Integrations section — GitHub PR checks (INT-002 / INT-002b).
 *
 * Per-project rows toggle native GitHub Check Runs on Sentri runs. The
 * "Install App" button kicks off the GitHub App OAuth flow; the callback
 * (`/install/callback`) bounces back to `/settings/integrations?github=installed`
 * which this section detects via `useEffect` and surfaces as a success banner.
 *
 * Read is gated to `qa_lead`; mutations require `admin`. Below-qa_lead users see
 * a 403 swallowed by AccountSection's role check before this section renders.
 * Extracted from Settings.jsx (GAP-002).
 */
export default function IntegrationsSection() {
  const { user } = useAuth();
  const isAdmin = user?.workspaceRole === "admin";

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(null);
  const [installing, setInstalling] = useState(null);
  const [status, setStatus] = useState(null);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getGithubCheckSettings();
      setRows(data.projects || []);
    } catch (err) {
      setError(err.message || "Failed to load GitHub settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // GitHub App install callback redirects to `/settings/integrations?github=installed`.
  // Surface the success banner, reload the rows (the install upserted a config
  // row server-side), and strip the query param so refresh doesn't re-fire.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("github") === "installed") {
      setStatus({ type: "ok", text: "GitHub App installed. Settings were refreshed with the selected repository." });
      showToast("GitHub App installed", "success");
      load();
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [load]);

  function updateRow(projectId, patch) {
    setRows((prev) => prev.map((row) => row.projectId === projectId ? { ...row, ...patch } : row));
  }

  async function installGithubApp(projectId) {
    setInstalling(projectId);
    setError("");
    setStatus(null);
    try {
      const data = await api.getGithubInstallStartUrl(projectId);
      window.location.assign(data.url);
    } catch (err) {
      setError(err.message || "Failed to start GitHub App install.");
      showToast(err.message || "Failed to start GitHub App install.", "error");
      setInstalling(null);
    }
  }

  async function saveRow(row) {
    setSaving(row.projectId);
    setError("");
    try {
      await api.updateGithubCheckSettings(row.projectId, {
        enabled: !!row.enabled,
        repo: row.repo || "",
        installationId: row.installationId || "",
      });
      await load();
      showToast("GitHub check settings saved", "success");
    } catch (err) {
      setError(err.message || "Failed to save GitHub settings.");
      showToast(err.message || "Failed to save GitHub settings.", "error");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex-col gap-lg">
      <SectionTitle icon={<ExternalLink size={16} color="var(--accent)" />} title="Integrations" sub="Connect Sentri to developer workflows" />
      <div className="card card-padded">
        <div className="font-bold integrations-intro__title">GitHub PR checks</div>
        <div className="text-sm text-muted integrations-intro__body">
          Install the Sentri GitHub App, then enable native Check Runs per project. Existing projects stay disabled until toggled on.
        </div>
        <div className="text-xs text-muted">
          Use the per-project install button below to authorize the GitHub App and auto-fill the selected repository.
        </div>
      </div>

      {status && <div className={status.type === "ok" ? "st-status-ok" : "st-status-err"}>{status.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {status.text}</div>}
      {error && <div className="st-status-err"><AlertCircle size={12} /> {error}</div>}
      {loading ? <div className="text-sm text-muted">Loading GitHub integration settings…</div> : rows.map((row) => (
        <div key={row.projectId} className="card card-padded integrations-row">
          <div>
            <div className="font-bold">{row.projectName}</div>
            <label className="text-xs text-muted integrations-row__toggle">
              <input
                type="checkbox"
                checked={!!row.enabled}
                disabled={!isAdmin}
                onChange={(e) => updateRow(row.projectId, { enabled: e.target.checked })}
              />
              Post PR checks
            </label>
          </div>
          <div>
            <label className="text-xs text-muted">Repository</label>
            <input className="input" value={row.repo || ""} disabled={!isAdmin} placeholder="owner/repo" onChange={(e) => updateRow(row.projectId, { repo: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-muted">Installation ID</label>
            <input className="input" value={row.installationId || ""} disabled={!isAdmin} placeholder="123456" onChange={(e) => updateRow(row.projectId, { installationId: e.target.value })} />
          </div>
          <button className="btn btn-ghost btn-sm" disabled={!isAdmin || installing === row.projectId} onClick={() => installGithubApp(row.projectId)}>
            {installing === row.projectId ? <RefreshCw size={13} className="spin" /> : <ExternalLink size={13} />} Install App
          </button>
          <button className="btn btn-primary btn-sm" disabled={!isAdmin || saving === row.projectId} onClick={() => saveRow(row)}>
            {saving === row.projectId ? <RefreshCw size={13} className="spin" /> : <Check size={13} />} Save
          </button>
        </div>
      ))}
      {!isAdmin && <div className="hint">QA leads can view integration status. Admin access is required to change GitHub App settings.</div>}
    </div>
  );
}

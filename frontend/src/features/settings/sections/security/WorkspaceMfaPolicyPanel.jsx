import React, { useCallback, useEffect, useState } from "react";
import {
  AlertCircle, Check, Crown, RefreshCw,
} from "lucide-react";
import { api } from "../../../../api.js";

/**
 * Admin-only workspace MFA enforcement panel (SEC-004). Toggles `mfaRequired`
 * + the grace period, with a live compliance preview so the admin knows how
 * many members would be impacted at grace=0. Extracted from Settings.jsx
 * (GAP-002).
 */
export default function WorkspaceMfaPolicyPanel() {
  const [ws, setWs] = useState(null);
  const [compliance, setCompliance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftGrace, setDraftGrace] = useState(7);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [wsRes, compRes] = await Promise.all([
        api.getWorkspace(),
        api.getWorkspaceMfaCompliance(),
      ]);
      setWs(wsRes);
      setCompliance(compRes);
      setDraftEnabled(wsRes.mfaRequired === 1);
      setDraftGrace(wsRes.mfaGracePeriodDays ?? 7);
    } catch (err) {
      setStatus({ type: "err", text: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty = ws && (
    (draftEnabled ? 1 : 0) !== (ws.mfaRequired || 0) ||
    Number(draftGrace) !== Number(ws.mfaGracePeriodDays ?? 7)
  );

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await api.updateWorkspace({
        mfaRequired: draftEnabled ? 1 : 0,
        mfaGracePeriodDays: Number(draftGrace),
      });
      setStatus({ type: "ok", text: "Workspace MFA policy updated." });
      await load();
    } catch (err) {
      setStatus({ type: "err", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return (
    <div className="text-sm text-muted ws-enforce__loading">Loading workspace policy…</div>
  );

  return (
    <div className="card card-padded flex-col gap-md">
      <div className="font-bold ws-enforce__title">
        <Crown size={14} color="var(--amber)" /> Workspace enforcement
      </div>
      <div className="text-sm text-muted">
        Require all members of this workspace to enable MFA before signing in.
        New members get the grace window before they are blocked.
      </div>

      {compliance && (
        <div className="card-padded-sm ws-enforce__compliance">
          <div className="text-xs text-muted font-semi ws-enforce__compliance-title">
            Current enrollment
          </div>
          <div className="text-sm">
            <strong>{compliance.enrolled}</strong> of {compliance.totalMembers} members have MFA enabled.
            {compliance.notEnrolled > 0 && (
              <span className="text-muted ws-enforce__compliance-note">
                {compliance.notEnrolled} would be impacted at grace = 0.
              </span>
            )}
          </div>
        </div>
      )}

      <label className="text-sm ws-enforce__require-label">
        <input
          type="checkbox"
          checked={draftEnabled}
          onChange={(e) => setDraftEnabled(e.target.checked)}
        />
        Require MFA for all workspace members
      </label>

      <label className="text-sm font-semi mfa-label">
        Grace period (days)
        <input
          className="input ws-enforce__grace-input"
          type="number"
          min={0}
          max={90}
          value={draftGrace}
          onChange={(e) => setDraftGrace(e.target.value)}
          disabled={!draftEnabled}
        />
        <div className="hint ws-enforce__grace-hint">
          Members have this many days from when the policy is enabled (or from
          when they join) to enroll before they are blocked at login.
        </div>
      </label>

      {status && (
        <div className={status.type === "ok" ? "st-status-ok" : "st-status-err"}>
          {status.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {status.text}
        </div>
      )}

      <div>
        <button className="btn btn-primary btn-sm" disabled={!dirty || saving} onClick={handleSave}>
          {saving ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
          Save policy
        </button>
      </div>
    </div>
  );
}

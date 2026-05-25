import React, { useEffect, useState } from "react";
import {
  AlertCircle, Check, Compass, ExternalLink, Info, RefreshCw, Shield, Trash2,
} from "lucide-react";
import { api } from "../../../../api.js";
import { useAuth } from "../../../../context/AuthContext.jsx";
import { resetOnboarding } from "../../../../hooks/useOnboarding.js";
import SectionTitle from "../../shared/SectionTitle.jsx";

/**
 * Account & Privacy section — data export + account deletion under GDPR / CCPA
 * (SEC-003). OAuth-only users (no password) skip the password-confirm field;
 * the backend's `verifyAccountPassword` treats the OAuth session itself as proof
 * of identity. Two-stage delete (Confirm → Confirm again) prevents single-click
 * destructive actions. Extracted from Settings.jsx (GAP-002).
 */
export default function AccountSection() {
  const { logout, user } = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const needsPassword = user?.hasPassword !== false;

  // Auto-disarm delete confirmation after 5s.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  async function handleExport() {
    if (needsPassword && !password.trim()) {
      setStatus({ type: "err", text: "Enter your password to export account data." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const data = await api.exportAccountData(needsPassword ? password.trim() : "");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sentri-account-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
      setStatus({ type: "ok", text: "Account export downloaded." });
    } catch (err) {
      setStatus({ type: "err", text: err.message || "Export failed." });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (needsPassword && !password.trim()) {
      setStatus({ type: "err", text: "Enter your password to delete your account." });
      return;
    }
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.deleteAccount(needsPassword ? password.trim() : "");
      await logout();
    } catch (err) {
      setStatus({ type: "err", text: err.message || "Account deletion failed." });
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="flex-col gap-lg">
      {/* UX-AUDIT (May 2026) — onboarding-tour restart card. Moved here
          from `SettingsLayout.jsx` (which previously rendered it on every
          settings sub-page = 9 places of visual noise after first-time
          onboarding). Lives in Account because restart-tour is a personal
          preference, not a workspace setting — same place GitHub /
          Vercel / Linear put their "restart onboarding" entries. */}
      <div className="st-tour-card">
        <div className="st-section-icon icon-box-accent shrink-0">
          <Compass size={16} color="var(--accent)" />
        </div>
        <div className="flex-1">
          <div className="font-bold">Getting Started Tour</div>
          <div className="text-xs text-muted">
            Re-run the onboarding walkthrough that guides you through setup.
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            resetOnboarding();
            // Navigate away first (avoids beforeunload prompt from unsaved
            // API key inputs in providers section), then reload so
            // useOnboarding picks up the force flag on fresh mount.
            window.location.href = import.meta.env.BASE_URL + "dashboard";
          }}
        >
          <RefreshCw size={13} /> Restart Tour
        </button>
      </div>

      <SectionTitle icon={<Shield size={16} color="var(--red)" />} title="Account & Privacy" sub="Export your data or permanently delete your account." />
      <div className="card card-padded flex-col gap-md">
        {needsPassword ? (
          <label className="text-sm font-semi">
            Confirm password
            <input
              className="input account-confirm__input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your current password"
            />
          </label>
        ) : (
          <div className="text-sm text-muted account-oauth-hint">
            <Info size={13} /> You signed in via OAuth — no password confirmation needed.
          </div>
        )}
        <div className="account-actions">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={handleExport}>
            {busy ? <RefreshCw size={13} className="spin" /> : <ExternalLink size={13} />} Export account data
          </button>
          <button className={`btn btn-sm ${confirmDelete ? "btn-danger" : "btn-ghost"}`} disabled={busy} onClick={handleDelete}>
            {busy ? <RefreshCw size={13} className="spin" /> : <Trash2 size={13} />}
            {confirmDelete ? "Confirm delete account" : "Delete account"}
          </button>
        </div>
        {status && (
          <div className={status.type === "ok" ? "st-status-ok" : "st-status-err"}>
            {status.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {status.text}
          </div>
        )}
      </div>
    </div>
  );
}

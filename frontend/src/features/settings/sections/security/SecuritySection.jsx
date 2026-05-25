import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle, KeyRound, RefreshCw, Shield, Smartphone, Trash2, UserPlus,
} from "lucide-react";
import { api } from "../../../../api.js";
import { useAuth } from "../../../../context/AuthContext.jsx";
import SectionTitle from "../../shared/SectionTitle.jsx";
import PasswordConfirmModal from "../../shared/PasswordConfirmModal.jsx";
import { fmtDeletedDate } from "../../shared/formatters.js";
import RecoveryCodesPanel from "./RecoveryCodesPanel.jsx";
import TotpEnrollmentPanel from "./TotpEnrollmentPanel.jsx";
import WorkspaceMfaPolicyPanel from "./WorkspaceMfaPolicyPanel.jsx";

/**
 * Security section (SEC-004). TOTP + recovery codes + passkeys + workspace
 * MFA enforcement (admins only). Loads factor state on mount and refetches
 * after every mutation. Destructive actions revoke the current session
 * server-side; this component chains the logout + redirect on
 * `response.sessionRevoked`. Extracted from Settings.jsx (GAP-002).
 */
export default function SecuritySection() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.workspaceRole === "admin";
  // OAuth-only users have no password — destructive actions skip the modal
  // (the OAuth session itself proves identity).
  const needsPassword = user?.hasPassword !== false;

  const [factors, setFactors] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [enrollment, setEnrollment] = useState(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollErr, setEnrollErr] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [sessionRevokedPending, setSessionRevokedPending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.mfaFactors();
      setFactors(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleStartEnroll() {
    setEnrollBusy(true);
    setEnrollErr(null);
    try {
      const data = await api.mfaEnroll();
      setEnrollment(data);
    } catch (err) {
      setEnrollErr(err.message);
    } finally {
      setEnrollBusy(false);
    }
  }

  async function handleVerifyEnroll(token) {
    setEnrollBusy(true);
    setEnrollErr(null);
    try {
      const data = await api.mfaEnable(token);
      setRecoveryCodes(data.recoveryCodes);
      setEnrollment(null);
      try { sessionStorage.removeItem("mfa_grace_banner"); } catch { /* unavailable */ }
      await load();
    } catch (err) {
      setEnrollErr(err.message);
    } finally {
      setEnrollBusy(false);
    }
  }

  const runAction = useCallback(async (action, password) => {
    setActionBusy(true);
    setActionErr(null);
    try {
      let response;
      if (action.kind === "disable") {
        response = await api.mfaDisable(needsPassword ? password : "");
      } else if (action.kind === "regenerate") {
        response = await api.mfaRegenerateRecoveryCodes(needsPassword ? password : "");
        setRecoveryCodes(response.recoveryCodes);
      } else if (action.kind === "removePasskey") {
        response = await api.webauthnDeleteCredential(action.credentialId, needsPassword ? password : "");
      }
      setPendingAction(null);

      if (response?.sessionRevoked) {
        if (action.kind === "regenerate") {
          setSessionRevokedPending(true);
        } else {
          await logout();
          navigate("/login", {
            state: { notice: "Your session was ended for security. Please sign in again." },
          });
        }
        return;
      }
      await load();
    } catch (err) {
      setActionErr(err.message);
    } finally {
      setActionBusy(false);
    }
  }, [needsPassword, load, logout, navigate]);

  // OAuth-only path: no password modal — run the action immediately.
  useEffect(() => {
    if (!pendingAction || needsPassword) return;
    runAction(pendingAction, "");
  }, [pendingAction, needsPassword, runAction]);

  async function handleAddPasskey() {
    setError(null);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options, challengeToken } = await api.webauthnRegisterOptions();
      let attestation;
      try {
        attestation = await startRegistration({ optionsJSON: options });
      } catch (e) {
        if (e?.name === "TypeError") attestation = await startRegistration(options);
        else throw e;
      }
      const deviceName = window.prompt("Name this passkey (e.g. \"YubiKey\", \"iPhone\"):", "")?.slice(0, 80) || null;
      await api.webauthnRegisterVerify(challengeToken, attestation, deviceName);
      try { sessionStorage.removeItem("mfa_grace_banner"); } catch { /* unavailable */ }
      await load();
    } catch (err) {
      const msg = err?.name === "NotAllowedError"
        ? "Passkey enrollment was cancelled or denied by the browser."
        : err.message;
      setError(msg);
    }
  }

  if (loading) return (
    <div className="text-sm text-muted members-loading">Loading security settings…</div>
  );

  const totpEnabled = factors?.totp === true;
  const passkeys = factors?.webauthn || [];

  return (
    <div className="flex-col gap-lg">
      <SectionTitle
        icon={<Shield size={16} color="var(--accent)" />}
        title="Security"
        sub="Multi-factor authentication, passkeys, and workspace policy"
      />

      {error && (
        <div className="card card-padded members-error">
          <AlertCircle size={15} /> {error}
        </div>
      )}

      {recoveryCodes && (
        <RecoveryCodesPanel
          codes={recoveryCodes}
          userEmail={user?.email || "account"}
          onDismiss={async () => {
            setRecoveryCodes(null);
            if (sessionRevokedPending) {
              setSessionRevokedPending(false);
              await logout();
              navigate("/login", {
                state: { notice: "Your session was ended for security. Please sign in again." },
              });
            }
          }}
        />
      )}

      {enrollment ? (
        <TotpEnrollmentPanel
          enrollment={enrollment}
          onEnable={handleVerifyEnroll}
          onCancel={() => { setEnrollment(null); setEnrollErr(null); }}
          busy={enrollBusy}
          error={enrollErr}
        />
      ) : (
        <div className="card card-padded flex-col gap-md">
          <div className="factor-row">
            <Smartphone size={18} color={totpEnabled ? "var(--green)" : "var(--text3)"} />
            <div className="factor-row__info">
              <div className="font-bold">Authenticator app (TOTP)</div>
              <div className="text-xs text-muted factor-row__sub">
                {totpEnabled
                  ? `Enabled · ${factors.recoveryCodesRemaining} recovery code${factors.recoveryCodesRemaining === 1 ? "" : "s"} remaining`
                  : "Not enrolled"}
              </div>
            </div>
            {totpEnabled ? (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setPendingAction({ kind: "regenerate" })}>
                  <RefreshCw size={13} /> Regenerate codes
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => setPendingAction({ kind: "disable" })}>
                  <Trash2 size={13} /> Disable
                </button>
              </>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={handleStartEnroll} disabled={enrollBusy}>
                {enrollBusy ? <RefreshCw size={13} className="spin" /> : <KeyRound size={13} />}
                Enable TOTP
              </button>
            )}
          </div>
          {enrollErr && (
            <div className="st-status-err">
              <AlertCircle size={12} /> {enrollErr}
            </div>
          )}
        </div>
      )}

      <div className="card card-padded flex-col gap-md">
        <div className="factor-row">
          <KeyRound size={18} color={passkeys.length > 0 ? "var(--green)" : "var(--text3)"} />
          <div className="factor-row__info">
            <div className="font-bold">Passkeys</div>
            <div className="text-xs text-muted factor-row__sub">
              {passkeys.length === 0
                ? "No passkeys registered"
                : `${passkeys.length} passkey${passkeys.length === 1 ? "" : "s"} registered`}
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={handleAddPasskey}>
            <UserPlus size={13} /> Add passkey
          </button>
        </div>
        {passkeys.length > 0 && (
          <div className="flex-col gap-xs">
            {passkeys.map((cred) => (
              <div key={cred.id} className="passkey-item">
                <div className="passkey-item__info">
                  <div className="text-sm font-semi passkey-item__name">
                    {cred.deviceName || "Unnamed passkey"}
                  </div>
                  <div className="text-xs text-muted passkey-item__meta">
                    Added {fmtDeletedDate(cred.createdAt)}
                    {cred.lastUsedAt && ` · last used ${fmtDeletedDate(cred.lastUsedAt)}`}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-xs members-row__remove-btn"
                  onClick={() => setPendingAction({ kind: "removePasskey", credentialId: cred.id })}
                  title={`Remove ${cred.deviceName || "passkey"}`}
                >
                  <Trash2 size={11} /> Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {isAdmin && <WorkspaceMfaPolicyPanel />}

      {pendingAction && needsPassword && (
        <PasswordConfirmModal
          title={
            pendingAction.kind === "disable" ? "Disable MFA?"
            : pendingAction.kind === "regenerate" ? "Regenerate recovery codes?"
            : "Remove passkey?"
          }
          description={
            pendingAction.kind === "disable" ? "This clears your TOTP secret and all recovery codes. You can re-enroll afterwards."
            : pendingAction.kind === "regenerate" ? "Your existing recovery codes will stop working immediately. A fresh set will be shown once."
            : "This passkey will no longer be accepted at sign-in."
          }
          busy={actionBusy}
          error={actionErr}
          onConfirm={(pwd) => runAction(pendingAction, pwd)}
          onCancel={() => { setPendingAction(null); setActionErr(null); }}
        />
      )}
    </div>
  );
}

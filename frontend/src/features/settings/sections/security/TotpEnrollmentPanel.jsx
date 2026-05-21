import React, { useState } from "react";
import { AlertCircle, Check, RefreshCw } from "lucide-react";

/**
 * TOTP enrollment panel — shows the QR code + secret + 6-digit code input
 * (SEC-004). Operator scans into Google Authenticator / 1Password / Authy /
 * any TOTP-compatible app, then confirms by entering the current 6-digit code
 * which the backend verifies before enabling MFA. Extracted from Settings.jsx
 * (GAP-002).
 */
export default function TotpEnrollmentPanel({ enrollment, onEnable, onCancel, busy, error }) {
  const [token, setToken] = useState("");
  const qrUrl = enrollment?.otpauth
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(enrollment.otpauth)}`
    : null;

  return (
    <form
      className="card card-padded flex-col gap-md totp-enroll"
      onSubmit={(e) => { e.preventDefault(); onEnable(token); }}
    >
      <div className="font-bold">Scan with your authenticator app</div>
      <div className="text-sm text-muted">
        Use Google Authenticator, 1Password, Authy, or any TOTP-compatible app.
      </div>
      {qrUrl && (
        <div className="totp-enroll__qr-wrap">
          <img
            src={qrUrl}
            width="200"
            height="200"
            alt="MFA QR code — scan with your authenticator app"
            className="totp-enroll__qr"
          />
        </div>
      )}
      <div>
        <div className="text-xs text-muted totp-enroll__secret-label">
          Or enter this secret manually:
        </div>
        <div className="text-mono text-sm totp-enroll__secret">
          {enrollment?.secret}
        </div>
      </div>
      <label className="text-sm font-semi">
        6-digit code from your app
        <input
          className="input totp-enroll__code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={token}
          onChange={(e) => setToken(e.target.value.replace(/[^\d]/g, ""))}
          placeholder="123456"
          required
        />
      </label>
      {error && (
        <div className="st-status-err">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      <div className="totp-enroll__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || token.length < 6}>
          {busy ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
          Verify &amp; enable
        </button>
      </div>
    </form>
  );
}

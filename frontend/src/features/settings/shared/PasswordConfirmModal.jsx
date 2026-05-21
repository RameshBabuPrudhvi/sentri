import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, RefreshCw } from "lucide-react";

/**
 * Reusable password-confirm modal (SEC-004). Used by destructive Security
 * actions (disable MFA, regenerate recovery codes, remove passkey) — every
 * call site backs onto a backend route that reverifies the password before
 * acting. Esc cancels, click-outside cancels, autofocus on the input.
 * Extracted from Settings.jsx (GAP-002).
 */
export default function PasswordConfirmModal({ title, description, busy, error, onConfirm, onCancel }) {
  const [password, setPassword] = useState("");
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onCancel(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwd-modal-title"
      className="pwd-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        className="card card-padded pwd-modal"
        onSubmit={(e) => { e.preventDefault(); onConfirm(password); }}
      >
        <h3 id="pwd-modal-title" className="pwd-modal__title">{title}</h3>
        {description && <p className="text-sm text-muted pwd-modal__desc">{description}</p>}
        <label className="text-sm font-semi pwd-modal__label">
          Password
          <input
            ref={inputRef}
            className="input pwd-modal__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && (
          <div className="st-status-err pwd-modal__error">
            <AlertCircle size={12} /> {error}
          </div>
        )}
        <div className="pwd-modal__actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !password.trim()}>
            {busy ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
}

import React, { useState } from "react";
import { AlertCircle, Check, RefreshCw } from "lucide-react";
import ModalShell from "../../../components/shared/ModalShell.jsx";

/**
 * Reusable password-confirm modal (SEC-004). Used by destructive Security
 * actions (disable MFA, regenerate recovery codes, remove passkey) — every
 * call site backs onto a backend route that reverifies the password before
 * acting.
 *
 * Built on `<ModalShell>` (A11Y-002, audit) so the focus trap, Escape
 * handling, click-outside dismiss, focus restoration on close, and
 * `role="dialog"` + `aria-modal="true"` + `aria-labelledby` semantics
 * come for free — keeps every modal surface in the app accessibly
 * uniform without duplicating the trap logic per dialog. Extracted from
 * Settings.jsx (GAP-002).
 *
 * Autofocus: ModalShell focuses the first focusable child on mount,
 * which is the password input by DOM order — no explicit `useRef` +
 * `useEffect` needed. The previous bespoke focus + Escape + click-
 * outside effects are deleted in favour of the shared shell.
 */
export default function PasswordConfirmModal({ title, description, busy, error, onConfirm, onCancel }) {
  const [password, setPassword] = useState("");

  return (
    <ModalShell
      onClose={onCancel}
      width="min(420px, 95vw)"
      ariaLabelledBy="pwd-modal-title"
      style={{ padding: "24px" }}
    >
      <form
        className="pwd-modal"
        onSubmit={(e) => { e.preventDefault(); onConfirm(password); }}
      >
        <h3 id="pwd-modal-title" className="pwd-modal__title">{title}</h3>
        {description && <p className="text-sm text-muted pwd-modal__desc">{description}</p>}
        <label className="text-sm font-semi pwd-modal__label">
          Password
          <input
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
    </ModalShell>
  );
}

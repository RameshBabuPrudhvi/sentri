import React, { useState } from "react";
import {
  AlertTriangle, Check, Download, FileText,
} from "lucide-react";

/**
 * One-time display of freshly minted recovery codes (SEC-004). Renders a
 * download button + clipboard copy + an "I've saved them" dismiss gate so
 * the user can never accidentally close without saving them. Codes are
 * NEVER persisted on the client. Extracted from Settings.jsx (GAP-002).
 */
export default function RecoveryCodesPanel({ codes, userEmail, onDismiss }) {
  const [confirmed, setConfirmed] = useState(false);

  function handleDownload() {
    const body = [
      "Sentri MFA recovery codes",
      "================================",
      `Account: ${userEmail}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "Each code can be used once. Store them somewhere safe.",
      "",
      ...codes,
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sentri-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function handleCopy() {
    navigator.clipboard?.writeText(codes.join("\n")).catch(() => { /* user denied clipboard */ });
  }

  return (
    <div className="card card-padded recovery-panel">
      <div className="recovery-panel__header">
        <AlertTriangle size={18} color="var(--amber)" className="shrink-0 recovery-panel__icon" />
        <div>
          <div className="font-bold recovery-panel__title">Save these recovery codes now</div>
          <div className="text-xs text-muted recovery-panel__hint">
            Each code can be used once to sign in if you lose your authenticator. They will not be shown again.
          </div>
        </div>
      </div>
      <div className="text-mono text-sm recovery-panel__grid">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="recovery-panel__actions">
        <button className="btn btn-ghost btn-sm" onClick={handleDownload}>
          <Download size={13} /> Download .txt
        </button>
        <button className="btn btn-ghost btn-sm" onClick={handleCopy}>
          <FileText size={13} /> Copy
        </button>
        <label className="text-xs text-muted recovery-panel__confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I&apos;ve saved them
        </label>
        <button className="btn btn-primary btn-sm" disabled={!confirmed} onClick={onDismiss}>
          <Check size={13} /> Done
        </button>
      </div>
    </div>
  );
}

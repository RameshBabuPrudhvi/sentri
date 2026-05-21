import React, { useState } from "react";
import { Check, RefreshCw, Trash2 } from "lucide-react";

/**
 * Two-stage destructive-action row (Confirm → Action). Used by the Data
 * section to wrap "Clear Runs / Activity Log / Healing History". The
 * confirm latch auto-resets after the action completes. Mirrors the
 * delete-confirmation pattern in Linear / Vercel / GitHub Settings.
 * Extracted from Settings.jsx (GAP-002).
 */
export default function DataAction({ icon, label, sub, count, btnLabel, onAction }) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing]     = useState(false);
  const [result, setResult]         = useState(null);

  async function handleClick() {
    if (!confirming) { setConfirming(true); return; }
    setClearing(true);
    try {
      const res = await onAction();
      setResult(`Cleared ${res.cleared} item${res.cleared !== 1 ? "s" : ""}`);
      setTimeout(() => setResult(null), 3000);
    } catch (err) {
      setResult(`Error: ${err.message}`);
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  }

  return (
    <div className="st-data-action">
      <div className="text-muted">{icon}</div>
      <div className="flex-1">
        <div className="font-semi" style={{ fontSize: "0.88rem" }}>
          {label}
          {count != null && <span className="text-xs text-muted" style={{ fontWeight: 400, marginLeft: 6 }}>({count})</span>}
        </div>
        <div className="text-xs text-muted" style={{ marginTop: 2 }}>{sub}</div>
      </div>
      {result ? (
        <span className="st-status-ok" style={{ marginTop: 0 }}>
          <Check size={12} /> {result}
        </span>
      ) : (
        <button className={`btn btn-sm ${confirming ? "btn-danger" : "btn-ghost"}`}
          onClick={handleClick} disabled={clearing || count === 0} style={{ flexShrink: 0 }}>
          {clearing ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
          {confirming ? "Confirm?" : btnLabel}
        </button>
      )}
    </div>
  );
}

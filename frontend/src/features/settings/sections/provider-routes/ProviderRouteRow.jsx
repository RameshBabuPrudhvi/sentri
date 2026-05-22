import React from "react";
import {
  Activity, AlertCircle, Check, KeyRound, RefreshCw, Trash2,
} from "lucide-react";
import ProbeBadge from "./ProbeBadge.jsx";
import { maskedKeyDisplay } from "./providerRoutes.utils.js";

/**
 * Per-row card inside the Provider Routes list. Carries its own action bar +
 * inline rotate-key panel. Pulled into a separate file so the parent section
 * stays a clean `rows.map`. Action handlers are passed in as props — the row
 * is otherwise stateless. Extracted from Settings.jsx (GAP-002).
 */
export default function ProviderRouteRow({
  row, rows, rowState, rotateOpen, setRotateOpen, rotateBuf, setRotateBuf,
  onEdit, onDelete, onProbe, onRotate,
}) {
  const probing  = rowState?.kind === "probing";
  const rotating = rowState?.kind === "rotating";
  const deleting = rowState?.kind === "deleting";
  const liveCaps = rowState?.kind === "ok" && rowState.caps ? rowState.caps : null;
  const fallbackName = row.fallbackRouteId
    ? (rows.find((r) => r.id === row.fallbackRouteId)?.name || row.fallbackRouteId)
    : null;
  return (
    <div className="card-padded-sm st-pr-row">
      <div className="st-pr-row-header">
        <div className="st-pr-row-name">
          <span className="font-semi">{row.name}</span>
          {!row.enabled && <span className="st-pr-badge st-pr-badge--disabled">Disabled</span>}
          <ProbeBadge capabilities={row.capabilities} live={liveCaps} />
        </div>
        <div className="text-xs text-muted st-pr-row-meta">
          {row.family} · {row.protocol} · {row.model || "—"}
          {row.baseUrl && ` · ${row.baseUrl}`}
          {" · "}<span className="text-mono">{maskedKeyDisplay(row.apiKeyLastFour)}</span>
        </div>
        <div className="text-xs text-muted st-pr-row-meta">
          rpm {row.rpmLimit ?? "∞"} · tpm {row.tpmLimit ?? "∞"}
          {row.cacheEnabled ? ` · cache ${row.cacheTtlSec || 0}s` : " · no cache"}
          {fallbackName && ` · fallback ${fallbackName}`}
        </div>
        {rowState?.kind === "err" && (
          <div className="st-status-err st-pr-row-error">
            <AlertCircle size={11} /> {rowState.msg}
          </div>
        )}
      </div>
      <div className="st-pr-row-actions">
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => onProbe(row.id)}
          disabled={probing}
          title="Send a real network probe to verify reachability, auth, model, and JSON mode."
        >
          {probing ? <RefreshCw size={11} className="spin" /> : <Activity size={11} />}
          {row.capabilities ? "Re-probe" : "Test"}
        </button>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => setRotateOpen(rotateOpen ? null : row.id)}
          disabled={rotating}
          title="Replace the stored API key. Server gates on a successful probe."
        >
          <KeyRound size={11} />
          Rotate key
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => onEdit(row)}>
          Edit
        </button>
        <button className="btn btn-danger btn-xs" onClick={() => onDelete(row.id)} disabled={deleting}>
          {deleting ? <RefreshCw size={11} className="spin" /> : <Trash2 size={11} />}
          Delete
        </button>
      </div>
      {rotateOpen && (
        <div className="st-pr-rotate-panel">
          <div className="st-key-input-wrap st-pr-rotate-input">
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={rotateBuf[row.id] || ""}
              onChange={(e) => setRotateBuf((b) => ({ ...b, [row.id]: e.target.value }))}
              placeholder="New API key (plaintext — encrypted server-side)"
            />
          </div>
          <button
            className="btn btn-primary btn-xs"
            onClick={() => onRotate(row.id)}
            disabled={rotating || !(rotateBuf[row.id] || "").trim()}
          >
            {rotating ? <RefreshCw size={11} className="spin" /> : <Check size={11} />}
            Rotate
          </button>
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => {
              setRotateOpen(null);
              setRotateBuf((b) => { const n = { ...b }; delete n[row.id]; return n; });
            }}
            disabled={rotating}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

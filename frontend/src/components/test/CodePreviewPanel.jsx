/**
 * @module components/test/CodePreviewPanel
 * @description Review panel for AI-regenerated Playwright code. Shows a diff
 * of original vs generated code with Accept / Edit / Discard actions.
 *
 * Extracted from TestDetail.jsx to reduce page-level complexity.
 */

import React, { Suspense, lazy } from "react";
import { RefreshCw, CheckCircle2, Edit2, X } from "lucide-react";

const DiffView = lazy(() => import("../DiffView.jsx"));

/**
 * @param {Object}   props
 * @param {Object}   props.preview        - `{ generatedCode, originalCode }`.
 * @param {boolean}  props.applying       - True while the accept request is in-flight.
 * @param {function} props.onAccept       - Called when user clicks Accept.
 * @param {function} props.onEdit         - Called when user clicks Edit Code.
 * @param {function} props.onDiscard      - Called when user clicks Discard / X.
 */
export default function CodePreviewPanel({ preview, applying, onAccept, onEdit, onDiscard }) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--accent)", borderRadius: 10 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "12px 16px",
        background: "var(--accent-bg)",
        borderBottom: "1px solid rgba(91,110,245,0.2)",
      }}>
        <RefreshCw size={15} color="var(--accent)" />
        <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--accent)", flex: 1 }}>
          Code Regenerated — Review Changes
        </span>
        <button onClick={onDiscard} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 4, display: "flex" }} title="Discard">
          <X size={15} />
        </button>
      </div>
      <div style={{ padding: "10px 16px", fontSize: "0.82rem", color: "var(--text2)", background: "var(--bg2)", borderBottom: "1px solid var(--border)" }}>
        The AI updated the Playwright code to match your new steps. Review the diff below, then accept, edit, or discard.
      </div>
      <div style={{ padding: "12px 16px" }}>
        <Suspense fallback={<div style={{ height: 80, background: "var(--bg2)", borderRadius: 6 }} />}>
          <DiffView before={preview.originalCode || ""} after={preview.generatedCode} />
        </Suspense>
      </div>
      <div style={{
        display: "flex", gap: 8, padding: "12px 16px",
        borderTop: "1px solid var(--border)",
        justifyContent: "flex-end",
      }}>
        <button className="btn btn-ghost btn-sm" onClick={onDiscard} disabled={applying}>
          <X size={13} /> Discard
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onEdit} disabled={applying}>
          <Edit2 size={13} /> Edit Code
        </button>
        <button className="btn btn-primary btn-sm" onClick={onAccept} disabled={applying}>
          {applying
            ? <><RefreshCw size={13} className="spin" /> Applying…</>
            : <><CheckCircle2 size={13} /> Accept</>
          }
        </button>
      </div>
    </div>
  );
}
import React, { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertCircle, Check, RefreshCw,
} from "lucide-react";
import { api } from "../../../../api.js";

/**
 * B3.7 — Workspace-level spend caps. Reads the workspace via
 * `api.getWorkspace()` on mount; posts via `api.updateWorkspace()` with the
 * three B3.7 fields (`dailySpendCapUsd`, `monthlySpendCapUsd`,
 * `spendAlertThresholdPct`). Sits above the per-route form so admins see
 * workspace-wide limits before per-route limits — the "blast radius" frames
 * the conversation. Extracted from Settings.jsx (GAP-002).
 */
export default function WorkspaceSpendCapsPanel() {
  const [ws, setWs] = useState(null);
  const [draft, setDraft] = useState({ daily: "", monthly: "", threshold: 80 });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  const load = useCallback(async () => {
    try {
      const w = await api.getWorkspace();
      setWs(w);
      setDraft({
        daily: w.dailySpendCapUsd ?? "",
        monthly: w.monthlySpendCapUsd ?? "",
        threshold: w.spendAlertThresholdPct ?? 80,
      });
    } catch (err) {
      setStatus({ type: "err", text: err.message || "Failed to load workspace." });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Coerce empty string → null (clear cap) so the backend receives the
  // explicit "no cap" sentinel, not a 400-rejected empty string.
  function valueOrNull(v) {
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const daily = valueOrNull(draft.daily);
      const monthly = valueOrNull(draft.monthly);
      if (Number.isNaN(daily)) throw new Error("Daily cap must be a non-negative number or empty.");
      if (Number.isNaN(monthly)) throw new Error("Monthly cap must be a non-negative number or empty.");
      const threshold = Number(draft.threshold);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
        throw new Error("Alert threshold must be between 0 and 100.");
      }
      await api.updateWorkspace({
        dailySpendCapUsd: daily,
        monthlySpendCapUsd: monthly,
        spendAlertThresholdPct: threshold,
      });
      setStatus({ type: "ok", text: "Spend caps updated." });
      await load();
    } catch (err) {
      setStatus({ type: "err", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (!ws) return null;

  return (
    <div className="card-padded-sm st-pr-spend-panel">
      <div className="font-semi st-pr-spend-title">
        <Activity size={13} /> Workspace spend caps
      </div>
      <div className="text-xs text-muted st-pr-spend-sub">
        Hard cap on AI cost per workspace. Leave a field empty for &quot;unlimited&quot;.
        The dispatcher rejects new calls with <code>ERR_SPEND_CAP_EXCEEDED</code>
        once the cap is reached, and emits a warning when spend crosses the alert threshold.
      </div>
      <div className="st-pr-spend-grid">
        <label className="st-pr-field">
          <span className="st-pr-field-label">Daily cap (USD)</span>
          <input
            className="input" type="number" min={0} step="0.01"
            value={draft.daily}
            onChange={(e) => setDraft((s) => ({ ...s, daily: e.target.value }))}
            placeholder="—"
          />
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Monthly cap (USD)</span>
          <input
            className="input" type="number" min={0} step="0.01"
            value={draft.monthly}
            onChange={(e) => setDraft((s) => ({ ...s, monthly: e.target.value }))}
            placeholder="—"
          />
        </label>
        <label className="st-pr-field">
          <span className="st-pr-field-label">Alert at (% of cap)</span>
          <input
            className="input" type="number" min={0} max={100}
            value={draft.threshold}
            onChange={(e) => setDraft((s) => ({ ...s, threshold: e.target.value }))}
          />
        </label>
      </div>
      <div className="st-pr-spend-actions">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
          {busy ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
          Save caps
        </button>
        {status && (
          <span className={status.type === "ok" ? "st-status-ok" : "st-status-err"}>
            {status.type === "ok" ? <Check size={12} /> : <AlertCircle size={12} />} {status.text}
          </span>
        )}
      </div>
    </div>
  );
}

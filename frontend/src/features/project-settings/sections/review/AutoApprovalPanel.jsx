import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../../../api.js";

/**
 * AutoApprovalPanel — configures `project.autoApproveThreshold` and renders
 * the approval-stats calibration line (AUTO-003b).
 *
 * Extracted verbatim from `components/automation/ProjectQualityCard.jsx`
 * (the inline `AutoApprovalPanel` defined around lines 226-412 in the
 * legacy file). Behaviour unchanged:
 *
 *   - Threshold input, empty → null (feature off).
 *   - Calibration stats fetch on mount + after every save; surfaces an
 *     amber note if the fetch fails so users don't tune blind.
 *   - First-time-enable preview: shows which of the last 30 generated tests
 *     would have been auto-approved at the proposed threshold, in a portal-
 *     mounted modal, before persisting.
 */
export default function AutoApprovalPanel({ project, canEdit, onToast }) {
  const [value, setValue] = useState(
    project.autoApproveThreshold == null ? "" : String(project.autoApproveThreshold),
  );
  const [stats, setStats] = useState(null);
  // Calibration stats are trust-critical for this feature — silently hiding
  // the line on a fetch failure could lead a user to set a threshold without
  // any context for whether their current threshold is over- or under-tuned.
  const [statsError, setStatsError] = useState(null);
  const [saving, setSaving] = useState(false);
  // First-time-enable preview. Holds the pending threshold + last-30-tests
  // sample so the user sees what they're about to greenlight before
  // persisting. `null` means no preview pending.
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getApprovalStats(project.id)
      .then((s) => { if (!cancelled) { setStats(s); setStatsError(null); } })
      .catch((err) => {
        if (cancelled) return;
        setStats(null);
        setStatsError(err?.message || "Could not load calibration stats.");
      });
    return () => { cancelled = true; };
  }, [project.id]);

  const persist = async (threshold) => {
    setSaving(true);
    try {
      await api.updateProject(project.id, { autoApproveThreshold: threshold });
      onToast?.(
        threshold === null
          ? "Auto-approval disabled."
          : `Auto-approval threshold set to ${threshold}.`,
        "success",
      );
      // Re-fetch stats so the calibration line reflects the new state. Mirror
      // the mount-time error handling so a post-save fetch failure surfaces
      // the same visible note rather than leaving a stale (or missing) line.
      try {
        const fresh = await api.getApprovalStats(project.id);
        setStats(fresh);
        setStatsError(null);
      } catch (err) {
        setStats(null);
        setStatsError(err?.message || "Could not load calibration stats.");
      }
    } catch (err) {
      onToast?.(err?.message || "Failed to save threshold.", "error");
    } finally {
      setSaving(false);
    }
  };

  // First-time enablement guard. When the project goes from "no threshold"
  // → "some threshold", show a preview of which of the last 30 generated
  // tests would have been auto-approved at the proposed threshold so the
  // user can sanity-check before flipping the switch.
  const save = async () => {
    const trimmed = value.trim();
    const threshold = trimmed === "" ? null : Number(trimmed);
    if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
      onToast?.("Threshold must be empty or a number greater than 0 and at most 1.", "error");
      return;
    }
    const isFirstEnable = threshold !== null && project.autoApproveThreshold == null;
    if (!isFirstEnable) {
      await persist(threshold);
      return;
    }
    try {
      const tests = await api.getTests(project.id);
      const recent = [...tests]
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, 30);
      const wouldApprove = recent.filter(
        (t) => Number.isFinite(t.confidenceScore) && t.confidenceScore >= threshold,
      );
      setPreview({ threshold, sample: recent, wouldApprove });
    } catch {
      // Preview fetch failed — fall through to direct persist rather than
      // block the user. The toast on persist() will surface any save error.
      await persist(threshold);
    }
  };

  const revertPct = stats && stats.autoApprovals7d > 0
    ? Math.round((stats.revertRate7d || 0) * 100)
    : null;

  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label">
          Confidence threshold (0.05–1) — leave empty to disable
        </label>
        <div className="aap-field-row">
          <input
            type="number"
            min="0.05"
            max="1"
            step="0.05"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!canEdit || saving}
            placeholder="e.g. 0.8"
            className="aap-input"
          />
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!canEdit || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {stats && (
        <div className="aap-stats">
          {stats.auto} auto-approved · {stats.human} human-approved · {stats.draft} draft
          {revertPct !== null && (
            <> · <span title={`${stats.reverts7d} of ${stats.autoApprovals7d} auto-approvals were revoked in the last 7 days`}>
              {revertPct}% revert rate (7d)
            </span></>
          )}
        </div>
      )}
      {!stats && statsError && (
        <div className="aap-stats-error" role="status">
          ⚠ Calibration stats unavailable — {statsError}
        </div>
      )}
      {preview && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm auto-approval threshold"
          className="aap-modal-backdrop"
          onClick={() => setPreview(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="aap-modal"
          >
            <h3 className="aap-modal__title">Enable auto-approval at {preview.threshold.toFixed(2)}?</h3>
            <p className="aap-modal__desc">
              Of the last {preview.sample.length} generated test{preview.sample.length === 1 ? "" : "s"} on this project,{" "}
              <strong>{preview.wouldApprove.length}</strong> would have been auto-approved at this threshold.
              Sample these before enabling — once on, future tests bypass review automatically.
            </p>
            {preview.wouldApprove.length > 0 && (
              <ul className="aap-modal__sample">
                {preview.wouldApprove.slice(0, 10).map((t) => (
                  <li key={t.id}>
                    {t.name} <span className="aap-modal__sample-score">· {t.confidenceScore.toFixed(2)}</span>
                  </li>
                ))}
                {preview.wouldApprove.length > 10 && (
                  <li className="aap-modal__sample-overflow">…and {preview.wouldApprove.length - 10} more</li>
                )}
              </ul>
            )}
            <div className="aap-modal__actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setPreview(null)} disabled={saving}>Cancel</button>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => { const t = preview.threshold; setPreview(null); await persist(t); }}
                disabled={saving}
              >
                {saving ? "Enabling…" : "Enable auto-approval"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

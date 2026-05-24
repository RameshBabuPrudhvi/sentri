import React, { useEffect, useState } from "react";
import { api } from "../../../../api.js";

/**
 * CoveragePanel — extracted verbatim from `components/automation/ProjectQualityCard.jsx`
 * (the `CoveragePanel` inner component). Behaviour unchanged:
 *
 *   - `coverageEnabled`                  toggle + save
 *   - `sourcemapBaseUrl`                 optional input
 *   - `coverageRegressionThresholdPct`   alert threshold (NOT a gate — see
 *                                        Quality Gates "Max coverage regression"
 *                                        for the run-failing rule)
 *   - per-project sparkline + latest-%   from `api.getCoverageTrend`
 *
 * Lives next to `QualityGatesSection.jsx` because it's tightly coupled to the
 * Coverage block and isn't useful elsewhere. Once the legacy
 * `ProjectQualityCard.jsx` is deleted (step 6 of the migration plan), this
 * is the canonical source.
 */
export default function CoveragePanel({ project, canEdit, onToast }) {
  const [enabled, setEnabled] = useState(!!project.coverageEnabled);
  const [sourcemapBaseUrl, setSourcemapBaseUrl] = useState(project.sourcemapBaseUrl || "");
  const [regressionThreshold, setRegressionThreshold] = useState(
    project.coverageRegressionThresholdPct != null ? String(project.coverageRegressionThresholdPct) : "",
  );
  const [saving, setSaving] = useState(false);
  const [trend, setTrend] = useState(null);

  useEffect(() => {
    if (!project.coverageEnabled) { setTrend(null); return; }
    let cancelled = false;
    api.getCoverageTrend(project.id)
      .then((t) => { if (!cancelled) setTrend(t); })
      .catch(() => { /* best-effort — settings still work without the sparkline */ });
    return () => { cancelled = true; };
  }, [project.id, project.coverageEnabled]);

  const save = async () => {
    const trimmedThreshold = regressionThreshold.trim();
    const thresholdVal = trimmedThreshold === "" ? null : Number(trimmedThreshold);
    if (thresholdVal !== null && (!Number.isFinite(thresholdVal) || thresholdVal < 0 || thresholdVal > 100)) {
      onToast?.({ type: "error", message: "Regression alert threshold must be empty (disabled) or a number between 0 and 100." });
      return;
    }
    setSaving(true);
    try {
      await api.updateProject(project.id, {
        coverageEnabled: enabled,
        sourcemapBaseUrl: sourcemapBaseUrl.trim() || null,
        coverageRegressionThresholdPct: thresholdVal,
      });
      onToast?.({ type: "success", message: "Coverage settings saved." });
    } catch (err) {
      onToast?.({ type: "error", message: err?.message || "Failed to save coverage settings." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aap-panel">
      <label className="aap-stats">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!canEdit || saving} />
        {" "}Enable browser JS coverage capture
      </label>
      <input
        className="aap-input"
        placeholder="Optional source-map base URL"
        value={sourcemapBaseUrl}
        onChange={(e) => setSourcemapBaseUrl(e.target.value)}
        disabled={!canEdit || saving}
      />
      <div className="aap-section">
        <label className="aap-field-label">
          Regression alert threshold (%) — leave empty to disable
        </label>
        <input
          type="number"
          min="0"
          max="100"
          step="0.1"
          className="aap-input"
          placeholder="e.g. 5"
          value={regressionThreshold}
          onChange={(e) => setRegressionThreshold(e.target.value)}
          disabled={!canEdit || saving}
        />
        <div className="aap-stats aap-stats--hint">
          Fires a Teams / email / webhook notification when coverage drops more
          than this percentage vs. the prior run. Does NOT fail the run — use
          Quality Gates → Max coverage regression for that.
        </div>
      </div>
      <button className="btn btn-primary btn-sm" onClick={save} disabled={!canEdit || saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      {trend && trend.series && trend.series.length > 0 && (() => {
        const latest = trend.series[trend.series.length - 1];
        const latestPct = Math.round((latest?.coveragePct || 0) * 100);
        return (
          <div className="aap-section">
            <div className="aap-stats">
              <strong>Latest coverage: {latestPct}%</strong>
              <span className="text-muted"> · {trend.series.length} run{trend.series.length !== 1 ? "s" : ""} in last {trend.windowDays}d</span>
            </div>
            <div className="aap-stats aap-stats--hint">
              {trend.series.map((p) => `${Math.round((p.coveragePct || 0) * 100)}%`).join(" → ")}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

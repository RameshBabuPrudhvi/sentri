/**
 * EvalPanel — AUTO-022 AI eval-harness Dashboard surface.
 *
 * Renders a 30-day per-dimension trend backed by the `evalTrend` block on
 * `GET /api/v1/dashboard`. Reuses the shared `<TrendChart>` primitive (the
 * same component AUTO-017.3 uses for Web Vitals trends) — one chart per
 * dimension so the panel composes cleanly into the existing dashboard
 * grid without a new chart library or layout primitive.
 *
 * Drill-down side panel is lazy-loaded — `getEvalRunDetail()` only fires
 * when the user clicks the latest run row. Empty state renders a hint
 * when no eval rows have been persisted yet (CI runs read-only by
 * default; `--persist` is opt-in from a nightly job).
 *
 * Empty state is rendered by the caller — this component returns `null`
 * when `evalTrend` is null so Dashboard.jsx can decide whether to render
 * a skeleton hint or simply skip the panel.
 */

import React, { useEffect, useState } from "react";
import { Activity, X } from "lucide-react";
import TrendChart from "../shared/TrendChart.jsx";
import { api } from "../../api.js";

const DIMENSIONS = [
  { key: "aggregate",  label: "Aggregate" },
  { key: "selectors",  label: "Selectors" },
  { key: "actions",    label: "Actions" },
  { key: "assertions", label: "Assertions" },
];

function formatScore(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function ScoreBadge({ value }) {
  const cls = value == null ? "dash-eval-score--none"
    : value >= 0.8 ? "dash-eval-score--good"
    : value >= 0.5 ? "dash-eval-score--warn"
    : "dash-eval-score--bad";
  return <span className={`dash-eval-score ${cls}`}>{formatScore(value)}</span>;
}

export default function EvalPanel({ evalTrend }) {
  const [openRunId, setOpenRunId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!openRunId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setDetailError(null);
    api.getEvalRunDetail(openRunId)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((err) => { if (!cancelled) setDetailError(err?.message || "Failed to load run detail."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [openRunId]);

  if (!evalTrend) return null;

  const runs = evalTrend.runs || [];
  const latestRun = runs[runs.length - 1] || null;

  // Build per-dimension sample arrays for the four TrendCharts.
  const samplesByDimension = {};
  for (const dim of DIMENSIONS) {
    samplesByDimension[dim.key] = runs.map((r) => ({
      ts: new Date(r.createdAt).getTime(),
      value: r[dim.key] ?? 0,
    }));
  }

  return (
    <div className="card card-padded mb-md">
      <div className="flex-between mb-md">
        <div className="flex-center gap-sm">
          <Activity size={14} color="var(--accent)" />
          <span className="section-title" style={{ marginBottom: 0 }}>AI Eval Quality</span>
        </div>
        <span className="text-xs text-muted">
          {runs.length} run{runs.length !== 1 ? "s" : ""} · last {evalTrend.windowDays} days
        </span>
      </div>

      <div
        className="dash-eval-grid"
        role="group"
        aria-label={`AI eval scores, last ${evalTrend.windowDays} days`}
      >
        {DIMENSIONS.map((dim) => (
          <TrendChart
            key={dim.key}
            title={dim.label}
            samples={samplesByDimension[dim.key]}
          />
        ))}
      </div>

      {latestRun && (
        <div className="dash-eval-latest">
          <div className="dash-eval-latest-row">
            <div>
              <div className="dash-eval-latest-label">Latest run</div>
              <div className="dash-eval-latest-meta">
                {new Date(latestRun.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                {" · "}{latestRun.caseCount} case{latestRun.caseCount !== 1 ? "s" : ""}
              </div>
            </div>
            <div className="dash-eval-latest-score">
              <ScoreBadge value={latestRun.aggregate} />
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setOpenRunId(latestRun.runId)}
              aria-label={`Open drill-down for run ${latestRun.runId}`}
            >
              Drill down
            </button>
          </div>
        </div>
      )}

      {openRunId && (
        <div className="dash-eval-drilldown" role="dialog" aria-label="Eval run detail">
          <div className="dash-eval-drilldown-header">
            <div>
              <div className="dash-eval-latest-label">Run detail</div>
              <div className="dash-eval-latest-meta">{openRunId}</div>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setOpenRunId(null)}
              aria-label="Close drill-down"
            >
              <X size={14} />
            </button>
          </div>
          {loading && <div className="dash-eval-loading">Loading…</div>}
          {detailError && <div className="dash-eval-error">{detailError}</div>}
          {!loading && !detailError && detail && (
            <table className="table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Category</th>
                  <th>Aggregate</th>
                  <th>Selectors</th>
                  <th>Actions</th>
                  <th>Assertions</th>
                </tr>
              </thead>
              <tbody>
                {detail.cases.map((c) => (
                  <tr key={c.caseId}>
                    <td className="dash-eval-case-id">{c.caseId}</td>
                    <td><span className="badge badge-gray">{c.category}</span></td>
                    <td><ScoreBadge value={c.score.aggregate} /></td>
                    <td><ScoreBadge value={c.score.selectors} /></td>
                    <td><ScoreBadge value={c.score.actions} /></td>
                    <td><ScoreBadge value={c.score.assertions} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

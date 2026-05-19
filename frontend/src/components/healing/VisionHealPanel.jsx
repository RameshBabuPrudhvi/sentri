/**
 * @module components/healing/VisionHealPanel
 * @description MNT-001 — Healing-dashboard surface for stage 7 / 8 vision
 * heals. Renders a zero-state when no vision heals have been recorded yet,
 * and a 3-up stat grid + audit-log drill-down link once data exists.
 *
 * Backend contract: shape comes from `GET /api/v1/healing/summary` which
 * `MNT-001a` extended with `visionHealCount` / `visionHealCostUsd` /
 * `visionHealStrategy` fields. The pre-existing callsite in
 * `HealingDashboard.jsx` passes these three props verbatim, so the panel's
 * external shape is unchanged — only the rendering got richer.
 *
 * Why no inline TrendChart yet: the time-series source for
 * `healing.visionHealCount` lives in `metric_samples` (written by
 * `healingPersistence.js#recordMetric`) but the existing `useProjectMetricQuery`
 * hook is workspace-scoped and the Healing dashboard is currently
 * project-agnostic at the route level. Wiring a per-project sparkline
 * requires a `projectId` selector first — deferred to MNT-001c so this
 * PR can land cleanly without dragging in route changes.
 */
import React from "react";
import { Eye, AlertTriangle, ExternalLink } from "lucide-react";

/**
 * Whether the LLM-stage share is high enough to warn operators that they
 * should consider raising the pixelmatch confidence threshold (cheap CV)
 * or capturing more baselines. 50% is the documented threshold from the
 * vision-healing operator guide — half of all heals going through the
 * paid LLM path is a "reconsider your config" signal, not a bug.
 */
const LLM_SHARE_WARN_THRESHOLD = 0.5;

export default function VisionHealPanel({
  count = 0,
  costUsd = 0,
  strategy = { pixelmatch: 0, llm: 0 },
  projectId = null,
}) {
  // Zero-state: render an explainer so operators landing on the Healing
  // dashboard for the first time understand WHY there's no data, rather
  // than seeing "Heals: 0" and worrying something's broken.
  if (count === 0) {
    return (
      <div className="card card-padded mb-lg" data-testid="vision-heal-panel-empty">
        <h2 className="section-title">
          <Eye size={14} className="vh-icon" aria-hidden />
          Vision-based healing
        </h2>
        <p className="text-sm vh-empty-hint">
          No vision heals recorded yet. Vision healing fires only when every
          DOM-based selector strategy fails — a sign of major UI redesigns
          or selector breakage. Configure per-project in{" "}
          <strong>Quality → Vision Healing</strong>.
        </p>
      </div>
    );
  }

  const pixelmatchCount = strategy?.pixelmatch || 0;
  const llmCount = strategy?.llm || 0;
  const llmShare = count > 0 ? llmCount / count : 0;
  const showLlmShareWarning = llmShare >= LLM_SHARE_WARN_THRESHOLD;

  // Build the audit-log drill-down URL. We filter by all three vision
  // activity types so the budget-exhausted soft-disable events are
  // included alongside successful heals — that's the full picture an
  // operator needs when investigating "why did stage 8 stop firing?".
  const auditTypes = "healing.vision_pixelmatch,healing.vision_llm,healing.vision_budget_exhausted";
  const auditHref = projectId
    ? `/activity?type=${auditTypes}&projectId=${encodeURIComponent(projectId)}`
    : `/activity?type=${auditTypes}`;

  return (
    <div className="card card-padded mb-lg" data-testid="vision-heal-panel">
      <div className="vh-panel-header">
        <h2 className="section-title vh-panel-title">
          <Eye size={14} className="vh-icon" aria-hidden />
          Vision-based healing
        </h2>
        <a
          href={auditHref}
          className="text-sm vh-audit-link"
          title="Open the audit log filtered to vision-heal events"
        >
          Audit log <ExternalLink size={12} aria-hidden />
        </a>
      </div>

      <div className="vh-stat-grid">
        <div>
          <div className="text-xs vh-stat-label">Total heals</div>
          <div className="vh-stat-value">{count}</div>
        </div>
        <div>
          <div className="text-xs vh-stat-label">LLM spend</div>
          <div className="vh-stat-value">
            ${Number(costUsd || 0).toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-xs vh-stat-label">Strategy split</div>
          <div className="vh-strategy-row">
            <span title="Free CV-based heals (stage 7)">{pixelmatchCount} pixelmatch</span>
            <span className="vh-strategy-sep">·</span>
            <span title="Paid LLM-vision heals (stage 8)">{llmCount} LLM</span>
            {showLlmShareWarning && (
              <AlertTriangle
                size={14}
                aria-label="LLM share over 50% — consider raising the pixelmatch confidence threshold or capturing more baselines"
                className="vh-strategy-warn"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

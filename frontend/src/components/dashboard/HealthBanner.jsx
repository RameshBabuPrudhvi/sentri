/**
 * @module components/dashboard/HealthBanner
 * @description GAP-003 (audit) — workspace health banner at the top of
 * `pages/Dashboard.jsx`. Surfaces actionable alerts ("3 projects failing
 * today", "4 tests awaiting review", "2 runs in progress") so a failing-
 * morning is visible at first glance instead of buried in row 8 of the
 * recent-runs table.
 *
 * Scope: banner half of GAP-003's three-tier hierarchy. The 4-card stat
 * grid below already serves as the primary-KPI row; the "collapse
 * supporting detail" half is deferred to a future PR (UX-risky behavior
 * change with its own QA cycle).
 *
 * Data: derived client-side from the existing `/api/v1/dashboard`
 * payload — no new backend field, no extra round-trip. A future
 * enhancement can introduce a server-side `activeAlerts[]` shape (per
 * the audit) for spend-cap warnings + quality-gate violations the
 * dashboard payload doesn't currently expose.
 *
 * Renders nothing when there are no alerts (zero noise on healthy days).
 */

import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Inbox, PlayCircle, ChevronRight } from "lucide-react";

/**
 * Build the alert list from the dashboard payload.
 * Stable function reference — pure compute, no React state.
 *
 * @param {Object} data Dashboard payload (`useDashboardQuery().data`).
 * @param {number} pendingReviewCount Workspace-wide draft count from
 *   `useReviewQueueCounts({ projectId: "all" }).draft`. Threaded in
 *   from the parent so the banner reuses the same TanStack Query cache
 *   as the sidebar pending-pill (GAP-004).
 * @returns {Array<{kind: string, label: string, count: number, to: string, tone: "red"|"amber"|"blue"}>}
 */
function deriveAlerts(data, pendingReviewCount) {
  if (!data) return [];
  const alerts = [];

  // ── Projects failing today ──────────────────────────────────────────
  // Count distinct projectIds whose most-recent test_run today failed.
  // `recentRuns` is sorted desc by startedAt and capped at 8, so this
  // catches the morning-after case the audit specifically describes
  // ("3 projects with regressions"). When a project has multiple runs
  // today, we honour the most-recent outcome — a green run after a red
  // run today is healthy, not a regression.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const latestRunByProject = new Map();
  for (const r of data.recentRuns || []) {
    if (r.type !== "test_run" && r.type !== "run") continue;
    if (!r.startedAt) continue;
    const ts = new Date(r.startedAt).getTime();
    if (ts < todayStartMs) continue;
    if (!latestRunByProject.has(r.projectId)) latestRunByProject.set(r.projectId, r);
  }
  const failingProjectIds = [];
  for (const [pid, r] of latestRunByProject.entries()) {
    if (r.status === "failed" || (r.failed || 0) > 0) failingProjectIds.push(pid);
  }
  if (failingProjectIds.length > 0) {
    alerts.push({
      kind: "failing-projects",
      label: `${failingProjectIds.length} project${failingProjectIds.length !== 1 ? "s" : ""} failing today`,
      count: failingProjectIds.length,
      to: "/runs?status=failed",
      tone: "red",
    });
  }

  // ── Tests awaiting review ───────────────────────────────────────────
  // GAP-004 sidebar badge already covers this signal, but the audit
  // explicitly lists it as a health-banner entry too: a QA Lead landing
  // on the dashboard should see pending-review work without having to
  // scan the sidebar.
  if (pendingReviewCount > 0) {
    alerts.push({
      kind: "pending-review",
      label: `${pendingReviewCount} test${pendingReviewCount !== 1 ? "s" : ""} awaiting review`,
      count: pendingReviewCount,
      to: "/review-queue",
      tone: "amber",
    });
  }

  // ── Runs in progress ────────────────────────────────────────────────
  // Surfaces active long-running runs so users don't accidentally
  // trigger duplicate work. Read from `runsByStatus.running` which the
  // dashboard payload already populates.
  const runningCount = data.runsByStatus?.running || 0;
  if (runningCount > 0) {
    alerts.push({
      kind: "running",
      label: `${runningCount} run${runningCount !== 1 ? "s" : ""} in progress`,
      count: runningCount,
      to: "/runs?status=running",
      tone: "blue",
    });
  }

  return alerts;
}

const ICON_FOR_KIND = {
  "failing-projects": AlertTriangle,
  "pending-review":   Inbox,
  "running":          PlayCircle,
};

/**
 * @param {Object} props
 * @param {Object} props.data - Dashboard query payload.
 * @param {number} props.pendingReviewCount - Workspace-wide draft count.
 */
export default function HealthBanner({ data, pendingReviewCount }) {
  const navigate = useNavigate();
  const alerts = useMemo(
    () => deriveAlerts(data, pendingReviewCount),
    [data, pendingReviewCount],
  );

  if (alerts.length === 0) return null;

  return (
    <div className="dash-health-banner" role="status" aria-label="Workspace health alerts">
      {alerts.map((a) => {
        const Icon = ICON_FOR_KIND[a.kind] || AlertTriangle;
        return (
          <button
            key={a.kind}
            type="button"
            className={`dash-health-row dash-health-row--${a.tone}`}
            onClick={() => navigate(a.to)}
          >
            <Icon size={14} className="dash-health-row__icon" />
            <span className="dash-health-row__label">{a.label}</span>
            <ChevronRight size={13} className="dash-health-row__chevron" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * @module pages/Systems
 * @description System overview page — runtime infrastructure telemetry.
 *
 * Scope (post-cleanup): worker pool telemetry only (BullMQ queue depth,
 * active workers, completed jobs). The legacy AI-Provider summary card
 * was removed because Settings → AI Providers is the canonical surface
 * for that data; the per-project Application-Environments list was
 * removed because Dashboard / Projects / ProjectDetail already render
 * those stats with no value-add here.
 */

import React from "react";
import { Server } from "lucide-react";
import { useDashboardQuery } from "../hooks/queries/useDashboardQuery.js";
import usePageTitle from "../hooks/usePageTitle.js";
import WorkerPoolPanel from "../components/shared/WorkerPoolPanel.jsx";

function SectionHeader({ icon, title, sub }) {
  return (
    <div className="sys-section-header">
      <div className="sys-section-header__icon">{icon}</div>
      <div>
        <div className="sys-section-header__title">{title}</div>
        {sub && <div className="sys-section-header__sub">{sub}</div>}
      </div>
    </div>
  );
}

export default function Systems() {
  usePageTitle("System");
  // DASH-003 (audit): worker-pool telemetry moved off the dashboard onto
  // this page. Reuses the dashboard query so a user navigating Dashboard
  // → System gets the cached payload immediately (TanStack Query caches
  // by query key — `useDashboardQuery` mounts in both surfaces share one
  // cache entry).
  const dashboardQuery = useDashboardQuery();
  const workerPool = dashboardQuery.data?.workerPool ?? null;

  if (dashboardQuery.isLoading) return (
    <div className="page-container sys-page">
      {/* Skeleton height drives layout shape — kept inline per AGENT.md
          §127's data-driven carve-out. Everything else (border-radius,
          margin-bottom) lives on `.sys-skeleton`. */}
      <div className="skeleton sys-skeleton" style={{ height: 200 }} />
    </div>
  );

  return (
    <div className="fade-in page-container sys-page">

      {/* Header */}
      <div className="mb-lg">
        <h1 className="page-title">System</h1>
        <p className="page-subtitle">
          Worker pool telemetry and runtime infrastructure.
        </p>
      </div>

      {/* Worker pool telemetry (DASH-003, audit) — relocated from Dashboard.
          The /dashboard page now shows a single Platform Health card; the
          full 4-card breakdown lives here for operators who need the
          actual queue depth / active worker count / failed job tally. */}
      <div className="card card-padded mb-md">
        <SectionHeader
          icon={<Server size={15} color="var(--accent)" />}
          title="Worker Pool"
          sub={workerPool?.mode === "distributed"
            ? "Distributed BullMQ runners — Redis queue active"
            : workerPool
            ? "Single-process mode — no Redis configured"
            : "Telemetry unavailable"}
        />
        {workerPool ? (
          <WorkerPoolPanel workerPool={workerPool} variant="full" />
        ) : (
          <div className="text-sm text-muted">
            Worker pool telemetry will appear once the dashboard payload loads.
          </div>
        )}
      </div>

    </div>
  );
}

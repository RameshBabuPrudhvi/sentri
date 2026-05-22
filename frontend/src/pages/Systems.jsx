/**
 * @module pages/Systems
 * @description System overview page — AI provider status, application
 * environments, and crawl context. Renamed from Context.jsx to align
 * with the sidebar label and route path.
 */

import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Globe, Cpu, ChevronRight, CheckCircle2,
  XCircle, Settings as SettingsIcon,
  RefreshCw, Shield, Server,
} from "lucide-react";
import { fmtRelativeDate } from "../utils/formatters";
import useProjectData from "../hooks/useProjectData";
import { useSettingsBundleQuery } from "../hooks/queries/useSettingsQueries.js";
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

function InfoRow({ label, children }) {
  return (
    <div className="sys-info-row">
      <span className="sys-info-row__label">{label}</span>
      <span className="sys-info-row__value">{children}</span>
    </div>
  );
}

export default function Systems() {
  usePageTitle("System");
  //  useProjectData batches all project/run/test fetches in one pass (no N+1)
  const { projects, allTests, allRuns, loading } = useProjectData();
  const bundleQuery = useSettingsBundleQuery();
  const config = bundleQuery.data?.config ?? null;
  // DASH-003 (audit): worker-pool telemetry moved off the dashboard onto
  // this page. Reuses the dashboard query so a user navigating Dashboard
  // → System gets the cached payload immediately (TanStack Query caches
  // by query key — `useDashboardQuery` mounts in both surfaces share one
  // cache entry).
  const dashboardQuery = useDashboardQuery();
  const workerPool = dashboardQuery.data?.workerPool ?? null;
  const navigate = useNavigate();

  // Build crawl summary per project from already-fetched allRuns and allTests
  const crawlData = useMemo(() => {
    const map = {};
    projects.forEach(p => {
      const projectRuns = allRuns.filter(r => r.projectId === p.id);
      const lastCrawl = projectRuns
        .filter(r => r.type === "crawl")
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null;
      const tests = allTests.filter(t => t.projectId === p.id);
      map[p.id] = { lastCrawl, tests };
    });
    return map;
  }, [projects, allRuns, allTests]);

  if (loading) return (
    <div className="page-container sys-page">
      {/* Skeleton heights are genuinely continuous (60/200/200/180) and
          drive layout shape — kept inline per AGENT.md §127's data-driven
          carve-out. Everything else (border-radius, margin-bottom) lives
          on `.sys-skeleton`. */}
      {[60, 200, 200, 180].map((h, i) => (
        <div key={i} className="skeleton sys-skeleton" style={{ height: h }} />
      ))}
    </div>
  );

  const hasProjects = projects.length > 0;

  return (
    <div className="fade-in page-container sys-page">

      {/* Header */}
      <div className="mb-lg">
        <h1 className="page-title">System</h1>
        <p className="page-subtitle">
          Environment configuration, AI provider status, and crawl context for your applications
        </p>
      </div>

      {/* AI Provider — compact status with link to Settings */}
      <div className="card card-padded mb-md">
        <SectionHeader
          icon={<Cpu size={15} color="var(--accent)" />}
          title="AI Provider"
          sub="Active model used for test generation and Playwright code synthesis"
        />
        {config ? (
          <div>
            <InfoRow label="Status">
              {config.hasProvider ? (
                <span className="badge badge-green"><CheckCircle2 size={10} /> Connected</span>
              ) : (
                <span className="badge badge-red"><XCircle size={10} /> Not configured</span>
              )}
            </InfoRow>
            {config.hasProvider && (
              <>
                <InfoRow label="Provider">
                  <span className="sys-info-row__provider">{config.providerName || "—"}</span>
                </InfoRow>
                {config.model && (
                  <InfoRow label="Model">
                    <span className="sys-info-row__model">{config.model}</span>
                  </InfoRow>
                )}
              </>
            )}
            <div className="sys-provider-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => navigate("/settings")}>
                <SettingsIcon size={13} /> {config.hasProvider ? "Manage in Settings" : "Configure API Key"}
              </button>
            </div>
          </div>
        ) : (
          <div className="sys-load-error">Could not load provider config.</div>
        )}
      </div>

      {/* Worker pool telemetry (DASH-003, audit) — relocated from Dashboard.
          The /dashboard page now shows a single Platform Health card; the
          full 4-card breakdown lives here for operators who need the
          actual queue depth / active worker count / failed job tally.
          Uses the shared `.card-padded` + `.mb-md` utilities rather than
          inline padding/margin (DS-001). The sibling AI-Provider and
          Application-Environments sections in this file still use the
          inline pattern — migrating them is tracked as a separate
          page-level cleanup. */}
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

      {/* Applications context */}
      <div className="card card-padded mb-md">
        <SectionHeader
          icon={<Globe size={15} color="var(--purple)" />}
          title="Application Environments"
          sub={`${projects.length} application${projects.length !== 1 ? "s" : ""} registered`}
        />

        {!hasProjects ? (
          <div className="empty-state sys-empty">
            <Globe size={32} color="var(--text3)" className="sys-empty__icon" />
            <div className="empty-state-title">No applications registered</div>
            <div className="empty-state-desc">
              Add a project to see crawl context, test counts, and AI configuration for each application.
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
              Add First Project
            </button>
          </div>
        ) : (
          <div className="sys-app-list">
            {projects.map(p => {
              const cd = crawlData[p.id] || {};
              const crawl = cd.lastCrawl;
              const tests = cd.tests || [];
              return (
                <div
                  key={p.id}
                  className="sys-app-card"
                  onClick={() => navigate(`/projects/${p.id}`)}
                >
                  <div className="sys-app-card__head">
                    <div className="sys-app-card__head-left">
                      <div className="sys-app-card__avatar">
                        <Globe size={13} color="var(--purple)" />
                      </div>
                      <div>
                        <div className="sys-app-card__name">{p.name}</div>
                        <a
                          href={p.url} target="_blank" rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="sys-app-card__url"
                        >
                          {p.url}
                        </a>
                      </div>
                    </div>
                    <ChevronRight size={14} color="var(--text3)" />
                  </div>

                  <div className="sys-app-card__stats">
                    {[
                      { label: "Total Tests",  value: tests.length },
                      { label: "Approved",     value: tests.filter(t => t.reviewStatus === "approved").length },
                      { label: "Draft",        value: tests.filter(t => t.reviewStatus === "draft").length },
                      { label: "Pages Found",  value: crawl?.pagesFound ?? "—" },
                    ].map((item, i) => (
                      <div key={i}>
                        <div className="section-label sys-app-card__stat-label">
                          {item.label}
                        </div>
                        <div className="sys-app-card__stat-value">{item.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Crawl row */}
                  <div className="sys-app-card__crawl">
                    <RefreshCw size={11} color="var(--text3)" />
                    <span className="sys-app-card__crawl-text">
                      Last crawl: <strong className="sys-app-card__crawl-time">{fmtRelativeDate(crawl?.startedAt, "Never")}</strong>
                    </span>
                    {crawl && (
                      <span className={`badge ${crawl.status === "completed" ? "badge-green" : crawl.status === "failed" ? "badge-red" : "badge-amber"}`}>
                        {crawl.status}
                      </span>
                    )}
                    {p.credentials && (
                      <span className="badge badge-gray sys-app-card__crawl-auth">
                        <Shield size={9} /> Auth configured
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * @module components/project/ProjectHeader
 * @description Project header card with name, URL, stats, run button,
 * and export dropdown.
 *
 * Crawl & test generation live on the Tests page — this component
 * focuses on project-scoped execution (run regression) and results.
 *
 * Extracted from ProjectDetail.jsx to reduce page-level complexity.
 */

import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Play, RefreshCw, Globe, Sparkles, ArrowRight, Zap, Clock, Rocket, Settings,
} from "lucide-react";
import { PARALLEL_WORKERS_TUNING } from "../../config/testDialsConfig.js";
import { api } from "../../api.js";
import { fmtFutureRelative } from "../../utils/formatters.js";
import ProjectExportMenu from "./ProjectExportMenu.jsx";

/**
 * @param {Object} props
 * @param {Object} props.project - { name, url }
 * @param {string} props.projectId
 * @param {Object[]} props.tests - Current page of tests (used for export dropdown items).
 * @param {number} props.totalTests - Server-side total test count across all pages.
 * @param {number} props.parallelWorkers - Current parallel worker count.
 * @param {Function} props.onWorkersChange - Called with new worker count.
 * @param {string|null} props.actionLoading - "run" | null
 * @param {Function} props.onRun
 * @param {Object} props.stats - { draftTests, approvedTests, rejectedTests, apiTests, uiTests, passed, failed }
 */
export default function ProjectHeader({
  project, projectId, tests, totalTests,
  parallelWorkers, onWorkersChange,
  actionLoading, onRun,
  stats,
}) {
  const navigate = useNavigate();

  const { draftTests, approvedTests, rejectedTests, apiTests, uiTests, passed, failed } = stats;

  // ENH-006: Load next scheduled run time
  const [nextRunAt, setNextRunAt] = useState(null);
  useEffect(() => {
    if (!projectId) return;
    api.getSchedule(projectId)
      .then(data => {
        const s = data && data.schedule;
        setNextRunAt(s && s.enabled && s.nextRunAt ? s.nextRunAt : null);
      })
      .catch(() => {});
  }, [projectId]);

  // AUTO-003b: header aggregate (N tests · N human · N auto · N drafts).
  // Lives at the project level — per-run rows are intentionally untouched
  // so the per-run UI stays focused on execution status, not approval
  // provenance (per NEXT.md:84). Failures are non-fatal: the aggregate
  // line just doesn't render if the endpoint errors.
  const [approvalStats, setApprovalStats] = useState(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.getApprovalStats(projectId)
      .then((s) => { if (!cancelled) setApprovalStats(s); })
      .catch(() => { /* non-fatal — aggregate line just won't render */ });
    return () => { cancelled = true; };
  }, [projectId]);

  // AUTO-015b: "Last deployment run" badge (NEXT.md:69). Fetches the most
  // recent deployment-triggered crawl in the last 24h; badge is hidden when
  // there's nothing to show. Fail-soft: a backend error just hides the chip.
  const [lastDeploymentRun, setLastDeploymentRun] = useState(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.getLastDeploymentRun(projectId)
      .then((resp) => { if (!cancelled) setLastDeploymentRun(resp?.run || null); })
      .catch(() => { /* non-fatal — badge just won't render */ });
    return () => { cancelled = true; };
  }, [projectId]);

  return (
    <div className="card pd-header">
      <div className="pd-header-top">
        <div className="pd-header-identity">
          <div className="icon-box icon-box-accent">
            <Globe size={20} color="var(--accent)" />
          </div>
          <div>
            <h1 style={{ fontWeight: 700, fontSize: "1.2rem", marginBottom: 2 }}>{project.name}</h1>
            <a href={project.url} target="_blank" rel="noreferrer" className="text-xs text-muted text-mono">{project.url}</a>
            {approvalStats && approvalStats.total > 0 && (
              <div
                className="text-xs text-muted pd-approval-aggregate"
                title="Approval breakdown for this project (AUTO-003b)"
              >
                {approvalStats.total} tests · {approvalStats.human} human · {approvalStats.auto} auto 🤖 · {approvalStats.draft} drafts
              </div>
            )}
          </div>
        </div>
        <div className="pd-header-actions">
          {/* ── Row 1: Generate link + workers + Run button ── */}
          <div className="pd-header-row">
            {/* CI/CD — triggers, schedules, integrations, snippets. Narrower
                label than the previous "Automation" because per-project
                quality/security/healing config moved to Project Settings (the
                button below). This one is now exclusively CI/CD entry points,
                matching GitHub Actions / GitLab CI mental model. The query
                param still drives Automation.jsx to scroll to this project's
                accordion within the "Triggers & Schedules" tab. */}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate(`/automation?project=${projectId}`)}
              style={{ gap: 6 }}
            >
              <Zap size={13} />
              CI/CD
            </button>
            {/* Project Settings — sidebar shell at `/projects/:id/settings/*`
                hosts Quality Gates, Review (auto-approval), Execution
                (iteration cap), Security (PII firewall), and Self-Healing
                (vision healing). Previously these lived as a 7-tab accordion
                under Automation's "Quality Gates" outer tab; the new layout
                matches GitHub repo / Vercel project / Linear project
                settings conventions. */}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate(`/projects/${projectId}/settings`)}
              style={{ gap: 6 }}
            >
              <Settings size={13} />
              Settings
            </button>
            {nextRunAt && (
              <span
                title={"Next scheduled run: " + nextRunAt}
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.75rem", color: "var(--text3)" }}
              >
                <Clock size={11} />
                {fmtFutureRelative(nextRunAt)}
              </span>
            )}
            {/* AUTO-015b: "Last deployment run" badge — only renders when a
                webhook-triggered crawl completed in the last 24h. Click to
                navigate to the run for diff inspection. */}
            {lastDeploymentRun && (
              <button
                type="button"
                onClick={() => navigate(`/runs/${lastDeploymentRun.id}`)}
                title={`${lastDeploymentRun.provider || "deployment"} preview crawl${lastDeploymentRun.status === "running" ? " (in progress)" : ""} — ${lastDeploymentRun.previewUrl || ""}`}
                className="btn btn-ghost btn-xs"
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  fontSize: "0.75rem",
                  color: lastDeploymentRun.status === "failed" ? "var(--red)" : "var(--accent)",
                  borderColor: lastDeploymentRun.status === "failed" ? "var(--red)" : "var(--accent)",
                }}
              >
                <Rocket size={11} />
                {lastDeploymentRun.status === "running"
                  ? "Deployment crawl in progress"
                  : `Last ${lastDeploymentRun.provider || "deployment"} run · ${lastDeploymentRun.changedPages?.length || 0} changed`}
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate("/tests")}
              style={{ gap: 6 }}
            >
              <Sparkles size={13} />
              Generate more tests
              <ArrowRight size={11} />
            </button>
            {/* Parallel workers compact selector */}
            <div className="pd-workers" title={PARALLEL_WORKERS_TUNING.desc}>
              <span className="font-semi">⚡</span>
              <select
                value={parallelWorkers ?? PARALLEL_WORKERS_TUNING.defaultVal}
                onChange={e => onWorkersChange(parseInt(e.target.value, 10))}
                className="pd-workers-select"
              >
                {Array.from({ length: PARALLEL_WORKERS_TUNING.max }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>{n}x</option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary btn-sm" onClick={onRun}
              disabled={!!actionLoading || approvedTests.length === 0}
              title={approvedTests.length === 0 ? "Approve tests first to run regression" : undefined}>
              {actionLoading === "run" ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
              Run ({approvedTests.length})
            </button>
          </div>

          {/* ── Row 2: Export dropdown ── */}
          <div className="pd-header-row">
            <ProjectExportMenu
              projectId={projectId}
              totalTests={totalTests}
              approvedCount={approvedTests.length}
            />
          </div>
        </div>
      </div>

      {totalTests > 0 && (
        <div className="pd-stats">
          {[
            { label: "Draft",    val: draftTests.length,    color: "var(--amber)" },
            { label: "Approved", val: approvedTests.length, color: "var(--green)" },
            { label: "Rejected", val: rejectedTests.length, color: "var(--red)"   },
            { label: "Passing",  val: passed,               color: "var(--green)" },
            { label: "Failing",  val: failed,               color: "var(--red)"   },
            ...(apiTests.length > 0 ? [
              { label: "UI Tests",  val: uiTests.length,  color: "#7c3aed" },
              { label: "API Tests", val: apiTests.length,  color: "#2563eb" },
            ] : []),
          ].map((s, i) => (
            <div key={i}>
              <div className="pd-stat-value" style={{ color: s.color }}>{s.val}</div>
              <div className="pd-stat-label">{s.label}</div>
            </div>
          ))}
          {approvedTests.length > 0 && (() => {
            const pct = Math.round((passed / approvedTests.length) * 100);
            return (
              <div style={{ marginLeft: "auto", alignSelf: "center" }}>
                <div className="progress-bar progress-bar-green" style={{ width: 140 }}>
                  <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="pd-stat-label" style={{ marginTop: 4, textAlign: "right" }}>
                  {pct}% passing
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

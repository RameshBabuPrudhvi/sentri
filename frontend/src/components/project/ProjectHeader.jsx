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
  Play, RefreshCw, Globe, Download, ChevronDown, Sparkles, ArrowRight, Zap, Clock,
} from "lucide-react";
import { PARALLEL_WORKERS_TUNING } from "../../config/testDialsConfig.js";
import { api } from "../../api.js";
import { fmtFutureRelative } from "../../utils/formatters.js";

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
  const [showExportMenu, setShowExportMenu] = useState(false);
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
          </div>
        </div>
        <div className="pd-header-actions">
          {/* ── Row 1: Generate link + workers + Run button ── */}
          <div className="pd-header-row">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate(`/automation?project=${projectId}`)}
              style={{ gap: 6 }}
            >
              <Zap size={13} />
              Automation
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
            {totalTests > 0 && (
              <div style={{ position: "relative" }}>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => setShowExportMenu(v => !v)}
                  style={{ gap: 4 }}
                >
                  <Download size={11} /> Export <ChevronDown size={10} />
                </button>
                {showExportMenu && (
                  <>
                    <div className="pd-popover-backdrop" onClick={() => setShowExportMenu(false)} />
                    <div className="pd-dropdown" style={{ top: "calc(100% + 4px)", right: 0 }}>
                      <div className="pd-dropdown-heading">
                        Export all {totalTests} tests
                      </div>
                      {[
                        { label: "Zephyr Scale CSV", desc: "Zephyr Scale / Zephyr Squad import", format: "zephyr" },
                        { label: "TestRail CSV", desc: "TestRail bulk import", format: "testrail" },
                      ].map(fmt => (
                        <button key={fmt.label} onClick={() => { setShowExportMenu(false); api.downloadExport(projectId, fmt.format); }} className="pd-dropdown-item" style={{ background: "none", border: "none", width: "100%", textAlign: "left", cursor: "pointer" }}>
                          <div className="pd-dropdown-item-title">{fmt.label}</div>
                          <div className="pd-dropdown-item-desc">{fmt.desc}</div>
                        </button>
                      ))}
                      {/* DIF-006: Standalone Playwright project ZIP. Sits alongside
                          the CSV exports so users see all three export targets in
                          one list. The endpoint always filters to approved tests
                          server-side, so the desc line calls that out — drafts and
                          rejected tests are excluded regardless of which project
                          stat the dropdown was opened against. */}
                      <button
                        onClick={() => { setShowExportMenu(false); api.downloadPlaywrightExport(projectId); }}
                        className="pd-dropdown-item"
                        style={{ background: "none", border: "none", width: "100%", textAlign: "left", cursor: "pointer" }}
                      >
                        <div className="pd-dropdown-item-title">Playwright project ZIP</div>
                        <div className="pd-dropdown-item-desc">Runnable Playwright project (approved tests only)</div>
                      </button>
                      {approvedTests.length > 0 && (
                        <>
                          <hr className="divider" style={{ margin: "4px 0" }} />
                          <div className="pd-dropdown-heading">
                            Approved only ({approvedTests.length})
                          </div>
                          {[
                            { label: "Zephyr CSV (approved)", format: "zephyr" },
                            { label: "TestRail CSV (approved)", format: "testrail" },
                          ].map(fmt => (
                            <button key={fmt.label} onClick={() => { setShowExportMenu(false); api.downloadExport(projectId, fmt.format, "approved"); }}
                              className="pd-dropdown-item" style={{ background: "none", border: "none", width: "100%", textAlign: "left", cursor: "pointer", padding: "7px 12px", fontSize: "0.82rem" }}>
                              {fmt.label}
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
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

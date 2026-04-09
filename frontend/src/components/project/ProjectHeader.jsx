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

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Play, RefreshCw, Globe, Download, ChevronDown, Sparkles, ArrowRight,
} from "lucide-react";
import { PARALLEL_WORKERS_TUNING } from "../../config/testDialsConfig.js";
import { api } from "../../api.js";

/**
 * @param {Object} props
 * @param {Object} props.project - { name, url }
 * @param {string} props.projectId
 * @param {Object[]} props.tests - All tests for stat counts.
 * @param {number} props.parallelWorkers - Current parallel worker count.
 * @param {Function} props.onWorkersChange - Called with new worker count.
 * @param {string|null} props.actionLoading - "run" | null
 * @param {Function} props.onRun
 * @param {Object} props.stats - { draftTests, approvedTests, rejectedTests, apiTests, uiTests, passed, failed }
 */
export default function ProjectHeader({
  project, projectId, tests,
  parallelWorkers, onWorkersChange,
  actionLoading, onRun,
  stats,
}) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const navigate = useNavigate();

  const { draftTests, approvedTests, rejectedTests, apiTests, uiTests, passed, failed } = stats;

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
            {tests.length > 0 && (
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
                        Export all {tests.length} tests
                      </div>
                      {[
                        { label: "Zephyr Scale CSV", desc: "Zephyr Scale / Zephyr Squad import", url: api.exportZephyrUrl(projectId) },
                        { label: "TestRail CSV", desc: "TestRail bulk import", url: api.exportTestRailUrl(projectId) },
                      ].map(fmt => (
                        <a key={fmt.label} href={fmt.url} download onClick={() => setShowExportMenu(false)} className="pd-dropdown-item">
                          <div className="pd-dropdown-item-title">{fmt.label}</div>
                          <div className="pd-dropdown-item-desc">{fmt.desc}</div>
                        </a>
                      ))}
                      {approvedTests.length > 0 && (
                        <>
                          <hr className="divider" style={{ margin: "4px 0" }} />
                          <div className="pd-dropdown-heading">
                            Approved only ({approvedTests.length})
                          </div>
                          {[
                            { label: "Zephyr CSV (approved)", url: api.exportZephyrUrl(projectId, "approved") },
                            { label: "TestRail CSV (approved)", url: api.exportTestRailUrl(projectId, "approved") },
                          ].map(fmt => (
                            <a key={fmt.label} href={fmt.url} download onClick={() => setShowExportMenu(false)}
                              className="pd-dropdown-item" style={{ padding: "7px 12px", fontSize: "0.82rem" }}>
                              {fmt.label}
                            </a>
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

      {tests.length > 0 && (
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

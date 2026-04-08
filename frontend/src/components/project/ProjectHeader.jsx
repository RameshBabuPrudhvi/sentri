/**
 * @module components/project/ProjectHeader
 * @description Project header card with name, URL, stats, mode selector,
 * crawl/run buttons, dials popover, and export dropdown.
 *
 * Extracted from ProjectDetail.jsx to reduce page-level complexity.
 */

import React, { useState } from "react";
import {
  Search, Play, RefreshCw, Globe, Download, ChevronDown,
} from "lucide-react";
import CrawlDialsPanel from "../CrawlDialsPanel.jsx";
import { countActiveDials } from "../../utils/testDialsStorage.js";
import { EXPLORE_MODE_OPTIONS, PARALLEL_WORKERS_TUNING } from "../../config/testDialsConfig.js";
import { api } from "../../api.js";

/**
 * @param {Object} props
 * @param {Object} props.project - { name, url }
 * @param {string} props.projectId
 * @param {Object[]} props.tests - All tests for stat counts.
 * @param {Object} props.crawlDialsCfg
 * @param {Function} props.onCrawlDialsChange
 * @param {string|null} props.actionLoading - "crawl" | "run" | null
 * @param {Function} props.onCrawl
 * @param {Function} props.onRun
 * @param {Object} props.stats - { draftTests, approvedTests, rejectedTests, apiTests, uiTests, passed, failed }
 */
export default function ProjectHeader({
  project, projectId, tests,
  crawlDialsCfg, onCrawlDialsChange,
  actionLoading, onCrawl, onRun,
  stats,
}) {
  const [showDialsPopover, setShowDialsPopover] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const { draftTests, approvedTests, rejectedTests, apiTests, uiTests, passed, failed } = stats;

  return (
    <div className="card" style={{ padding: 24, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: "var(--accent-bg)", border: "1px solid rgba(91,110,245,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Globe size={20} color="var(--accent)" />
          </div>
          <div>
            <h1 style={{ fontWeight: 700, fontSize: "1.2rem", marginBottom: 2 }}>{project.name}</h1>
            <a href={project.url} target="_blank" rel="noreferrer" style={{ fontSize: "0.78rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>{project.url}</a>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-end" }}>
          {/* ── Row 1: Mode selector + Crawl button + Run button ── */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {/* Explore mode segmented control */}
            <div style={{
              display: "flex", borderRadius: "var(--radius)", overflow: "hidden",
              border: "1px solid var(--border)", flexShrink: 0,
            }}>
              {EXPLORE_MODE_OPTIONS.map(opt => {
                const active = (crawlDialsCfg?.exploreMode || "crawl") === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => onCrawlDialsChange(prev => ({ ...prev, exploreMode: opt.id }))}
                    style={{
                      padding: "5px 12px", border: "none", cursor: "pointer",
                      fontSize: "0.78rem", fontWeight: active ? 600 : 400,
                      background: active ? "var(--accent-bg)" : "var(--surface)",
                      color: active ? "var(--accent)" : "var(--text2)",
                      transition: "all 0.12s",
                      borderRight: opt.id === "crawl" ? "1px solid var(--border)" : "none",
                    }}
                    title={opt.desc}
                  >
                    {opt.id === "crawl" ? "🔗" : "⚡"} {opt.label}
                  </button>
                );
              })}
            </div>

            <button className="btn btn-ghost btn-sm" onClick={onCrawl} disabled={!!actionLoading}>
              {actionLoading === "crawl" ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}
              {tests.length > 0 ? "Re-Crawl" : "Crawl & Generate"}
            </button>
            {/* Parallel workers compact selector */}
            <div style={{
              display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
              padding: "3px 8px", borderRadius: "var(--radius)",
              border: "1px solid var(--border)", background: "var(--surface)",
              fontSize: "0.72rem", color: "var(--text2)",
            }} title={PARALLEL_WORKERS_TUNING.desc}>
              <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>⚡</span>
              <select
                value={crawlDialsCfg?.parallelWorkers ?? PARALLEL_WORKERS_TUNING.defaultVal}
                onChange={e => onCrawlDialsChange(prev => ({ ...prev, parallelWorkers: parseInt(e.target.value, 10) }))}
                style={{
                  background: "transparent", border: "none", color: "var(--accent)",
                  fontWeight: 700, fontSize: "0.78rem", cursor: "pointer",
                  fontFamily: "var(--font-mono)", padding: 0, outline: "none",
                }}
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

          {/* ── Row 2: Dials popover + Export dropdown ── */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setShowDialsPopover(v => !v)}
                style={{
                  gap: 5,
                  background: showDialsPopover ? "var(--accent-bg)" : undefined,
                  borderColor: showDialsPopover ? "var(--accent)" : undefined,
                }}
              >
                ⚙ Dials
                <span className="active-count-pill" style={{ fontSize: "0.65rem", padding: "1px 6px" }}>
                  {countActiveDials(crawlDialsCfg)}
                </span>
                <ChevronDown size={10} style={{ transform: showDialsPopover ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
              </button>
              {showDialsPopover && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setShowDialsPopover(false)} />
                  <div style={{
                    position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
                    width: 420, maxHeight: "70vh", overflowY: "auto",
                    background: "var(--surface)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-lg)", boxShadow: "0 12px 40px rgba(0,0,0,0.15)",
                    padding: 16,
                  }}>
                    <CrawlDialsPanel value={crawlDialsCfg} onChange={onCrawlDialsChange} />
                  </div>
                </>
              )}
            </div>

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
                    <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setShowExportMenu(false)} />
                    <div style={{
                      position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 100,
                      background: "var(--surface)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius)", boxShadow: "var(--shadow)",
                      minWidth: 220, padding: 4,
                    }}>
                      <div style={{ padding: "6px 12px", fontSize: "0.7rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        Export all {tests.length} tests
                      </div>
                      {[
                        { label: "Zephyr Scale CSV", desc: "Zephyr Scale / Zephyr Squad import", url: api.exportZephyrUrl(projectId) },
                        { label: "TestRail CSV", desc: "TestRail bulk import", url: api.exportTestRailUrl(projectId) },
                      ].map(fmt => (
                        <a key={fmt.label} href={fmt.url} download onClick={() => setShowExportMenu(false)}
                          style={{ display: "block", padding: "8px 12px", borderRadius: 6, textDecoration: "none", color: "var(--text)" }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--bg2)"}
                          onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          <div style={{ fontSize: "0.84rem", fontWeight: 500 }}>{fmt.label}</div>
                          <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 1 }}>{fmt.desc}</div>
                        </a>
                      ))}
                      {approvedTests.length > 0 && (
                        <>
                          <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                          <div style={{ padding: "6px 12px", fontSize: "0.7rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                            Approved only ({approvedTests.length})
                          </div>
                          {[
                            { label: "Zephyr CSV (approved)", url: api.exportZephyrUrl(projectId, "approved") },
                            { label: "TestRail CSV (approved)", url: api.exportTestRailUrl(projectId, "approved") },
                          ].map(fmt => (
                            <a key={fmt.label} href={fmt.url} download onClick={() => setShowExportMenu(false)}
                              style={{ display: "block", padding: "7px 12px", borderRadius: 6, textDecoration: "none", color: "var(--text)", fontSize: "0.82rem" }}
                              onMouseEnter={e => e.currentTarget.style.background = "var(--bg2)"}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}>
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
        <div style={{ display: "flex", gap: 24, marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
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
              <div style={{ fontSize: "1.4rem", fontWeight: 700, color: s.color }}>{s.val}</div>
              <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
          {approvedTests.length > 0 && (() => {
            const pct = Math.round((passed / approvedTests.length) * 100);
            return (
              <div style={{ marginLeft: "auto", alignSelf: "center" }}>
                <div className="progress-bar progress-bar-green" style={{ width: 140 }}>
                  <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 4, textAlign: "right" }}>
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

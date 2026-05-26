/**
 * @module pages/Projects
 * @description Project listing page — shows all registered web applications
 * with test counts, pass rates, and quick actions. Renamed from
 * Applications.jsx to align with the sidebar label and route path.
 */

import React, { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, Globe, Search, ExternalLink, SquareCheckBig,
  RefreshCw, ChevronRight, Trash2, Pencil,
  LayoutGrid, List as ListIcon,
} from "lucide-react";
import useProjectData, { invalidateProjectDataCache } from "../hooks/useProjectData";
import { fmtRelativeDate } from "../utils/formatters";
import PassRateBar from "../components/charts/PassRateBar";
import DeleteProjectModal from "../components/shared/DeleteProjectModal.jsx";
import EmptyState from "../components/shared/EmptyState.jsx";
import { api } from "../api.js";
import usePageTitle from "../hooks/usePageTitle.js";
import { useAuth } from "../context/AuthContext.jsx";
import { userHasRole } from "../utils/roles.js";

function StatusDot({ status }) {
  const colors = {
    passed: "var(--green)", failed: "var(--red)",
    running: "var(--blue)", idle: "var(--text3)",
  };
  return (
    <span style={{
      width: 8, height: 8, borderRadius: "50%",
      background: colors[status] || colors.idle,
      display: "inline-block", flexShrink: 0,
      ...(status === "running" ? { animation: "pulse 1.5s infinite" } : {}),
    }} />
  );
}

export default function Projects() {
  usePageTitle("Projects");
  const { projects, allTests, allRuns, loading, refresh } = useProjectData();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null); // project to confirm-delete
  const [viewMode, setViewMode] = useState(() => {
    try {
      const v = localStorage.getItem("projects.viewMode");
      return v === "list" || v === "card" ? v : "list";
    } catch { return "list"; }
  });
  useEffect(() => {
    try { localStorage.setItem("projects.viewMode", viewMode); } catch { /* ignore */ }
  }, [viewMode]);
  const navigate = useNavigate();
  const { user } = useAuth();
  const canDelete = userHasRole(user, "qa_lead");
  const canEdit   = userHasRole(user, "qa_lead");

  // Derive per-project stats from the shared hook data
  const projectStats = useMemo(() => {
    const statsMap = {};
    for (const p of projects) {
      const tests = allTests.filter(t => t.projectId === p.id);
      const runs  = allRuns.filter(r => r.projectId === p.id);
      const testRuns = runs.filter(r => r.type === "test_run");
      const lastRun = testRuns[0] || null;
      const completedRuns = testRuns.filter(r => r.status === "completed");
      const passRate = completedRuns.length
        ? Math.round(
            (completedRuns.reduce((s, r) => s + (r.passed || 0), 0) /
             completedRuns.reduce((s, r) => s + (r.total || 1), 0)) * 100
          )
        : null;
      statsMap[p.id] = {
        totalTests:   tests.length,
        approved:     tests.filter(t => t.reviewStatus === "approved").length,
        draft:        tests.filter(t => t.reviewStatus === "draft").length,
        passRate,
        lastRun,
        lastCrawl:    runs.filter(r => r.type === "crawl")[0] || null,
        activeRun:    testRuns.find(r => r.status === "running") || null,
      };
    }
    return statsMap;
  }, [projects, allTests, allRuns]);

  const filtered = projects.filter(p =>
    !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.url || "").toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return (
    <div className="page-container" style={{ maxWidth: 900 }}>
      {[80, ...Array(3).fill(130)].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 12 }} />
      ))}
    </div>
  );

  return (
    <div className="fade-in page-container" style={{ maxWidth: 900 }}>

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">
            Web applications configured for autonomous testing
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
          <Plus size={14} /> New Project
        </button>
      </div>

      {/* Search + view toggle */}
      {projects.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ position: "relative", flex: 1, maxWidth: 340 }}>
            <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
            <input
              className="input"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search projects..."
              style={{ paddingLeft: 28, height: 34, fontSize: "0.82rem" }}
            />
          </div>
          <div role="group" aria-label="View mode" style={{ display: "inline-flex", gap: 4 }}>
            <button
              type="button"
              className={`btn btn-sm ${viewMode === "list" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setViewMode("list")}
              aria-pressed={viewMode === "list"}
              title="List view"
            >
              <ListIcon size={13} />
            </button>
            <button
              type="button"
              className={`btn btn-sm ${viewMode === "card" ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setViewMode("card")}
              aria-pressed={viewMode === "card"}
              title="Card view"
            >
              <LayoutGrid size={13} />
            </button>
          </div>
        </div>
      )}

      {/* ONB-002 (audit): empty state via shared primitive. Two branches —
          first-run onboarding (no projects at all → primary CTA to
          /projects/new) vs filtered-to-nothing (offer a "Clear search"
          escape hatch so the user isn't stuck rewriting the query). */}
      {filtered.length === 0 && (
        projects.length === 0 ? (
          <EmptyState
            icon={<Globe size={32} color="var(--accent)" />}
            title="No projects yet"
            description="Add your first web app to start generating and running tests."
            action={{ label: "Add Project", onClick: () => navigate("/projects/new") }}
          />
        ) : (
          <EmptyState
            icon={<Search size={32} color="var(--text3)" />}
            title="No results"
            description={search ? `No projects match "${search}".` : "Try a different search."}
            action={{ label: "Clear search", onClick: () => setSearch(""), variant: "ghost" }}
          />
        )
      )}

      {/* Compact list view */}
      {filtered.length > 0 && viewMode === "list" && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.6fr) 110px minmax(140px, 1fr) 90px 160px",
              gap: 12,
              padding: "8px 14px",
              borderBottom: "1px solid var(--border)",
              fontSize: "0.7rem",
              color: "var(--text3)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              fontWeight: 600,
            }}
          >
            <div>Project</div>
            <div>Last Run</div>
            <div>Pass Rate</div>
            <div>Drafts</div>
            <div style={{ textAlign: "right" }}>Actions</div>
          </div>
          {filtered.map((p, idx) => {
            const s = projectStats[p.id] || {};
            const status = s.activeRun ? "running"
              : s.lastRun?.status === "completed" ? "passed"
              : s.lastRun?.status === "failed" ? "failed"
              : "idle";
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/projects/${p.id}`)}
                onKeyDown={e => { if (e.key === "Enter") navigate(`/projects/${p.id}`); }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1.6fr) 110px minmax(140px, 1fr) 90px 160px",
                  gap: 12,
                  padding: "10px 14px",
                  alignItems: "center",
                  borderBottom: idx === filtered.length - 1 ? "none" : "1px solid var(--border)",
                  cursor: "pointer",
                  transition: "background 0.12s",
                }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--bg2)"}
                onMouseLeave={e => e.currentTarget.style.background = ""}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <StatusDot status={status} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: "0.85rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.name}
                    </div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text3)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.url}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                  {fmtRelativeDate(s.lastRun?.startedAt, "Never")}
                </div>
                <div><PassRateBar rate={s.passRate} /></div>
                <div>
                  {s.draft > 0 ? (
                    <span className="badge" style={{ background: "var(--amber-bg, rgba(255,176,32,0.15))", color: "var(--amber)", fontSize: "0.72rem" }}>
                      {s.draft} draft
                    </span>
                  ) : (
                    <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>—</span>
                  )}
                </div>
                <div
                  style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center" }}
                  onClick={e => e.stopPropagation()}
                >
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost btn-sm"
                    title="Open URL"
                  >
                    <ExternalLink size={13} />
                  </a>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate(`/projects/${p.id}`)}
                    title="View tests"
                  >
                    <SquareCheckBig size={13} />
                  </button>
                  {canEdit && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => navigate(`/projects/new?edit=${p.id}`)}
                      title="Edit project"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {canDelete && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: "var(--text3)" }}
                      onClick={() => setDeleteTarget(p)}
                      title="Delete project"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Application cards */}
      {viewMode === "card" && (
      <div className="flex-col" style={{ gap: 10 }}>
        {filtered.map(p => {
          const s = projectStats[p.id] || {};
          const status = s.activeRun ? "running"
            : s.lastRun?.status === "completed" ? "passed"
            : s.lastRun?.status === "failed" ? "failed"
            : "idle";

          return (
            <div
              key={p.id}
              className="card"
              style={{ padding: "18px 22px", cursor: "pointer", transition: "box-shadow 0.15s" }}
              onClick={() => navigate(`/projects/${p.id}`)}
              onMouseEnter={e => e.currentTarget.style.boxShadow = "var(--shadow)"}
              onMouseLeave={e => e.currentTarget.style.boxShadow = ""}
            >
              <div className="proj-card-body" style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>

                {/* Icon */}
                <div className="icon-box icon-box-accent">
                  <Globe size={18} color="var(--accent)" />
                </div>

                {/* Main info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <StatusDot status={status} />
                    <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{p.name}</span>
                    {s.activeRun && (
                      <span className="badge badge-blue" style={{ gap: 4 }}>
                        <RefreshCw size={9} className="spin" /> Running
                      </span>
                    )}
                  </div>
                  <div className="proj-url" style={{ fontSize: "0.75rem", color: "var(--text3)", fontFamily: "var(--font-mono)", marginBottom: 12 }}>
                    {p.url}
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      style={{ color: "inherit", marginLeft: 4, verticalAlign: "middle", display: "inline-flex" }}
                    >
                      <ExternalLink size={10} />
                    </a>
                  </div>

                  {/* Stats row */}
                  <div className="proj-stats-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1.6fr", gap: 16 }}>
                    <div>
                      <div className="section-label" style={{ marginBottom: 3 }}>Tests</div>
                      <div style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--text)" }}>
                        {s.totalTests ?? 0}
                        {s.draft > 0 && (
                          <span style={{ fontSize: "0.72rem", color: "var(--amber)", fontWeight: 500, marginLeft: 5 }}>
                            {s.draft} draft
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="section-label" style={{ marginBottom: 3 }}>Approved</div>
                      <div style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--green)" }}>
                        {s.approved ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="section-label" style={{ marginBottom: 3 }}>Last Run</div>
                      <div style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
                        {fmtRelativeDate(s.lastRun?.startedAt, "Never")}
                      </div>
                    </div>
                    <div>
                      <div className="section-label" style={{ marginBottom: 5 }}>Pass Rate</div>
                      <PassRateBar rate={s.passRate} />
                    </div>
                  </div>
                </div>

                {/* Quick actions */}
                <div
                  className="proj-actions"
                  style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}
                  onClick={e => e.stopPropagation()}
                >
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate(`/projects/${p.id}`)}
                    title="View project"
                  >
                    <SquareCheckBig size={13} /> Tests
                  </button>
                  {canEdit && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate(`/projects/new?edit=${p.id}`)}
                    title="Edit project"
                  >
                    <Pencil size={13} />
                  </button>
                  )}
                  {canDelete && (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--text3)" }}
                    onClick={() => setDeleteTarget(p)}
                    title="Delete project"
                  >
                    <Trash2 size={13} />
                  </button>
                  )}
                  <ChevronRight size={16} color="var(--text3)" style={{ marginLeft: 4 }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <DeleteProjectModal
          project={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { invalidateProjectDataCache(); refresh(); }}
        />
      )}
    </div>
  );
}
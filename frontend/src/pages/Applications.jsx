import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, Globe, Search, ExternalLink,
  RefreshCw, FlaskConical, ChevronRight, Trash2,
} from "lucide-react";
import useProjectData, { invalidateProjectDataCache } from "../hooks/useProjectData";
import { fmtRelativeDate } from "../utils/formatters";
import PassRateBar from "../components/PassRateBar";
import DeleteProjectModal from "../components/DeleteProjectModal.jsx";
import { api } from "../api.js";
import usePageTitle from "../hooks/usePageTitle.js";

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
  const navigate = useNavigate();

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

      {/* Search */}
      {projects.length > 0 && (
        <div style={{ position: "relative", maxWidth: 340, marginBottom: 16 }}>
          <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
          <input
            className="input"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search projects..."
            style={{ paddingLeft: 28, height: 34, fontSize: "0.82rem" }}
          />
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="card empty-state">
          <Globe size={36} color="var(--text3)" style={{ marginBottom: 14 }} />
          <div className="empty-state-title">
            {projects.length === 0 ? "No projects yet" : "No results"}
          </div>
          <div className="empty-state-desc">
            {projects.length === 0
              ? "Add your first web app to start generating and running tests."
              : "Try a different search."}
          </div>
          {projects.length === 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
              <Plus size={13} /> Add Project
            </button>
          )}
        </div>
      )}

      {/* Application cards */}
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
                    <FlaskConical size={13} /> Tests
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--text3)" }}
                    onClick={() => setDeleteTarget(p)}
                    title="Delete project"
                  >
                    <Trash2 size={13} />
                  </button>
                  <ChevronRight size={16} color="var(--text3)" style={{ marginLeft: 4 }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

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

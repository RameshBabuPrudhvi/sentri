import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Play, RefreshCw,
  Globe, FlaskConical, Search, ArrowRight, Zap, X,
} from "lucide-react";
import useProjectData from "../hooks/useProjectData";
import { api } from "../api.js";
import { fmtRelativeDate, fmtDuration } from "../utils/formatters";
import StatusBadge from "../components/StatusBadge";

function TypeBadge({ type }) {
  if (type === "test_run") return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.78rem", color: "var(--accent)", fontWeight: 500 }}>
      <FlaskConical size={12} /> Test Run
    </div>
  );
  if (type === "crawl") return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.78rem", color: "var(--purple)", fontWeight: 500 }}>
      <Globe size={12} /> Crawl
    </div>
  );
  return <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>{type || "—"}</span>;
}

function ProgressBar({ passed, failed, total }) {
  if (!total) return <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>—</span>;
  const pct = Math.round((passed / total) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <div style={{ width: 60, height: 5, borderRadius: 3, background: "var(--bg3)", overflow: "hidden", flexShrink: 0 }}>
        <div style={{
          width: `${pct}%`, height: "100%", borderRadius: 3,
          background: pct === 100 ? "var(--green)" : pct >= 60 ? "var(--amber)" : "var(--red)",
        }} />
      </div>
      <span style={{ fontSize: "0.72rem", color: "var(--text2)", fontWeight: 500, whiteSpace: "nowrap" }}>
        {passed}/{total}
      </span>
    </div>
  );
}


// inline RunModal so Work page can start runs directly
function RunModal({ projects, onClose }) {
  const [projectId, setProjectId] = React.useState(projects[0]?.id || "");
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);
  const navigate = useNavigate();

  React.useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function handleRun() {
    if (!projectId) { setError("Please select a project."); return; }
    setError(null); setRunning(true);
    try {
      const { runId } = await api.runTests(projectId);
      onClose();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err.message || "Failed to start run.");
      setRunning(false);
    }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 999, backdropFilter: "blur(2px)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 1000, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", boxShadow: "0 20px 60px rgba(0,0,0,0.18)", width: "min(420px,95vw)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 22px 16px", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>Run Regression Tests</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 2, display: "flex" }}><X size={18} /></button>
        </div>
        <div style={{ padding: "20px 22px 24px" }}>
          <p style={{ fontSize: "0.82rem", color: "var(--text2)", marginTop: 0, marginBottom: 16, lineHeight: 1.6 }}>
            Select a project to run all approved tests in its regression suite.
          </p>
          <div style={{ marginBottom: 16 }}>
            <label>Project</label>
            <select className="input" value={projectId} onChange={e => setProjectId(e.target.value)} style={{ height: 38 }}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {error && <div style={{ background: "var(--red-bg)", color: "var(--red)", borderRadius: "var(--radius)", padding: "8px 12px", fontSize: "0.82rem", marginBottom: 16 }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={handleRun} disabled={running || !projectId}>
              {running ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
              {running ? "Starting…" : "Run Tests"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const STATUS_FILTERS = ["all", "running", "completed", "failed"];

export default function Work() {
  const { allRuns: runs, projects: allProjects, loading } = useProjectData({ fetchTests: false });
  const [filter, setFilter]   = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch]   = useState("");
  const [showRunModal, setShowRunModal] = useState(false);
  const navigate = useNavigate();

  const filtered = useMemo(() => runs.filter(r => {
    if (filter !== "all" && r.status !== filter) return false;
    if (typeFilter !== "all" && r.type !== typeFilter) return false;
    if (search.trim() && !(r.projectName || "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [runs, filter, typeFilter, search]);

  const stats = useMemo(() => ({
    total:     runs.length,
    running:   runs.filter(r => r.status === "running").length,
    completed: runs.filter(r => r.status === "completed").length,
    failed:    runs.filter(r => r.status === "failed").length,
  }), [runs]);

  if (loading) return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      {[56, 300, 400].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 14 }} />
      ))}
    </div>
  );

  return (
    <div className="fade-in" style={{ maxWidth: 1000, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: 3 }}>Work</h1>
          <p style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
            All crawl and test run activity across your projects
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowRunModal(true)}>
          <Play size={13} /> Run Tests
        </button>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
        {[
          { label: "Total Runs",  value: stats.total,     color: "var(--accent)", bg: "var(--accent-bg)" },
          { label: "Running",     value: stats.running,   color: "var(--blue)",   bg: "var(--blue-bg)"   },
          { label: "Completed",   value: stats.completed, color: "var(--green)",  bg: "var(--green-bg)"  },
          { label: "Failed",      value: stats.failed,    color: "var(--red)",    bg: "var(--red-bg)"    },
        ].map((s, i) => (
          <div key={i} className="card" style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9, background: s.bg,
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
              <span style={{ fontSize: "1.1rem", fontWeight: 700, color: s.color }}>{s.value}</span>
            </div>
            <span style={{ fontSize: "0.78rem", fontWeight: 500, color: "var(--text2)" }}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="card" style={{ padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: "1 1 200px", minWidth: 180 }}>
            <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
            <input
              className="input"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by project..."
              style={{ paddingLeft: 28, height: 32, fontSize: "0.82rem" }}
            />
          </div>

          {/* Status filter */}
          <div style={{ display: "flex", gap: 4, background: "var(--bg2)", padding: 3, borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
            {STATUS_FILTERS.map(f => (
              <button key={f} className="btn btn-xs" onClick={() => setFilter(f)} style={{
                background: filter === f ? "var(--surface)" : "transparent",
                color: filter === f ? "var(--text)" : "var(--text3)",
                border: filter === f ? "1px solid var(--border)" : "1px solid transparent",
                textTransform: "capitalize",
                boxShadow: filter === f ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
              }}>{f}</button>
            ))}
          </div>

          {/* Type filter */}
          <div style={{ display: "flex", gap: 4, background: "var(--bg2)", padding: 3, borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
            {[["all","All Types"],["test_run","Test Runs"],["crawl","Crawls"]].map(([t, label]) => (
              <button key={t} className="btn btn-xs" onClick={() => setTypeFilter(t)} style={{
                background: typeFilter === t ? "var(--surface)" : "transparent",
                color: typeFilter === t ? "var(--text)" : "var(--text3)",
                border: typeFilter === t ? "1px solid var(--border)" : "1px solid transparent",
                boxShadow: typeFilter === t ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
              }}>{label}</button>
            ))}
          </div>

          <span style={{ fontSize: "0.75rem", color: "var(--text3)", marginLeft: "auto" }}>
            {filtered.length} {filtered.length === 1 ? "run" : "runs"}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        {filtered.length === 0 ? (
          <div style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
            {runs.length === 0 ? (
              <>
                <Zap size={32} color="var(--text3)" style={{ marginBottom: 12 }} />
                <div style={{ fontWeight: 600, marginBottom: 6 }}>No runs yet</div>
                <div style={{ fontSize: "0.82rem", marginBottom: 20 }}>
                  Start by crawling a project to generate tests, then run them.
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
                  Create a Project
                </button>
              </>
            ) : (
              <div>No runs match your filters</div>
            )}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Project</th>
                <th>Type</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Duration</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(run => (
                <tr key={run.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/runs/${run.id}`)}>
                  <td>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text3)" }}>
                      {run.id.slice(0, 8)}…
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{run.projectName || "—"}</div>
                    {run.projectUrl && (
                      <div style={{ fontSize: "0.72rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                        {run.projectUrl.replace(/^https?:\/\//, "").slice(0, 28)}
                      </div>
                    )}
                  </td>
                  <td><TypeBadge type={run.type} /></td>
                  <td><StatusBadge status={run.status} /></td>
                  <td>
                    {run.type === "test_run"
                      ? <ProgressBar passed={run.passed || 0} failed={run.failed || 0} total={run.total || 0} />
                      : run.type === "crawl"
                        ? <span style={{ fontSize: "0.75rem", color: "var(--text2)" }}>{run.pagesFound ?? 0} pages</span>
                        : "—"}
                  </td>
                  <td>
                    <span style={{ fontSize: "0.8rem", color: "var(--text2)" }}>
                      {run.status === "running"
                        ? <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--blue)" }}>
                            <RefreshCw size={11} className="spin" /> Running…
                          </span>
                        : fmtDuration(run.startedAt, run.finishedAt)
                      }
                    </span>
                  </td>
                  <td>
                    <span style={{ fontSize: "0.8rem", color: "var(--text2)" }}>{fmtRelativeDate(run.startedAt)}</span>
                  </td>
                  <td><ArrowRight size={14} color="var(--text3)" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {showRunModal && (
        <RunModal projects={allProjects} onClose={() => setShowRunModal(false)} />
      )}
    </div>
  );
}
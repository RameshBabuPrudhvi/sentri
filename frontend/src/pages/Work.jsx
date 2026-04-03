import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Play, RefreshCw,
  Globe, FlaskConical, Search, ArrowRight, Zap, X,
  CheckCircle2, XCircle,
} from "lucide-react";
import useProjectData from "../hooks/useProjectData";
import { fmtRelativeDate, fmtDuration } from "../utils/formatters";
import StatusBadge from "../components/StatusBadge";
import RunRegressionModal from "../components/RunRegressionModal.jsx";

// ── Filter definitions (mirrors Tests.jsx icon-pill pattern) ──────────────────

const STATUS_FILTERS = [
  { key: "running",   tooltip: "Running",   activeColor: "#2563eb", activeBg: "rgba(37,99,235,0.12)",  icon: <RefreshCw    size={14} /> },
  { key: "completed", tooltip: "Completed", activeColor: "#16a34a", activeBg: "rgba(34,197,94,0.12)",  icon: <CheckCircle2 size={14} /> },
  { key: "failed",    tooltip: "Failed",    activeColor: "#dc2626", activeBg: "rgba(239,68,68,0.12)",  icon: <XCircle      size={14} /> },
];

const TYPE_FILTERS = [
  { key: "test_run",  tooltip: "Test Runs", activeColor: "var(--accent)", activeBg: "var(--accent-bg)",      icon: <FlaskConical size={14} /> },
  { key: "crawl",     tooltip: "Crawls",    activeColor: "#7c3aed",       activeBg: "rgba(124,58,237,0.1)",   icon: <Globe        size={14} /> },
  { key: "generate",  tooltip: "Generate",  activeColor: "#d97706",       activeBg: "rgba(217,119,6,0.1)",    icon: <Zap          size={14} /> },
];

// ── TypeBadge ─────────────────────────────────────────────────────────────────

function TypeBadge({ type }) {
  if (type === "test_run") return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.78rem", color: "var(--accent)", fontWeight: 500 }}>
      <FlaskConical size={12} /> Test Run
    </div>
  );
  if (type === "crawl") return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.78rem", color: "#7c3aed", fontWeight: 500 }}>
      <Globe size={12} /> Crawl
    </div>
  );
  if (type === "generate") return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.78rem", color: "#d97706", fontWeight: 500 }}>
      <Zap size={12} /> Generate
    </div>
  );
  return <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>{type || "—"}</span>;
}

// ── ProgressBar ───────────────────────────────────────────────────────────────

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

// ── Work Page ─────────────────────────────────────────────────────────────────

export default function Work() {
  const { allRuns: runs, projects: allProjects, loading } = useProjectData({ fetchTests: false });
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter]     = useState("all");
  const [search, setSearch]             = useState("");
  const [showRunModal, setShowRunModal] = useState(false);
  const navigate = useNavigate();

  // ── Counts for filter dots ────────────────────────────────────────────────
  const statusCounts = useMemo(() => ({
    running:   runs.filter(r => r.status === "running").length,
    completed: runs.filter(r => r.status === "completed").length,
    failed:    runs.filter(r => r.status === "failed").length,
  }), [runs]);

  const typeCounts = useMemo(() => ({
    test_run: runs.filter(r => r.type === "test_run").length,
    crawl:    runs.filter(r => r.type === "crawl").length,
    generate: runs.filter(r => r.type === "generate").length,
  }), [runs]);

  const filtered = useMemo(() => runs.filter(r => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (typeFilter   !== "all" && r.type   !== typeFilter)   return false;
    if (search.trim() && !(r.projectName || "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [runs, statusFilter, typeFilter, search]);

  const stats = useMemo(() => ({
    total:     runs.length,
    running:   statusCounts.running,
    completed: statusCounts.completed,
    failed:    statusCounts.failed,
  }), [runs, statusCounts]);

  const anyFilterActive = statusFilter !== "all" || typeFilter !== "all";

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
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: 3 }}>Runs</h1>
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

      {/* Table card */}
      <div className="card">

        {/* ── Toolbar ── */}
        <div style={{
          padding: "14px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          {/* Title + count */}
          <div style={{ fontWeight: 600, fontSize: "0.9rem", flex: "0 0 auto" }}>
            All Runs ({filtered.length})
          </div>

          {/* Search */}
          <div style={{ width: 220, flexShrink: 0, position: "relative" }}>
            <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
            <input
              className="input"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by project…"
              style={{ paddingLeft: 28, paddingRight: search ? 30 : 12, height: 32, fontSize: "0.82rem" }}
            />
            {search && (
              <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 0, display: "flex" }}>
                <X size={13} />
              </button>
            )}
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* ── Icon-only filter pill bar ── */}
          <div style={{
            display: "flex", alignItems: "center", gap: 1,
            background: "var(--bg2)", padding: "3px 4px",
            borderRadius: "var(--radius)", border: "1px solid var(--border)",
          }}>
            <span style={{ fontSize: "0.68rem", color: "var(--text3)", fontWeight: 600, padding: "0 6px 0 2px", userSelect: "none", letterSpacing: "0.02em" }}>
              Filters
            </span>

            {/* Status filter icons */}
            {STATUS_FILTERS.map(f => {
              const active = statusFilter === f.key;
              const count  = statusCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  title={`${f.tooltip} · ${count} run${count !== 1 ? "s" : ""} · click again to clear`}
                  onClick={() => setStatusFilter(active ? "all" : f.key)}
                  style={{
                    position: "relative",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 30, height: 28, borderRadius: 6, border: "none",
                    cursor: "pointer", transition: "background 0.12s, color 0.12s, box-shadow 0.12s",
                    background: active ? f.activeBg    : "transparent",
                    color:      active ? f.activeColor : "var(--text3)",
                    boxShadow:  active ? `0 0 0 1.5px ${f.activeColor}55` : "none",
                  }}
                >
                  {f.icon}
                  {active && (
                    <span style={{
                      position: "absolute", top: 2, right: 2,
                      minWidth: 14, height: 14, borderRadius: 7,
                      background: f.activeColor, color: "#fff",
                      fontSize: "0.55rem", fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      lineHeight: 1, padding: "0 2px",
                    }}>
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Divider */}
            <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 3px", flexShrink: 0 }} />

            {/* Type filter icons */}
            {TYPE_FILTERS.map(f => {
              const active = typeFilter === f.key;
              const count  = typeCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  title={`${f.tooltip} · ${count} run${count !== 1 ? "s" : ""} · click again to clear`}
                  onClick={() => setTypeFilter(active ? "all" : f.key)}
                  style={{
                    position: "relative",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 30, height: 28, borderRadius: 6, border: "none",
                    cursor: "pointer", transition: "background 0.12s, color 0.12s, box-shadow 0.12s",
                    background: active ? f.activeBg    : "transparent",
                    color:      active ? f.activeColor : "var(--text3)",
                    boxShadow:  active ? `0 0 0 1.5px ${f.activeColor}55` : "none",
                  }}
                >
                  {f.icon}
                  {active && (
                    <span style={{
                      position: "absolute", top: 2, right: 2,
                      minWidth: 14, height: 14, borderRadius: 7,
                      background: f.activeColor, color: "#fff",
                      fontSize: "0.55rem", fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      lineHeight: 1, padding: "0 2px",
                    }}>
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Clear-all — only visible when any filter is active */}
            {anyFilterActive && (
              <>
                <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 3px", flexShrink: 0 }} />
                <button
                  title="Clear all filters"
                  onClick={() => { setStatusFilter("all"); setTypeFilter("all"); }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 28, height: 28, borderRadius: 6, border: "none",
                    cursor: "pointer", background: "rgba(239,68,68,0.08)", color: "var(--red)",
                    transition: "background 0.12s",
                  }}
                >
                  <X size={12} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Table ── */}
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
        <RunRegressionModal projects={allProjects} onClose={() => setShowRunModal(false)} />
      )}
    </div>
  );
}
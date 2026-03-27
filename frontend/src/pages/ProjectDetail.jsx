import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Globe, Play, Search, Trash2, ArrowRight, Clock, CheckCircle, XCircle, AlertTriangle, RefreshCw, Eye } from "lucide-react";
import { api } from "../api.js";

function statusBadge(s) {
  if (!s) return <span className="badge badge-gray">Not run</span>;
  if (s === "passed") return <span className="badge badge-green"><CheckCircle size={10} /> Passed</span>;
  if (s === "failed") return <span className="badge badge-red"><XCircle size={10} /> Failed</span>;
  if (s === "warning") return <span className="badge badge-amber"><AlertTriangle size={10} /> Warning</span>;
  return <span className="badge badge-gray">{s}</span>;
}

function priorityBadge(p) {
  const colors = { high: "badge-red", medium: "badge-amber", low: "badge-gray" };
  return <span className={`badge ${colors[p] || "badge-gray"}`}>{p}</span>;
}

function RunStatusBadge({ status }) {
  if (status === "running") return <span className="badge badge-blue pulse">● Running</span>;
  if (status === "completed") return <span className="badge badge-green">✓ Completed</span>;
  if (status === "failed") return <span className="badge badge-red">✗ Failed</span>;
  return <span className="badge badge-gray">{status}</span>;
}

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [project, setProject] = useState(null);
  const [tests, setTests] = useState([]);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [tab, setTab] = useState("tests");
  const [headed, setHeaded] = useState(false);

  const refresh = useCallback(async () => {
    const [p, t, r] = await Promise.all([
      api.getProject(id),
      api.getTests(id),
      api.getRuns(id),
    ]);
    setProject(p);
    setTests(t);
    setRuns(r);
  }, [id]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // Poll active run
  useEffect(() => {
    if (!activeRun) return;
    const timer = setInterval(async () => {
      const run = await api.getRun(activeRun).catch(() => null);
      if (!run) return;
      if (run.status !== "running") {
        setActiveRun(null);
        refresh();
        clearInterval(timer);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [activeRun, refresh]);

  async function doCrawl() {
    setActionLoading("crawl");
    try {
      const { runId } = await api.crawl(id);
      setActiveRun(runId);
      setTab("runs");
    } catch (err) { alert(err.message); }
    finally { setActionLoading(null); }
  }

  async function doRun() {
    setActionLoading("run");
    try {
      const { runId } = await api.runTests(id, { headed });
      setActiveRun(runId);
      setTab("runs");
    } catch (err) { alert(err.message); }
    finally { setActionLoading(null); }
  }

  async function deleteTest(testId) {
    if (!confirm("Delete this test?")) return;
    await api.deleteTest(id, testId);
    setTests((prev) => prev.filter((t) => t.id !== testId));
  }

  if (loading) return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div className="skeleton" style={{ height: 100, borderRadius: 16, marginBottom: 16 }} />
      <div className="skeleton" style={{ height: 400, borderRadius: 16 }} />
    </div>
  );

  if (!project) return <div>Project not found</div>;

  const passCount = tests.filter((t) => t.lastResult === "passed").length;
  const failCount = tests.filter((t) => t.lastResult === "failed").length;

  return (
    <div className="fade-in" style={{ maxWidth: 960, margin: "0 auto" }}>
      {/* Header */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 42, height: 42, background: "rgba(0,229,255,0.1)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(0,229,255,0.15)", flexShrink: 0 }}>
              <Globe size={20} color="var(--accent)" />
            </div>
            <div>
              <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.4rem" }}>{project.name}</h1>
              <a href={project.url} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "0.78rem", color: "var(--text3)" }}>{project.url}</a>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn btn-ghost" onClick={doCrawl} disabled={!!actionLoading}>
              {actionLoading === "crawl" ? <RefreshCw size={15} className="spin" /> : <Search size={15} />}
              {tests.length > 0 ? "Re-Crawl" : "Crawl & Generate Tests"}
            </button>
            <label
              style={{
                display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                padding: "6px 12px", borderRadius: "var(--radius)",
                background: headed ? "rgba(0,229,255,0.1)" : "transparent",
                border: `1px solid ${headed ? "rgba(0,229,255,0.3)" : "var(--border)"}`,
                fontSize: "0.8rem", fontFamily: "var(--font-display)", fontWeight: 600,
                color: headed ? "var(--accent)" : "var(--text2)",
                transition: "all 0.15s ease",
                userSelect: "none",
              }}
            >
              <Eye size={14} />
              <span>Watch Live</span>
              <input
                type="checkbox"
                checked={headed}
                onChange={(e) => setHeaded(e.target.checked)}
                style={{ accentColor: "var(--accent)", marginLeft: 2 }}
              />
            </label>
            <button className="btn btn-primary" onClick={doRun} disabled={!!actionLoading || tests.length === 0}>
              {actionLoading === "run" ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}
              Run Tests
            </button>
          </div>
        </div>

        {tests.length > 0 && (
          <div style={{ display: "flex", gap: 24, marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
            <Stat label="Tests" value={tests.length} />
            <Stat label="Passed" value={passCount} color="var(--green)" />
            <Stat label="Failed" value={failCount} color="var(--red)" />
            <Stat label="Not run" value={tests.length - passCount - failCount} color="var(--text3)" />
          </div>
        )}
      </div>

      {/* Active run indicator */}
      {activeRun && (
        <div style={{ padding: "14px 20px", background: "rgba(0,229,255,0.05)", border: "1px solid rgba(0,229,255,0.15)", borderRadius: "var(--radius)", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <RefreshCw size={15} color="var(--accent)" className="spin" />
            <span style={{ color: "var(--accent)", fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "0.875rem" }}>Run in progress…</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/runs/${activeRun}`)}>
            View Live <ArrowRight size={13} />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "var(--surface)", borderRadius: "var(--radius)", padding: 4, width: "fit-content", border: "1px solid var(--border)" }}>
        {[["tests", `Tests (${tests.length})`], ["runs", `Runs (${runs.length})`]].map(([key, label]) => (
          <button key={key} className="btn" onClick={() => setTab(key)} style={{
            background: tab === key ? "var(--bg3)" : "transparent",
            color: tab === key ? "var(--text)" : "var(--text2)",
            border: tab === key ? "1px solid var(--border2)" : "1px solid transparent",
            padding: "6px 16px", fontSize: "0.83rem",
          }}>{label}</button>
        ))}
      </div>

      {/* Tests Tab */}
      {tab === "tests" && (
        <div className="card">
          {tests.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: "var(--text2)" }}>
              <Search size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, marginBottom: 8 }}>No tests generated yet</div>
              <div style={{ fontSize: "0.875rem" }}>Click "Crawl & Generate Tests" to get started</div>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Test Name", "Page", "Type", "Priority", "Last Result", ""].map((h, i) => (
                    <th key={i} style={{ textAlign: "left", padding: "8px 12px", fontSize: "0.7rem", fontFamily: "var(--font-display)", color: "var(--text3)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tests.map((t) => (
                  <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "12px" }}>
                      <div style={{ fontWeight: 600, fontFamily: "var(--font-display)", fontSize: "0.875rem" }}>{t.name}</div>
                      <div style={{ color: "var(--text3)", fontSize: "0.75rem", marginTop: 2 }}>{t.description?.slice(0, 60)}…</div>
                    </td>
                    <td style={{ padding: "12px", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text3)", maxWidth: 200 }}>
                      <div className="truncate">{t.sourceUrl?.replace(/^https?:\/\//, "")}</div>
                    </td>
                    <td style={{ padding: "12px" }}><span className="badge badge-blue">{t.type}</span></td>
                    <td style={{ padding: "12px" }}>{priorityBadge(t.priority)}</td>
                    <td style={{ padding: "12px" }}>{statusBadge(t.lastResult)}</td>
                    <td style={{ padding: "12px" }}>
                      <button className="btn btn-danger btn-sm" onClick={() => deleteTest(t.id)}><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Runs Tab */}
      {tab === "runs" && (
        <div className="card">
          {runs.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: "var(--text2)" }}>
              <Play size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, marginBottom: 8 }}>No runs yet</div>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Run ID", "Type", "Status", "Passed", "Failed", "Started", ""].map((h, i) => (
                    <th key={i} style={{ textAlign: "left", padding: "8px 12px", fontSize: "0.7rem", fontFamily: "var(--font-display)", color: "var(--text3)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "12px", fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text3)" }}>{r.id.slice(0, 8)}…</td>
                    <td style={{ padding: "12px" }}><span className="badge badge-gray">{r.type}</span></td>
                    <td style={{ padding: "12px" }}><RunStatusBadge status={r.status} /></td>
                    <td style={{ padding: "12px", color: "var(--green)", fontWeight: 700, fontFamily: "var(--font-display)" }}>{r.passed ?? (r.type === "crawl" ? r.pagesFound : "—")}</td>
                    <td style={{ padding: "12px", color: "var(--red)", fontWeight: 700, fontFamily: "var(--font-display)" }}>{r.failed ?? "—"}</td>
                    <td style={{ padding: "12px", color: "var(--text2)", fontSize: "0.82rem" }}>{new Date(r.startedAt).toLocaleString()}</td>
                    <td style={{ padding: "12px" }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/runs/${r.id}`)}>
                        <ArrowRight size={13} /> View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color = "var(--text)" }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.5rem", color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

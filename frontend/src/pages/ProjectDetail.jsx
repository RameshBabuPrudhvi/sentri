import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Search, Play, Trash2, ArrowRight, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Globe, Clock } from "lucide-react";
import { api } from "../api.js";

function StatusDot({ s }) {
  if (s === "passed")    return <CheckCircle2 size={14} color="var(--green)" />;
  if (s === "failed")    return <XCircle size={14} color="var(--red)" />;
  if (s === "warning")   return <AlertTriangle size={14} color="var(--amber)" />;
  return <Clock size={14} color="var(--text3)" />;
}

function StatusBadge({ s }) {
  if (!s) return <span className="badge badge-gray">Not run</span>;
  if (s === "passed")  return <span className="badge badge-green"><CheckCircle2 size={10} /> Passing</span>;
  if (s === "failed")  return <span className="badge badge-red"><XCircle size={10} /> Failing</span>;
  if (s === "running") return <span className="badge badge-blue pulse">● Running</span>;
  if (s === "completed") return <span className="badge badge-green">✓ Completed</span>;
  return <span className="badge badge-gray">{s}</span>;
}

function AgentTag({ type = "TA" }) {
  const s = { QA: "avatar-qa", TA: "avatar-ta", EX: "avatar-ex" };
  return <div className={`avatar ${s[type] || "avatar-ta"}`}>{type}</div>;
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
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    const [p, t, r] = await Promise.all([api.getProject(id), api.getTests(id), api.getRuns(id)]);
    setProject(p); setTests(t); setRuns(r);
  }, [id]);

  useEffect(() => { refresh().finally(() => setLoading(false)); }, [refresh]);

  useEffect(() => {
    if (!activeRun) return;
    const timer = setInterval(async () => {
      const run = await api.getRun(activeRun).catch(() => null);
      if (!run || run.status !== "running") { setActiveRun(null); refresh(); clearInterval(timer); }
    }, 2000);
    return () => clearInterval(timer);
  }, [activeRun, refresh]);

  async function doCrawl() {
    setActionLoading("crawl");
    try { const { runId } = await api.crawl(id); setActiveRun(runId); setTab("runs"); }
    catch (err) { alert(err.message); }
    finally { setActionLoading(null); }
  }

  async function doRun() {
    setActionLoading("run");
    try { const { runId } = await api.runTests(id); setActiveRun(runId); setTab("runs"); }
    catch (err) { alert(err.message); }
    finally { setActionLoading(null); }
  }

  const filteredTests = tests.filter(t =>
    !search || t.name?.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      {[80, 400].map((h, i) => <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 16 }} />)}
    </div>
  );
  if (!project) return <div>Not found</div>;

  const passed = tests.filter(t => t.lastResult === "passed").length;
  const failed = tests.filter(t => t.lastResult === "failed").length;

  return (
    <div className="fade-in" style={{ maxWidth: 960, margin: "0 auto" }}>
      {/* Project header */}
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-ghost btn-sm" onClick={doCrawl} disabled={!!actionLoading}>
              {actionLoading === "crawl" ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}
              {tests.length > 0 ? "Re-Crawl" : "Crawl & Generate Tests"}
            </button>
            <button className="btn btn-primary btn-sm" onClick={doRun} disabled={!!actionLoading || tests.length === 0}>
              {actionLoading === "run" ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
              Run Tests
            </button>
          </div>
        </div>
        {tests.length > 0 && (
          <div style={{ display: "flex", gap: 24, marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            {[
              { label: "Total Tests", val: tests.length, color: "var(--text)" },
              { label: "Passing",     val: passed,       color: "var(--green)" },
              { label: "Failing",     val: failed,       color: "var(--red)" },
              { label: "Not Run",     val: tests.length - passed - failed, color: "var(--text3)" },
            ].map((s, i) => (
              <div key={i}>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, color: s.color }}>{s.val}</div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
            <div style={{ marginLeft: "auto", alignSelf: "center" }}>
              <div className="progress-bar progress-bar-green" style={{ width: 160 }}>
                <div className="progress-bar-fill" style={{ width: `${tests.length ? Math.round(passed / tests.length * 100) : 0}%` }} />
              </div>
              <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 4, textAlign: "right" }}>
                {tests.length ? Math.round(passed / tests.length * 100) : 0}% passing
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Active run banner */}
      {activeRun && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "var(--blue-bg)", border: "1px solid #bfdbfe", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <RefreshCw size={14} color="var(--blue)" className="spin" />
            <span style={{ fontWeight: 500, fontSize: "0.875rem", color: "var(--blue)" }}>Run in progress…</span>
          </div>
          <button className="btn btn-ghost btn-xs" onClick={() => navigate(`/runs/${activeRun}`)}>
            View live <ArrowRight size={12} />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 12, borderBottom: "1px solid var(--border)" }}>
        {[["tests", `Tests (${tests.length})`], ["runs", `Runs (${runs.length})`]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: "10px 18px", fontSize: "0.875rem", fontWeight: tab === key ? 600 : 400,
            color: tab === key ? "var(--accent)" : "var(--text2)",
            borderBottom: tab === key ? "2px solid var(--accent)" : "2px solid transparent",
            marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {/* Tests tab */}
      {tab === "tests" && (
        <div className="card">
          {tests.length > 0 && (
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ position: "relative" }}>
                <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
                <input className="input" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search tests..." style={{ paddingLeft: 28, height: 32, fontSize: "0.82rem" }} />
              </div>
            </div>
          )}
          {filteredTests.length === 0 ? (
            <div style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
              {tests.length === 0 ? "No tests yet — click Crawl to generate" : "No results"}
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Test Name</th>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Priority</th>
                  <th>Last Run</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredTests.map(t => (
                  <tr key={t.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <AgentTag type="TA" />
                        <div>
                          <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{t.name}</div>
                          {t.description && <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 1 }}>{t.description?.slice(0, 60)}</div>}
                          {t.isJourneyTest && <span className="badge badge-purple" style={{ marginTop: 4 }}>Journey</span>}
                        </div>
                      </div>
                    </td>
                    <td><StatusBadge s={t.lastResult} /></td>
                    <td><span className="badge badge-gray">{t.type || "—"}</span></td>
                    <td>
                      <span className={`badge ${t.priority === "high" ? "badge-red" : t.priority === "medium" ? "badge-amber" : "badge-gray"}`}>
                        {t.priority || "—"}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                        {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-xs" onClick={() => api.deleteTest(id, t.id).then(refresh)}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Runs tab */}
      {tab === "runs" && (
        <div className="card">
          {runs.length === 0 ? (
            <div style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>No runs yet</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Run ID</th><th>Type</th><th>Status</th><th>Passed</th><th>Failed</th><th>Started</th><th></th></tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/runs/${r.id}`)}>
                    <td><span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text3)" }}>{r.id.slice(0, 8)}…</span></td>
                    <td><span className="badge badge-gray">{r.type}</span></td>
                    <td><StatusBadge s={r.status} /></td>
                    <td><span style={{ color: "var(--green)", fontWeight: 600 }}>{r.passed ?? (r.type === "crawl" ? r.pagesFound : "—")}</span></td>
                    <td><span style={{ color: "var(--red)", fontWeight: 600 }}>{r.failed ?? "—"}</span></td>
                    <td><span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>{new Date(r.startedAt).toLocaleString()}</span></td>
                    <td><ArrowRight size={14} color="var(--text3)" /></td>
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

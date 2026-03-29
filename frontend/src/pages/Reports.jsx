import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import {
  CheckCircle2, XCircle, Clock, TrendingUp,
  AlertTriangle, Download, ChevronRight,
  BarChart2, FlaskConical,
} from "lucide-react";
import { api } from "../api";

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function StatCard({ label, value, sub, color = "var(--accent)", icon }) {
  return (
    <div className="card" style={{ padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: "0.72rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
        {icon && <span style={{ color, opacity: 0.7 }}>{icon}</span>}
      </div>
      <div style={{ fontSize: "1.9rem", fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function downloadCSV(runs, projectNames) {
  const header = ["Run ID","Project","Type","Status","Passed","Failed","Total","Started","Duration"];
  const rows = runs.map(r => {
    const dur = r.finishedAt && r.startedAt
      ? ((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000).toFixed(1) + "s"
      : "";
    return [
      r.id, projectNames[r.projectId] || r.projectId,
      r.type, r.status, r.passed ?? "", r.failed ?? "", r.total ?? "",
      r.startedAt ? new Date(r.startedAt).toISOString() : "", dur,
    ];
  });
  const csv = [header, ...rows].map(row => row.map(v => `"${v}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `sentri-runs-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>{p.name}: {p.value}</div>
      ))}
    </div>
  );
};

export default function Reports() {
  const [projects, setProjects] = useState([]);
  const [allRuns, setAllRuns]   = useState([]);
  const [allTests, setAllTests] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [selectedProject, setSelectedProject] = useState("all");
  const navigate = useNavigate();

  useEffect(() => {
    async function load() {
      try {
        const projs = await api.getProjects();
        setProjects(projs);
        const [runs, tests] = await Promise.all([
          Promise.all(projs.map(p =>
            api.getRuns(p.id)
              .then(rs => rs.map(r => ({ ...r, projectId: p.id })))
              .catch(() => [])
          )).then(r => r.flat()),
          Promise.all(projs.map(p =>
            api.getTests(p.id).catch(() => [])
          )).then(t => t.flat()),
        ]);
        setAllRuns(runs.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
        setAllTests(tests);
      } catch (err) {
        console.error("Reports load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const projMap = useMemo(() =>
    Object.fromEntries(projects.map(p => [p.id, p.name])), [projects]);

  const testRuns = useMemo(() =>
    allRuns.filter(r => r.type === "test_run"), [allRuns]);

  const filteredRuns = useMemo(() =>
    selectedProject === "all" ? testRuns : testRuns.filter(r => r.projectId === selectedProject),
  [testRuns, selectedProject]);

  // Trend chart — last 20 runs chronologically
  const trendData = useMemo(() =>
    [...filteredRuns].reverse().slice(-20).map((r, i) => ({
      name: `#${i + 1}`,
      passed: r.passed || 0,
      failed: r.failed || 0,
      total:  r.total  || 0,
      date: fmtDate(r.startedAt),
    })), [filteredRuns]);

  // Per-project breakdown
  const projectBreakdown = useMemo(() =>
    projects.map(p => {
      const runs = testRuns.filter(r => r.projectId === p.id && r.status === "completed");
      const tests = allTests.filter(t => t.projectId === p.id);
      const passed = runs.reduce((s, r) => s + (r.passed || 0), 0);
      const total  = runs.reduce((s, r) => s + (r.total  || 0), 0);
      const rate   = total ? Math.round((passed / total) * 100) : null;
      const lastRun = testRuns.filter(r => r.projectId === p.id)[0] || null;
      return { ...p, runs: runs.length, tests: tests.length, passRate: rate, lastRun };
    }), [projects, testRuns, allTests]);

  // Flaky tests: tests with both passed and failed results across runs
  const flakyTests = useMemo(() => {
    const testResults = {};
    testRuns.forEach(run => {
      (run.results || []).forEach(res => {
        if (!testResults[res.testId]) testResults[res.testId] = new Set();
        testResults[res.testId].add(res.status);
      });
    });
    return allTests
      .filter(t => {
        const statuses = testResults[t.id];
        return statuses && statuses.has("passed") && statuses.has("failed");
      })
      .slice(0, 8);
  }, [allTests, testRuns]);

  // Top failing tests
  const topFailing = useMemo(() => {
    const failCounts = {};
    testRuns.forEach(run => {
      (run.results || []).forEach(res => {
        if (res.status === "failed") {
          failCounts[res.testId] = (failCounts[res.testId] || 0) + 1;
        }
      });
    });
    return allTests
      .filter(t => failCounts[t.id])
      .sort((a, b) => failCounts[b.id] - failCounts[a.id])
      .slice(0, 6)
      .map(t => ({ ...t, failCount: failCounts[t.id] }));
  }, [allTests, testRuns]);

  // Overall stats
  const stats = useMemo(() => {
    const completed = filteredRuns.filter(r => r.status === "completed");
    const totalPassed = completed.reduce((s, r) => s + (r.passed || 0), 0);
    const totalTests  = completed.reduce((s, r) => s + (r.total  || 0), 0);
    return {
      totalRuns: filteredRuns.length,
      passRate:  totalTests ? Math.round((totalPassed / totalTests) * 100) : null,
      totalTests: allTests.length,
      flakyCount: flakyTests.length,
    };
  }, [filteredRuns, allTests, flakyTests]);

  if (loading) return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      {[60, 100, 300, 200].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 14 }} />
      ))}
    </div>
  );

  const hasData = testRuns.length > 0;

  return (
    <div className="fade-in" style={{ maxWidth: 960, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: 3 }}>Reports</h1>
          <p style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
            Test analytics, pass rate trends, and quality insights
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {projects.length > 1 && (
            <select
              className="input"
              value={selectedProject}
              onChange={e => setSelectedProject(e.target.value)}
              style={{ height: 32, fontSize: "0.82rem", width: "auto" }}
            >
              <option value="all">All Projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {hasData && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => downloadCSV(filteredRuns, projMap)}
            >
              <Download size={13} /> Export CSV
            </button>
          )}
        </div>
      </div>

      {/* No data state */}
      {!hasData ? (
        <div className="card" style={{ padding: "60px 40px", textAlign: "center" }}>
          <BarChart2 size={36} color="var(--text3)" style={{ marginBottom: 14 }} />
          <div style={{ fontWeight: 600, fontSize: "1.05rem", marginBottom: 6 }}>No test runs yet</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text2)", marginBottom: 20 }}>
            Run tests to start generating reports and analytics.
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects")}>
            Go to Tests
          </button>
        </div>
      ) : (
        <>
          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
            <StatCard
              label="Total Runs"
              value={stats.totalRuns}
              color="var(--accent)"
              icon={<FlaskConical size={16} />}
            />
            <StatCard
              label="Pass Rate"
              value={stats.passRate != null ? `${stats.passRate}%` : "—"}
              sub={stats.passRate >= 80 ? "Healthy" : stats.passRate != null ? "Needs attention" : "No data"}
              color={stats.passRate >= 80 ? "var(--green)" : stats.passRate != null ? "var(--amber)" : "var(--text3)"}
              icon={<TrendingUp size={16} />}
            />
            <StatCard
              label="Total Tests"
              value={stats.totalTests}
              color="var(--blue)"
              icon={<CheckCircle2 size={16} />}
            />
            <StatCard
              label="Flaky Tests"
              value={stats.flakyCount}
              sub={stats.flakyCount > 0 ? "Inconsistent results" : "None detected"}
              color={stats.flakyCount > 0 ? "var(--amber)" : "var(--green)"}
              icon={<AlertTriangle size={16} />}
            />
          </div>

          {/* Trend chart */}
          {trendData.length > 1 && (
            <div className="card" style={{ padding: 24, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>Pass / Fail Trend</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 2 }}>Last {trendData.length} runs</div>
                </div>
                <div style={{ display: "flex", gap: 14, fontSize: "0.75rem" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green)", display: "inline-block" }} />
                    Passed
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--red)", display: "inline-block" }} />
                    Failed
                  </span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={trendData}>
                  <defs>
                    <linearGradient id="rGp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#16a34a" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="rGf" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#dc2626" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--text3)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text3)" }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="passed" name="Passed" stroke="#16a34a" fill="url(#rGp)" strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" name="Failed" stroke="#dc2626" fill="url(#rGf)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Two column: project breakdown + flaky / top failing */}
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, marginBottom: 16 }}>

            {/* Project breakdown */}
            <div className="card" style={{ padding: 22 }}>
              <div style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: 16 }}>Per-Project Breakdown</div>
              {projectBreakdown.length === 0
                ? <div style={{ color: "var(--text3)", fontSize: "0.85rem" }}>No projects.</div>
                : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    {projectBreakdown.map((p, i) => (
                      <div
                        key={p.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 12,
                          padding: "11px 0",
                          borderBottom: i < projectBreakdown.length - 1 ? "1px solid var(--border)" : "none",
                          cursor: "pointer",
                        }}
                        onClick={() => navigate(`/projects/${p.id}`)}
                      >
                        <div style={{
                          width: 32, height: 32, borderRadius: 8, background: "var(--accent-bg)",
                          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        }}>
                          <FlaskConical size={14} color="var(--accent)" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, fontSize: "0.85rem", marginBottom: 2 }}>{p.name}</div>
                          <div style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                            {p.tests} tests · {p.runs} runs · last {fmtDateTime(p.lastRun?.startedAt) || "never"}
                          </div>
                        </div>
                        <div style={{ flexShrink: 0, minWidth: 80 }}>
                          {p.passRate != null ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <div style={{ width: 46, height: 4, borderRadius: 2, background: "var(--bg3)", overflow: "hidden" }}>
                                <div style={{
                                  width: `${p.passRate}%`, height: "100%", borderRadius: 2,
                                  background: p.passRate >= 80 ? "var(--green)" : p.passRate >= 50 ? "var(--amber)" : "var(--red)",
                                }} />
                              </div>
                              <span style={{
                                fontSize: "0.72rem", fontWeight: 600,
                                color: p.passRate >= 80 ? "var(--green)" : p.passRate >= 50 ? "var(--amber)" : "var(--red)",
                              }}>{p.passRate}%</span>
                            </div>
                          ) : (
                            <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>No runs</span>
                          )}
                        </div>
                        <ChevronRight size={13} color="var(--text3)" />
                      </div>
                    ))}
                  </div>
                )
              }
            </div>

            {/* Right column: flaky + top failing */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Flaky tests */}
              <div className="card" style={{ padding: 22 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 14 }}>
                  <AlertTriangle size={14} color="var(--amber)" />
                  <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Flaky Tests</span>
                  {flakyTests.length > 0 && (
                    <span className="badge badge-amber" style={{ marginLeft: "auto" }}>{flakyTests.length}</span>
                  )}
                </div>
                {flakyTests.length === 0 ? (
                  <div style={{ fontSize: "0.82rem", color: "var(--text3)", padding: "12px 0" }}>
                    <CheckCircle2 size={13} color="var(--green)" style={{ marginRight: 6, verticalAlign: "middle" }} />
                    No flaky tests detected
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {flakyTests.map(t => (
                      <div
                        key={t.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "4px 0" }}
                        onClick={() => navigate(`/tests/${t.id}`)}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--amber)", flexShrink: 0 }} />
                        <span style={{ fontSize: "0.8rem", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.name}
                        </span>
                        <ChevronRight size={11} color="var(--text3)" />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Top failing */}
              {topFailing.length > 0 && (
                <div className="card" style={{ padding: 22 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 14 }}>
                    <XCircle size={14} color="var(--red)" />
                    <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Top Failures</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {topFailing.map(t => (
                      <div
                        key={t.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "4px 0" }}
                        onClick={() => navigate(`/tests/${t.id}`)}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--red)", flexShrink: 0 }} />
                        <span style={{ fontSize: "0.8rem", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t.name}
                        </span>
                        <span className="badge badge-red" style={{ flexShrink: 0, fontSize: "0.68rem" }}>
                          {t.failCount}✗
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Run history table */}
          <div className="card">
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: "0.9rem" }}>
              Run History
              <span style={{ fontSize: "0.78rem", fontWeight: 400, color: "var(--text3)", marginLeft: 8 }}>
                {filteredRuns.length} runs
              </span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Passed</th>
                  <th>Failed</th>
                  <th>Total</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredRuns.slice(0, 50).map(run => {
                  const rate = run.total ? Math.round(((run.passed || 0) / run.total) * 100) : null;
                  return (
                    <tr key={run.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/runs/${run.id}`)}>
                      <td>
                        <span style={{ fontWeight: 500, fontSize: "0.85rem" }}>
                          {projMap[run.projectId] || "Unknown"}
                        </span>
                      </td>
                      <td>
                        {run.status === "completed"
                          ? <span className="badge badge-green"><CheckCircle2 size={9} /> Completed</span>
                          : run.status === "failed"
                          ? <span className="badge badge-red"><XCircle size={9} /> Failed</span>
                          : run.status === "running"
                          ? <span className="badge badge-blue pulse">● Running</span>
                          : <span className="badge badge-gray">{run.status}</span>}
                      </td>
                      <td><span style={{ color: "var(--green)", fontWeight: 600 }}>{run.passed ?? "—"}</span></td>
                      <td><span style={{ color: run.failed > 0 ? "var(--red)" : "var(--text3)", fontWeight: run.failed > 0 ? 600 : 400 }}>{run.failed ?? "—"}</span></td>
                      <td><span style={{ color: "var(--text2)" }}>{run.total ?? "—"}</span></td>
                      <td><span style={{ fontSize: "0.8rem", color: "var(--text2)" }}>{fmtDate(run.startedAt)}</span></td>
                      <td><ChevronRight size={13} color="var(--text3)" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
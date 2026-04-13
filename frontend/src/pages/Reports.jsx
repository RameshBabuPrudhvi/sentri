import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2, XCircle, TrendingUp,
  AlertTriangle, Download, ChevronRight,
  BarChart2, FlaskConical,
} from "lucide-react";
import useProjectData from "../hooks/useProjectData";
import { fmtShortDate, fmtRelativeDate, passRateColor } from "../utils/formatters";
import StatCard from "../components/shared/StatCard";
import StatusBadge from "../components/shared/StatusBadge";
import PassFailChart from "../components/charts/PassFailChart";
import PassRateBar from "../components/charts/PassRateBar";
import usePageTitle from "../hooks/usePageTitle.js";
import TablePagination, { PAGE_SIZE } from "../components/shared/TablePagination.jsx";

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

export default function Reports() {
  usePageTitle("Reports");
  const { projects, allTests, testRuns, projMap, loading } = useProjectData();
  const [selectedProject, setSelectedProject] = useState("all");
  const [runPage, setRunPage] = useState(1);
  const navigate = useNavigate();

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
      date: fmtShortDate(r.startedAt),
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
    <div className="page-container" style={{ maxWidth: 960 }}>
      {[60, 100, 300, 200].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 14 }} />
      ))}
    </div>
  );

  const hasData = testRuns.length > 0;

  return (
    <div className="fade-in page-container" style={{ maxWidth: 960 }}>

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-subtitle">
            Test analytics, pass rate trends, and quality insights
          </p>
        </div>
        {/* FIX: project filter and CSV export have independent visibility conditions */}
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
          {/* Disable export when no runs in current filter; show count */}
          {hasData && (
            <button
              className="btn btn-ghost btn-sm"
              disabled={filteredRuns.length === 0}
              title={filteredRuns.length === 0 ? "No runs to export for the current filter" : `Export ${filteredRuns.length} run${filteredRuns.length !== 1 ? "s" : ""} as CSV`}
              onClick={() => {
                downloadCSV(filteredRuns, projMap);
              }}
            >
              <Download size={13} /> Export CSV {filteredRuns.length > 0 && `(${filteredRuns.length})`}
            </button>
          )}
        </div>
      </div>

      {/* No data state */}
      {!hasData ? (
        <div className="card empty-state">
          <BarChart2 size={36} color="var(--text3)" style={{ marginBottom: 14 }} />
          <div className="empty-state-title">No test runs yet</div>
          <div className="empty-state-desc">
            Run tests to start generating reports and analytics.
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => navigate("/tests")}>
            Go to Tests
          </button>
        </div>
      ) : (
        <>
          {/* Stats row */}
          <div className="stat-grid" style={{ marginBottom: 20 }}>
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
          <PassFailChart
            data={trendData}
            height={160}
            idPrefix="rpt"
            title="Pass / Fail Trend"
            subtitle={`Last ${trendData.length} runs`}
          />

          {/* Two column: project breakdown + flaky / top failing */}
          <div className="rpt-two-col" style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, marginBottom: 16 }}>

            {/* Project breakdown */}
            <div className="card" style={{ padding: 22 }}>
              <div className="section-title" style={{ marginBottom: 16 }}>Per-Project Breakdown</div>
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
                        <div className="icon-box-sm" style={{ background: "var(--accent-bg)" }}>
                          <FlaskConical size={14} color="var(--accent)" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, fontSize: "0.85rem", marginBottom: 2 }}>{p.name}</div>
                          <div style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                            {p.tests} tests · {p.runs} runs · last {fmtRelativeDate(p.lastRun?.startedAt, "never")}
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
            <div className="flex-col gap-lg">

              {/* Flaky tests */}
              <div className="card" style={{ padding: 22 }}>
                <div className="flex-between" style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <AlertTriangle size={14} color="var(--amber)" />
                    <span className="section-title" style={{ marginBottom: 0 }}>Flaky Tests</span>
                  </div>
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
                    <span className="section-title" style={{ marginBottom: 0 }}>Top Failures</span>
                  </div>
                  <div className="flex-col gap-sm">
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
          <div className="card rpt-table">
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
                {filteredRuns.slice((runPage - 1) * PAGE_SIZE, runPage * PAGE_SIZE).map(run => {
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
                      <td><span style={{ fontSize: "0.8rem", color: "var(--text2)" }}>{fmtRelativeDate(run.startedAt)}</span></td>
                      <td><ChevronRight size={13} color="var(--text3)" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <TablePagination
              total={filteredRuns.length}
              page={runPage}
              totalPages={Math.max(1, Math.ceil(filteredRuns.length / PAGE_SIZE))}
              onPageChange={setRunPage}
              label="runs"
            />
          </div>
        </>
      )}
    </div>
  );
}
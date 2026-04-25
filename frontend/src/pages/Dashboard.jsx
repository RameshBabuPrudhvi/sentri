import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, CheckCircle2, XCircle, Ban, TrendingUp, AlertTriangle,
  FlaskConical, FileText, Wrench, Clock, Plus, Shield, Crosshair, Activity,
  Download, RefreshCw,
} from "lucide-react";
import { useDashboardQuery } from "../hooks/queries/useDashboardQuery.js";
import { fmtDurationMs } from "../utils/formatters.js";
import { generateExecutivePDF } from "../utils/pdfReportGenerator.js";
import AgentTag from "../components/shared/AgentTag.jsx";
import StatCard from "../components/shared/StatCard.jsx";
import PassFailChart from "../components/charts/PassFailChart.jsx";
import SparklineChart from "../components/charts/SparklineChart.jsx";
import StackedBar from "../components/charts/StackedBar.jsx";
import usePageTitle from "../hooks/usePageTitle.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const RUN_TYPE_META = {
  crawl:    { label: "Crawl & Generate", avatar: "QA" },
  generate: { label: "AI Generate",      avatar: "QA" },
  run:      { label: "Test Run",         avatar: "TA" },
  test_run: { label: "Test Run",         avatar: "TA" },
};

function RunningBadge() {
  return (
    <span className="badge badge-blue" style={{ gap: 5 }}>
      <span className="spin dash-spinner" />
      Running
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF Export button component
// (generateExecutivePDF is in frontend/src/utils/pdfReportGenerator.js)
// ─────────────────────────────────────────────────────────────────────────────
function ExportPDFButton() {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    if (loading) return;
    setLoading(true);
    try {
      await generateExecutivePDF();
    } catch (e) {
      console.error("PDF generation error", e);
    } finally {
      setTimeout(() => setLoading(false), 1500);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="btn btn-ghost btn-sm dash-export-btn"
      style={{
        opacity: loading ? 0.7 : 1,
        cursor: loading ? "not-allowed" : "pointer",
      }}
      title="Download executive PDF report"
    >
      {loading
        ? <RefreshCw size={13} className="spin" />
        : <Download size={13} />}
      {loading ? "Preparing…" : "Export PDF"}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
  usePageTitle("Dashboard");

  const dashboardQuery = useDashboardQuery();

  const data = dashboardQuery.data || null;
  const runs = (data?.recentRuns || []).slice(0, 8);
  const loading = dashboardQuery.isLoading;
  const loadError = dashboardQuery.isError;
  // Query failures are logged centrally by the QueryCache.onError handler
  // in queryClient.js — see [query] dashboard:summary entries in the console.

  const chartData = (data?.history || []).map((r, i) => ({ name: `#${i + 1}`, passed: r.passed, failed: r.failed }));
  const rbs = data?.runsByStatus || {};
  const tbr = data?.testsByReview || {};
  const dfb = data?.defectBreakdown || {};

  // ── Trend: compare last 5 runs vs prior 5 for ▲/▼ indicator ──
  const history = data?.history || [];
  const recentHalf = history.slice(-5);
  const priorHalf  = history.slice(-10, -5);
  const calcPct = (arr) => {
    const p = arr.reduce((s, r) => s + (r.passed || 0), 0);
    const t = arr.reduce((s, r) => s + (r.passed || 0) + (r.failed || 0), 0);
    return t > 0 ? Math.round((p / t) * 100) : null;
  };
  const recentPct = calcPct(recentHalf);
  const priorPct  = calcPct(priorHalf);
  const trendDelta = (recentPct !== null && priorPct !== null) ? recentPct - priorPct : null;
  const trendLabel = trendDelta === null ? null
    : trendDelta > 0 ? `▲ ${trendDelta}pp` : trendDelta < 0 ? `▼ ${Math.abs(trendDelta)}pp` : "— stable";

  // ── Today's failures from recent runs ──
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayRuns = (data?.recentRuns || []).filter(r =>
    r.startedAt && new Date(r.startedAt) >= todayStart && (r.type === "test_run" || r.type === "run")
  );
  const todayFailed = todayRuns.reduce((s, r) => s + (r.failed || 0), 0);
  const todayTotal  = todayRuns.reduce((s, r) => s + (r.total || 0), 0);

  if (loading) return (
    <div className="page-container">
      {[120, 200, 300].map((h, i) => <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 16 }} />)}
    </div>
  );

  const isEmpty = !loadError && !data?.totalProjects && !data?.totalTests && !data?.totalRuns;

  return (
    <div className="fade-in page-container">

      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="page-header" data-tour="tour-welcome">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            {" · "}System health, test metrics, and recent activity
          </p>
        </div>
        <ExportPDFButton />
      </div>

      {/* Error banner */}
      {loadError && (
        <div className="card empty-state mb-md" style={{ border: "1px solid #fca5a5" }}>
          <div className="empty-state-icon">⚠️</div>
          <div className="empty-state-title">Could not load dashboard data</div>
          <div className="empty-state-desc">The API may be temporarily unavailable. Your data is safe.</div>
          <button className="btn btn-ghost btn-sm" onClick={() => dashboardQuery.refetch()}>Retry</button>
        </div>
      )}

      {/* First-time onboarding */}
      {isEmpty ? (
        <div className="card empty-state mb-md">
          <div className="empty-state-icon">🚀</div>
          <div className="empty-state-title">Welcome to Sentri!</div>
          <div className="empty-state-desc">Create your first project to start crawling your web app and AI-generating tests automatically.</div>
          <button className="btn btn-primary" onClick={() => navigate("/projects/new")}>Create First Project</button>
        </div>
      ) : (
        <>
          {/* ── Row 1: Core Health KPIs ── */}
          <div className="stat-grid">
            <StatCard
              label="Pass Rate"
              value={data?.passRate != null ? `${data.passRate}%` : "—"}
              sub={trendLabel
                ? `${trendLabel} vs prior runs`
                : data?.passRate >= 80 ? "Healthy" : data?.passRate != null ? "Needs attention" : "No runs yet"}
              color={data?.passRate >= 80 ? "var(--green)" : data?.passRate != null ? "var(--amber)" : "var(--text3)"}
              icon={<TrendingUp size={16} />}
            />
            <StatCard label="Failures Today" value={todayFailed} sub={todayTotal > 0 ? `of ${todayTotal} assertions · ${todayRuns.length} run${todayRuns.length !== 1 ? "s" : ""}` : "No runs today"} color={todayFailed > 0 ? "var(--red)" : "var(--green)"} icon={<XCircle size={16} />} />
            <StatCard label="Total Tests" value={data?.totalTests ?? 0} sub={`${tbr.approved || 0} approved · ${tbr.draft || 0} draft`} color="var(--blue)" icon={<FlaskConical size={16} />} />
            <StatCard label="Total Runs" value={data?.totalRuns ?? 0} sub={`${rbs.completed || 0} passed · ${rbs.failed || 0} failed`} color="var(--purple)" icon={<FileText size={16} />} />
          </div>

          {/* ── Row 2: Duration / Created / Fixed / Healing ── */}
          <div className="stat-grid">
            <StatCard label="Avg Duration" value={fmtDurationMs(data?.avgRunDurationMs)} sub={data?.mttrMs ? `MTTR: ${fmtDurationMs(data.mttrMs)}` : "Per test run"} color="var(--accent)" icon={<Clock size={16} />} />
            <StatCard label="Created Today" value={data?.testsCreatedToday ?? 0} sub={`${data?.testsCreatedThisWeek ?? 0} this week · ${data?.testsGeneratedTotal ?? 0} total`} color="var(--blue)" icon={<Plus size={16} />} />
            <StatCard label="Auto-Fixed" value={data?.testsAutoFixed ?? 0} sub="By feedback loop" color="var(--green)" icon={<Wrench size={16} />} />
            <StatCard label="Self-Healed" value={data?.healingSuccesses ?? 0} sub={`${data?.healingEntries ?? 0} elements tracked`} color="var(--purple)" icon={<Shield size={16} />} />
          </div>

          {/* ── Row 3: Flaky Tests + Defect Breakdown ── */}
          {data?.totalRuns > 0 && (() => {
            const defectSegs = [
              { label: "Selector",   count: dfb.SELECTOR_ISSUE || 0,  color: "var(--purple)" },
              { label: "Navigation", count: dfb.NAVIGATION_FAIL || 0, color: "var(--blue)"   },
              { label: "Timeout",    count: dfb.TIMEOUT || 0,         color: "var(--amber)"  },
              { label: "Assertion",  count: dfb.ASSERTION_FAIL || 0,  color: "var(--red)"    },
              { label: "Other",      count: dfb.UNKNOWN || 0,         color: "#6b7280"       },
            ];
            const totalDefects = defectSegs.reduce((s, x) => s + x.count, 0);
            return (
              <div className="dash-defect-row">
                <StatCard label="Flaky Tests" value={data?.flakyTestCount ?? 0} sub={data?.flakyTestCount > 0 ? "Inconsistent results" : "None detected"} color={data?.flakyTestCount > 0 ? "var(--amber)" : "var(--green)"} icon={<AlertTriangle size={16} />} />
                <div className="card card-padded">
                  <div className="flex-between" style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Crosshair size={14} color="var(--text3)" />
                      <span className="section-title" style={{ marginBottom: 0 }}>Defect Categories</span>
                    </div>
                    {totalDefects > 0 && <span className="text-xs text-muted">{totalDefects} total failures</span>}
                  </div>
                  {totalDefects === 0 ? (
                    <div className="text-sm text-muted">
                      <CheckCircle2 size={13} color="var(--green)" style={{ marginRight: 6, verticalAlign: "middle" }} />No failures recorded
                    </div>
                  ) : (
                    <>
                      <div className="legend-row" style={{ gap: 14 }}>
                        {defectSegs.filter(s => s.count > 0).map(s => (
                          <div key={s.label} className="legend-item" style={{ gap: 5 }}>
                            <span className="legend-dot" style={{ background: s.color }} />
                            <span className="legend-label" style={{ fontSize: "0.78rem" }}>{s.label}</span>
                            <span className="legend-value" style={{ fontSize: "0.82rem", color: s.color }}>{s.count}</span>
                          </div>
                        ))}
                      </div>
                      <StackedBar segments={defectSegs} />
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ── Row 3b: Top Flaky Tests panel (DIF-004) ── */}
          {(data?.topFlakyTests?.length ?? 0) > 0 && (
            <div className="card card-padded mb-md">
              <div className="flex-between" style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <AlertTriangle size={14} color="var(--amber)" />
                  <span className="section-title" style={{ marginBottom: 0 }}>Top Flaky Tests</span>
                </div>
                <span className="text-xs text-muted">{data.topFlakyTests.length} test{data.topFlakyTests.length !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex-col gap-sm">
                {data.topFlakyTests.map(ft => (
                  <div
                    key={ft.testId}
                    className="list-row"
                    style={{ cursor: "pointer" }}
                    onClick={() => navigate(`/tests/${ft.testId}`)}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: "0.875rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {ft.name}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      <div style={{
                        width: 60, height: 6, background: "var(--bg3)", borderRadius: 99, overflow: "hidden",
                      }}>
                        <div style={{
                          height: "100%", width: `${ft.flakyScore}%`,
                          background: ft.flakyScore >= 40 ? "var(--red)" : "var(--amber)",
                          borderRadius: 99, transition: "width 0.4s ease",
                        }} />
                      </div>
                      <span style={{
                        fontSize: "0.75rem", fontWeight: 700, fontFamily: "var(--font-mono)",
                        color: ft.flakyScore >= 40 ? "var(--red)" : "var(--amber)",
                        minWidth: 32, textAlign: "right",
                      }}>
                        {ft.flakyScore}%
                      </span>
                      <ArrowRight size={14} color="var(--text3)" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Row 4: Run Status Distribution ── */}
          {data?.totalRuns > 0 && (() => {
            const segs = [
              { label: "Completed", count: rbs.completed || 0, color: "var(--green)", icon: <CheckCircle2 size={12} /> },
              { label: "Failed",    count: rbs.failed || 0,    color: "var(--red)",   icon: <XCircle size={12} /> },
              { label: "Aborted",   count: rbs.aborted || 0,   color: "#6b7280",      icon: <Ban size={12} /> },
              { label: "Running",   count: rbs.running || 0,   color: "var(--blue)",  icon: <Clock size={12} /> },
            ];
            return (
              <div className="card card-padded mb-md">
                <div className="section-title">Run Status Distribution</div>
                <div className="legend-row">
                  {segs.map(s => (
                    <div key={s.label} className="legend-item">
                      <span style={{ color: s.color, display: "flex" }}>{s.icon}</span>
                      <span className="legend-label">{s.label}</span>
                      <span className="legend-value" style={{ color: s.color }}>{s.count}</span>
                    </div>
                  ))}
                </div>
                <StackedBar segments={segs} />
              </div>
            );
          })()}

          {/* ── Row 5: Test Review Pipeline ── */}
          {data?.totalTests > 0 && (() => {
            const segs = [
              { label: "Approved", count: tbr.approved || 0, color: "var(--green)" },
              { label: "Draft",    count: tbr.draft || 0,    color: "var(--amber)" },
              { label: "Rejected", count: tbr.rejected || 0, color: "var(--red)"   },
            ];
            return (
              <div className="card card-padded mb-md">
                <div className="section-title">Test Review Pipeline</div>
                <div className="legend-row">
                  {segs.map(s => (
                    <div key={s.label} className="legend-item">
                      <span className="legend-dot" style={{ background: s.color }} />
                      <span className="legend-label">{s.label}</span>
                      <span className="legend-value" style={{ color: s.color }}>{s.count}</span>
                    </div>
                  ))}
                </div>
                <StackedBar segments={segs} />
              </div>
            );
          })()}

          {/* ── Row 6: Test Suite Growth ── */}
          {(data?.testGrowth?.length ?? 0) >= 2 && (
            <div className="card card-padded mb-md">
              <div className="flex-between" style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Activity size={14} color="var(--accent)" />
                  <span className="section-title" style={{ marginBottom: 0 }}>Test Suite Growth</span>
                </div>
                <span className="text-xs text-muted">Last 8 weeks</span>
              </div>
              <SparklineChart data={data.testGrowth.map(d => ({ name: d.week, value: d.count }))} height={64} color="var(--accent)" tooltipFn={d => `${d.name}: ${d.value} tests`} />
            </div>
          )}

          {/* ── Row 7: Pass / Fail Trend Chart ── */}
          <PassFailChart data={chartData} height={150} idPrefix="dash" title="Pass / Fail Trend" subtitle={`Last ${chartData.length} runs`} />

          {/* ── Row 8: Recent Activity ── */}
          {runs.length > 0 && (
            <div className="card card-padded">
              <div className="flex-between mb-md">
                <div>
                  <div className="section-title" style={{ marginBottom: 2 }}>Recent Activity</div>
                  <div className="page-subtitle" style={{ fontSize: "0.8rem" }}>
                    {runs.filter(r => r.status === "running").length > 0
                      ? `${runs.filter(r => r.status === "running").length} task(s) in progress`
                      : "Latest runs across all projects"}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate("/runs")}>View all</button>
              </div>
              <div className="flex-col gap-sm">
                {runs.map(r => {
                  const meta = RUN_TYPE_META[r.type] || RUN_TYPE_META["run"];
                  return (
                    <div key={r.id} className="list-row" onClick={() => navigate(`/runs/${r.id}`)}>
                      <AgentTag type={(RUN_TYPE_META[r.type] || RUN_TYPE_META["run"]).avatar} />
                      <div className="flex-1">
                        <div style={{ fontWeight: 500, fontSize: "0.875rem", marginBottom: 1 }}>{meta.label}</div>
                        <div className="page-subtitle truncate" style={{ fontSize: "0.78rem" }}>
                          {r.projectName || `Project ${r.projectId?.slice(0, 8)}`}
                        </div>
                      </div>
                      <div className="flex-center gap-sm shrink-0">
                        {r.status === "running" ? <RunningBadge />
                          : r.status === "completed" ? <span className="badge badge-green">✓ Completed</span>
                          : r.status === "aborted"   ? <span className="badge badge-gray">⊘ Aborted</span>
                          :                            <span className="badge badge-red">✗ Failed</span>}
                        <span className="dash-hero-date">
                          {new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <ArrowRight size={14} color="var(--text3)" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
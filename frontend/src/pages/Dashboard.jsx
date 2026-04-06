import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, CheckCircle2, XCircle, Ban, TrendingUp, AlertTriangle,
  FlaskConical, FileText, Wrench, Clock, Plus, Shield, Crosshair, Activity,
} from "lucide-react";
import { api } from "../api.js";
import { fmtDurationMs } from "../utils/formatters.js";
import AgentTag from "../components/AgentTag.jsx";
import StatCard from "../components/StatCard.jsx";
import PassFailChart from "../components/PassFailChart.jsx";
import SparklineChart from "../components/SparklineChart.jsx";
import StackedBar from "../components/StackedBar.jsx";
import AppLogo from "../components/AppLogo.jsx";
import usePageTitle from "../hooks/usePageTitle.js";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const RUN_TYPE_META = {
  crawl:    { label: "Crawl & Generate", avatar: "QA" },
  generate: { label: "AI Generate",      avatar: "QA" },
  run:      { label: "Test Run",         avatar: "TA" },
  test_run: { label: "Test Run",         avatar: "TA" },
};

function RunningBadge() {
  return (
    <span className="badge badge-blue" style={{ gap: 5 }}>
      <span className="spin" style={{ width: 8, height: 8, border: "1.5px solid #2563eb", borderTopColor: "transparent", borderRadius: "50%", display: "inline-block" }} />
      Running
    </span>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const navigate = useNavigate();
  usePageTitle("Dashboard");

  useEffect(() => {
    api.getDashboard()
      .then((d) => {
        setData(d);
        setRuns((d.recentRuns || []).slice(0, 8));
        setLoadError(false);
      })
      .catch((err) => {
        console.error("Dashboard load error:", err);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  const chartData = (data?.history || []).map((r, i) => ({ name: `#${i + 1}`, passed: r.passed, failed: r.failed }));
  const rbs = data?.runsByStatus || {};
  const tbr = data?.testsByReview || {};
  const dfb = data?.defectBreakdown || {};

  if (loading) return (
    <div className="page-container">
      {[120, 200, 300].map((h, i) => <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 16 }} />)}
    </div>
  );

  const isEmpty = !loadError && !data?.totalProjects && !data?.totalTests && !data?.totalRuns;

  return (
    <div className="fade-in page-container">

      {/* Logo Hero Banner */}
      <div style={{
        marginBottom: 32,
        padding: "28px 32px",
        borderRadius: 16,
        background: "linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(168,85,247,0.06) 100%)",
        border: "1px solid rgba(99,102,241,0.18)",
        position: "relative",
        overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "none",
          background: "radial-gradient(ellipse 60% 80% at 95% 50%, rgba(99,102,241,0.08) 0%, transparent 70%)",
        }} />
        <svg style={{ position: "absolute", right: 24, top: "50%", transform: "translateY(-50%)", opacity: 0.04, pointerEvents: "none" }} width="180" height="180" viewBox="0 0 40 40" fill="none">
          <path d="M20 1L3 8v11c0 9.5 7.2 18.2 17 20 9.8-1.8 17-10.5 17-20V8L20 1z" fill="#6366f1" />
        </svg>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative" }}>
          <div>
            <AppLogo size={48} variant="full" />
            <p style={{ marginTop: 12, color: "var(--text2)", fontSize: "0.875rem", maxWidth: 480, lineHeight: 1.6 }}>
              {greeting()}! Here's your real-time overview — system health, key metrics, and what your agents are up to right now.
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
            <span style={{
              fontSize: "0.7rem", fontWeight: 600, letterSpacing: "0.08em",
              textTransform: "uppercase", color: "#818cf8",
              background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)",
              borderRadius: 999, padding: "3px 10px",
            }}>
              Autonomous QA
            </span>
            <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
              {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            </span>
          </div>
        </div>
      </div>

      {/* Error banner when API fails — don't show misleading onboarding */}
      {loadError && (
        <div className="card" style={{ padding: "32px 40px", textAlign: "center", marginBottom: 16, border: "1px solid #fca5a5" }}>
          <div style={{ fontSize: "1.5rem", marginBottom: 10 }}>⚠️</div>
          <div style={{ fontWeight: 600, fontSize: "1rem", marginBottom: 6, color: "var(--text)" }}>Could not load dashboard data</div>
          <div style={{ color: "var(--text2)", fontSize: "0.85rem", marginBottom: 16 }}>
            The API may be temporarily unavailable. Your data is safe.
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      )}

      {/* Fix #8: first-time onboarding banner instead of zeros */}
      {isEmpty ? (
        <div className="card empty-state mb-md">
          <div className="empty-state-icon">🚀</div>
          <div className="empty-state-title">Welcome to Sentri!</div>
          <div className="empty-state-desc">
            Create your first project to start crawling your web app and AI-generating tests automatically.
          </div>
          <button className="btn btn-primary" onClick={() => navigate("/projects/new")}>
            Create First Project
          </button>
        </div>
      ) : (
        <>
          {/* ── Row 1: Core Health KPIs ─────────────────────────────── */}
          <div className="stat-grid">
            <StatCard label="Pass Rate" value={data?.passRate != null ? `${data.passRate}%` : "—"} sub={data?.passRate >= 80 ? "Healthy" : data?.passRate != null ? "Needs attention" : "No runs yet"} color={data?.passRate >= 80 ? "var(--green)" : data?.passRate != null ? "var(--amber)" : "var(--text3)"} icon={<TrendingUp size={16} />} />
            <StatCard label="Total Tests" value={data?.totalTests ?? 0} sub={`${tbr.approved || 0} approved · ${tbr.draft || 0} draft`} color="var(--blue)" icon={<FlaskConical size={16} />} />
            <StatCard label="Total Runs" value={data?.totalRuns ?? 0} sub={`${rbs.completed || 0} passed · ${rbs.failed || 0} failed`} color="var(--purple)" icon={<FileText size={16} />} />
            <StatCard label="Avg Duration" value={fmtDurationMs(data?.avgRunDurationMs)} sub={data?.mttrMs ? `MTTR: ${fmtDurationMs(data.mttrMs)}` : "Per test run"} color="var(--accent)" icon={<Clock size={16} />} />
          </div>

          {/* ── Row 2: Tests Created / Fixed / Healing ─────────────── */}
          <div className="stat-grid">
            <StatCard label="Created Today" value={data?.testsCreatedToday ?? 0} sub={`${data?.testsCreatedThisWeek ?? 0} this week`} color="var(--accent)" icon={<Plus size={16} />} />
            <StatCard label="AI Generated" value={data?.testsGeneratedTotal ?? 0} sub="All time" color="var(--blue)" icon={<FlaskConical size={16} />} />
            <StatCard label="Auto-Fixed" value={data?.testsAutoFixed ?? 0} sub="By feedback loop" color="var(--green)" icon={<Wrench size={16} />} />
            <StatCard label="Self-Healed" value={data?.healingSuccesses ?? 0} sub={`${data?.healingEntries ?? 0} elements tracked`} color="var(--purple)" icon={<Shield size={16} />} />
          </div>

          {/* ── Row 3: Flaky Tests + Defect Breakdown ─────────────── */}
          {data?.totalRuns > 0 && (() => {
            const defectSegs = [
              { label: "Selector",   count: dfb.SELECTOR_ISSUE || 0,  color: "var(--purple)" },
              { label: "Navigation", count: dfb.NAVIGATION_FAIL || 0, color: "var(--blue)" },
              { label: "Timeout",    count: dfb.TIMEOUT || 0,         color: "var(--amber)" },
              { label: "Assertion",  count: dfb.ASSERTION_FAIL || 0,  color: "var(--red)" },
              { label: "Other",      count: dfb.UNKNOWN || 0,         color: "#6b7280" },
            ];
            const totalDefects = defectSegs.reduce((s, x) => s + x.count, 0);
            return (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 16 }}>
                <StatCard
                  label="Flaky Tests"
                  value={data?.flakyTestCount ?? 0}
                  sub={data?.flakyTestCount > 0 ? "Inconsistent results" : "None detected"}
                  color={data?.flakyTestCount > 0 ? "var(--amber)" : "var(--green)"}
                  icon={<AlertTriangle size={16} />}
                />
                <div className="card card-padded">
                  <div className="flex-between" style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Crosshair size={14} color="var(--text3)" />
                      <span className="section-title" style={{ marginBottom: 0 }}>Defect Categories</span>
                    </div>
                    {totalDefects > 0 && (
                      <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>{totalDefects} total failures</span>
                    )}
                  </div>
                  {totalDefects === 0 ? (
                    <div style={{ fontSize: "0.82rem", color: "var(--text3)" }}>
                      <CheckCircle2 size={13} color="var(--green)" style={{ marginRight: 6, verticalAlign: "middle" }} />
                      No failures recorded
                    </div>
                  ) : (
                    <>
                      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                        {defectSegs.filter((s) => s.count > 0).map((s) => (
                          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                            <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>{s.label}</span>
                            <span style={{ fontSize: "0.82rem", fontWeight: 700, color: s.color }}>{s.count}</span>
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

          {/* ── Row 4: Run Status Distribution ─────────────────────── */}
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
                <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
                  {segs.map((s) => (
                    <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: s.color, display: "flex" }}>{s.icon}</span>
                      <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>{s.label}</span>
                      <span style={{ fontSize: "0.92rem", fontWeight: 700, color: s.color }}>{s.count}</span>
                    </div>
                  ))}
                </div>
                <StackedBar segments={segs} />
              </div>
            );
          })()}

          {/* ── Row 5: Test Review Pipeline ────────────────────────── */}
          {data?.totalTests > 0 && (() => {
            const segs = [
              { label: "Approved", count: tbr.approved || 0, color: "var(--green)" },
              { label: "Draft",    count: tbr.draft || 0,    color: "var(--amber)" },
              { label: "Rejected", count: tbr.rejected || 0, color: "var(--red)" },
            ];
            return (
              <div className="card card-padded mb-md">
                <div className="section-title">Test Review Pipeline</div>
                <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
                  {segs.map((s) => (
                    <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                      <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>{s.label}</span>
                      <span style={{ fontSize: "0.92rem", fontWeight: 700, color: s.color }}>{s.count}</span>
                    </div>
                  ))}
                </div>
                <StackedBar segments={segs} />
              </div>
            );
          })()}

          {/* ── Row 6: Test Suite Growth ─────────────────────────── */}
          {(data?.testGrowth?.length ?? 0) >= 2 && (
            <div className="card card-padded mb-md">
              <div className="flex-between" style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Activity size={14} color="var(--accent)" />
                  <span className="section-title" style={{ marginBottom: 0 }}>Test Suite Growth</span>
                </div>
                <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>Last 8 weeks</span>
              </div>
              <SparklineChart
                data={data.testGrowth.map((d) => ({ name: d.week, value: d.count }))}
                height={64}
                color="var(--accent)"
                tooltipFn={(d) => `${d.name}: ${d.value} tests`}
              />
            </div>
          )}

          {/* ── Row 7: Pass / Fail Trend Chart ────────────────────── */}
          <PassFailChart data={chartData} height={150} idPrefix="dash" title="Pass / Fail Trend" subtitle={`Last ${chartData.length} runs`} />

          {/* ── Row 8: Recent Activity ────────────────────────────── */}
          {runs.length > 0 && (
            <div className="card card-padded">
              <div className="flex-between" style={{ marginBottom: 18 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "1rem" }}>Recent Activity</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text3)", marginTop: 2 }}>
                    {runs.filter(r => r.status === "running").length > 0
                      ? `${runs.filter(r => r.status === "running").length} task(s) in progress`
                      : "Latest runs across all projects"}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate("/runs")}>View all</button>
              </div>
              <div className="flex-col gap-sm">
                {runs.map((r) => {
                  const meta = RUN_TYPE_META[r.type] || RUN_TYPE_META["run"];
                  return (
                    <div key={r.id} className="list-row" onClick={() => navigate(`/runs/${r.id}`)}>
                      <AgentTag type={(RUN_TYPE_META[r.type] || RUN_TYPE_META["run"]).avatar} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: "0.875rem", marginBottom: 1 }}>{meta.label}</div>
                        <div style={{ fontSize: "0.78rem", color: "var(--text2)" }} className="truncate">
                          {r.projectName || `Project ${r.projectId?.slice(0, 8)}`}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        {r.status === "running"
                          ? <RunningBadge />
                          : r.status === "completed"
                          ? <span className="badge badge-green">✓ Completed</span>
                          : r.status === "aborted"
                          ? <span className="badge badge-gray">⊘ Aborted</span>
                          : <span className="badge badge-red">✗ Failed</span>}
                        <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>
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

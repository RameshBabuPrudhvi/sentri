import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, CheckCircle2, XCircle, Ban, TrendingUp, AlertTriangle,
  FlaskConical, FileText, Wrench, Clock, Plus, Shield, Crosshair,
} from "lucide-react";
import { api } from "../api.js";
import { fmtDurationMs } from "../utils/formatters.js";
import AgentTag from "../components/AgentTag.jsx";
import StatCard from "../components/StatCard.jsx";
import PassFailChart from "../components/PassFailChart.jsx";
import StackedBar from "../components/StackedBar.jsx";

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
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      {[120, 200, 300].map((h, i) => <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 16 }} />)}
    </div>
  );

  const isEmpty = !loadError && !data?.totalProjects && !data?.totalTests && !data?.totalRuns;

  return (
    <div className="fade-in" style={{ maxWidth: 860, margin: "0 auto" }}>

      {/* Greeting */}
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: "1.8rem", fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
          {greeting()}!
        </h1>
        <p style={{ color: "var(--text2)", fontSize: "0.9rem" }}>
          Here's your real-time overview of the testing environment, including system health, key metrics, and what your agents are up to right now.
        </p>
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
        <div className="card" style={{ padding: "48px 40px", textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: "2.5rem", marginBottom: 14 }}>🚀</div>
          <div style={{ fontWeight: 700, fontSize: "1.15rem", marginBottom: 8 }}>Welcome to Sentri!</div>
          <div style={{ color: "var(--text2)", fontSize: "0.9rem", marginBottom: 24, maxWidth: 420, margin: "0 auto 24px" }}>
            Create your first project to start crawling your web app and AI-generating tests automatically.
          </div>
          <button className="btn btn-primary" onClick={() => navigate("/projects/new")}>
            Create First Project
          </button>
        </div>
      ) : (
        <>
          {/* ── Row 1: Core Health KPIs ─────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
            <StatCard label="Pass Rate" value={data?.passRate != null ? `${data.passRate}%` : "—"} sub={data?.passRate >= 80 ? "Healthy" : data?.passRate != null ? "Needs attention" : "No runs yet"} color={data?.passRate >= 80 ? "var(--green)" : data?.passRate != null ? "var(--amber)" : "var(--text3)"} icon={<TrendingUp size={16} />} />
            <StatCard label="Total Tests" value={data?.totalTests ?? 0} sub={`${tbr.approved || 0} approved · ${tbr.draft || 0} draft`} color="var(--blue)" icon={<FlaskConical size={16} />} />
            <StatCard label="Total Runs" value={data?.totalRuns ?? 0} sub={`${rbs.completed || 0} passed · ${rbs.failed || 0} failed`} color="var(--purple)" icon={<FileText size={16} />} />
            <StatCard label="Avg Duration" value={fmtDurationMs(data?.avgRunDurationMs)} sub="Per test run" color="var(--accent)" icon={<Clock size={16} />} />
          </div>

          {/* ── Row 2: Tests Created / Fixed / Healing ─────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
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
                <div className="card" style={{ padding: "20px 24px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Crosshair size={14} color="var(--text3)" />
                      <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Defect Categories</span>
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
              <div className="card" style={{ padding: "20px 24px", marginBottom: 16 }}>
                <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 14 }}>Run Status Distribution</div>
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
              <div className="card" style={{ padding: "20px 24px", marginBottom: 16 }}>
                <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 14 }}>Test Review Pipeline</div>
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

          {/* ── Row 6: Pass / Fail Trend Chart ────────────────────── */}
          <PassFailChart data={chartData} height={150} idPrefix="dash" title="Pass / Fail Trend" subtitle={`Last ${chartData.length} runs`} />

          {/* ── Row 7: Recent Activity ────────────────────────────── */}
          {runs.length > 0 && (
            <div className="card" style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "1rem" }}>Recent Activity</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text3)", marginTop: 2 }}>
                    {runs.filter(r => r.status === "running").length > 0
                      ? `${runs.filter(r => r.status === "running").length} task(s) in progress`
                      : "Latest runs across all projects"}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate("/work")}>View all</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {runs.map((r) => {
                  const meta = RUN_TYPE_META[r.type] || RUN_TYPE_META["run"];
                  return (
                    <div key={r.id} style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                      border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg2)",
                      cursor: "pointer", transition: "background 0.12s",
                    }} onClick={() => navigate(`/runs/${r.id}`)}>
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

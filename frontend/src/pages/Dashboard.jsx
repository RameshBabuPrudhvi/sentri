import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, CheckCircle2, XCircle, Ban, TrendingUp, AlertTriangle,
  SquareCheckBig, FileText, Wrench, Clock, Plus, Shield, Crosshair, Activity,
  Download, RefreshCw, Rocket, CloudOff,
} from "lucide-react";
import { useDashboardQuery } from "../hooks/queries/useDashboardQuery.js";
import EmptyState from "../components/shared/EmptyState.jsx";
import { fmtDurationMs } from "../utils/formatters.js";
import { generateExecutivePDF } from "../utils/pdfReportGenerator.js";
import AgentTag from "../components/shared/AgentTag.jsx";
import StatCard from "../components/shared/StatCard.jsx";
import WorkerPoolPanel from "../components/shared/WorkerPoolPanel.jsx";
import PassFailChart from "../components/charts/PassFailChart.jsx";
import SparklineChart from "../components/charts/SparklineChart.jsx";
import StackedBar from "../components/charts/StackedBar.jsx";
import EvalPanel from "../components/dashboard/EvalPanel.jsx";
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

// AUTO-009c — Coverage panel hoisted into its own component so it can own
// the line/branch/function tab state via `useState`. The whole panel is
// driven off the `coverageTrend` + `recentRuns` slices of the dashboard
// payload — no extra fetches.
const COVERAGE_METRICS = [
  { key: "line",     label: "Lines",     seriesKey: "coveragePct",  summaryPctKey: "coveragePct",  summaryUncoveredKey: "uncoveredLines",     summaryTotalKey: "totalLines"     },
  { key: "branch",   label: "Branches",  seriesKey: "branchPct",    summaryPctKey: "branchPct",    summaryUncoveredKey: "uncoveredBranches",  summaryTotalKey: "totalBranches"  },
  { key: "function", label: "Functions", seriesKey: "functionPct",  summaryPctKey: "functionPct",  summaryUncoveredKey: "uncoveredFunctions", summaryTotalKey: "totalFunctions" },
];

function CoveragePanel({ data, Activity, SparklineChart }) {
  // Default to "line" so behaviour matches the pre-AUTO-009c panel. The
  // toggle is hidden when no run has branch/function data so the empty
  // state for a line-only SUT looks identical to before.
  const [metricKey, setMetricKey] = useState("line");
  const series = data?.coverageTrend?.series || [];

  // Per-project series grouping — same as before, but the y-value is now
  // pulled from whichever metric is selected. Missing values (older
  // backends, or runs that didn't generate granularity data) fall back to
  // `coveragePct` so the sparkline never has a hole.
  const byProject = new Map();
  for (const point of series) {
    if (!byProject.has(point.projectId)) byProject.set(point.projectId, []);
    byProject.get(point.projectId).push(point);
  }
  // AUTO-009 — `coverageSummary` is no longer denormalised onto `recentRuns`
  // (it bloated the dashboard payload and required the LEAN_COLS bump that
  // was missing in the original implementation). The backend now ships the
  // per-project latest summary in a dedicated `latestCoverageByProject` map.
  const latestSummaryByProject = new Map(
    Object.entries(data?.latestCoverageByProject || {}),
  );

  // Show the metric tabs only when at least one series point carries the
  // granularity field — otherwise the tabs would all read 0% on a pre-009c
  // backend or a SUT where v8-to-istanbul never produced output.
  const granularityAvailable = series.some((p) => p.branchPct != null || p.functionPct != null);

  // AUTO-009h — Browser / Server / Combined tab toggle. Only renders when
  // at least one project has surfaced server-side coverage data
  // (`latestSummaryByProject` entry with `serverLayer: true` OR a
  // `topUncoveredFiles[]` row carrying `layer: "server"`); otherwise we
  // default to browser-only and hide the tabs so pre-AUTO-009h SUTs look
  // identical to before.
  //
  // Intentional UI behavior: once `serverLayerAvailable` flips true for
  // ANY project in the workspace, the toggle stays rendered across
  // subsequent dashboard reads — even if the latest run on every
  // project is browser-only. This is by design: operators expect the
  // segmented control to be stable, not to disappear-and-reappear as
  // the most-recent run rotates between browser and API suites. The
  // toggle defaults to `"browser"` so a browser-only latest run is
  // rendered correctly without an explicit user toggle.
  const [layerKey, setLayerKey] = useState("browser");
  const serverLayerAvailable = Array.from(latestSummaryByProject.values()).some((s) =>
    s?.serverLayer === true ||
    (Array.isArray(s?.topUncoveredFiles) && s.topUncoveredFiles.some((f) => f.layer === "server"))
  );
  const LAYER_TABS = [
    { key: "browser",  label: "Browser"  },
    { key: "server",   label: "Server"   },
    { key: "combined", label: "Combined" },
  ];
  const metric = COVERAGE_METRICS.find((m) => m.key === metricKey) || COVERAGE_METRICS[0];

  return (
    <div className="card card-padded mb-md">
      <div className="flex-between dash-cov-header">
        <div className="dash-cov-header-left">
          <Activity size={14} color="var(--accent)" />
          <span className="section-title dash-cov-section-title">Coverage</span>
        </div>
        <div className="dash-cov-header-right">
          {serverLayerAvailable && (
            // AUTO-009h — Browser / Server / Combined layer toggle. Only
            // rendered when at least one project's coverage summary
            // carries server-side data; otherwise pre-AUTO-009h SUTs see
            // no UI delta. Mirrors the metric-tab style below.
            <div role="tablist" aria-label="Coverage layer" className="dash-cov-tablist">
              {LAYER_TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={layerKey === t.key}
                  onClick={() => setLayerKey(t.key)}
                  className={`dash-cov-tab ${layerKey === t.key ? "dash-cov-tab--active" : ""}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {granularityAvailable && (
            // AUTO-009c — three-way toggle. Mirrors the eval-panel tab style
            // to stay visually consistent. Uses `role="tablist"` so the
            // segmented control is announced as a tabbed selector by screen
            // readers.
            <div role="tablist" aria-label="Coverage metric" className="dash-cov-tablist">
              {COVERAGE_METRICS.map((m) => (
                <button
                  key={m.key}
                  role="tab"
                  aria-selected={metricKey === m.key}
                  onClick={() => setMetricKey(m.key)}
                  className={`dash-cov-tab ${metricKey === m.key ? "dash-cov-tab--active" : ""}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {series.length > 0 && (
            <span className="text-xs text-muted">{`30-day · ${series.length} run${series.length !== 1 ? "s" : ""}`}</span>
          )}
        </div>
      </div>
      {series.length === 0 ? (
        <div className="text-sm text-muted">
          Enable coverage on a project to start tracking. Go to <strong>Automation → Quality → Coverage</strong> and toggle <em>Enable browser JS coverage capture</em>.
        </div>
      ) : (
        <div className="flex-col gap-sm">
          {Array.from(byProject.entries()).map(([projectId, points]) => {
            // Pull the metric value with a line-pct fallback so the
            // sparkline never has a hole. `getValue()` returns a number in
            // [0,1] or null when neither the selected metric nor coveragePct
            // is present.
            const getValue = (p) => {
              const v = p[metric.seriesKey];
              if (typeof v === "number") return v;
              if (typeof p.coveragePct === "number") return p.coveragePct;
              return null;
            };
            const latestPoint = points[points.length - 1];
            const latestPct = (latestPoint && getValue(latestPoint)) || 0;
            const projectName = latestSummaryByProject.get(projectId)?.projectName || (data?.recentRuns || []).find((r) => r.projectId === projectId)?.projectName || projectId.slice(0, 8);
            const summary = latestSummaryByProject.get(projectId);
            // AUTO-009h — filter topUncoveredFiles by the selected layer
            // tab. `layer` is `"browser"` or `"server"`; rows without
            // a `layer` key are pre-AUTO-009h browser rows and default to
            // browser. The "combined" tab shows every row regardless.
            const allTopUncovered = Array.isArray(summary?.topUncoveredFiles) ? summary.topUncoveredFiles : [];
            const topUncovered = (layerKey === "combined"
              ? allTopUncovered
              : allTopUncovered.filter((f) => (f.layer || "browser") === layerKey)
            ).slice(0, 5);
            // AUTO-009b — fallback / partial badge stays metric-independent.
            const sourceMapStatus = summary?.sourceMapStatus || "fallback";
            const isFallback = sourceMapStatus !== "resolved";
            const statusBadgeColor = sourceMapStatus === "resolved" ? "var(--green)"
              : sourceMapStatus === "partial" ? "var(--amber)"
              : "var(--text3)";
            // Data-driven badge background / foreground — derived from the
            // pct band (≥80 green, ≥50 amber, <50 red). Inlined as
            // `style={{...}}` deliberately per AGENT.md §127's data-
            // driven carve-out (used by `dash-env-rate` etc): N CSS
            // classes per threshold band wouldn't be cleaner.
            const latestPctBadgeStyle = {
              background: latestPct >= 0.8 ? "var(--green-bg)" : latestPct >= 0.5 ? "var(--amber-bg)" : "var(--red-bg)",
              color:      latestPct >= 0.8 ? "var(--green)"    : latestPct >= 0.5 ? "var(--amber)"    : "var(--red)",
            };
            return (
              <div key={projectId} className="list-row dash-cov-project-row">
                <div className="flex-between dash-cov-project-header">
                  <div className="dash-cov-project-name">{projectName}</div>
                  <span
                    className="badge dash-cov-project-pct"
                    style={latestPctBadgeStyle}
                    title={`${metric.label}: ${Math.round(latestPct * 100)}%`}
                  >
                    {`${Math.round(latestPct * 100)}%`}
                  </span>
                </div>
                <SparklineChart
                  data={points.map((p, i) => ({ name: `#${i + 1}`, value: Math.round(((getValue(p)) || 0) * 100) }))}
                  height={40}
                  color="var(--accent)"
                  tooltipFn={(d) => `${d.name}: ${d.value}% ${metric.label.toLowerCase()}`}
                />
                {topUncovered.length > 0 && (
                  <div className="dash-cov-files">
                    <div className="dash-cov-files-header">
                      <span>Top uncovered files</span>
                      {isFallback && (
                        <span
                          className="badge dash-cov-files-status-badge"
                          style={{ color: statusBadgeColor }}
                          title={sourceMapStatus === "partial"
                            ? "Source maps partially resolved — some entries show original source paths, others show bundle URLs."
                            : "Source maps unavailable — file labels are bundle URLs, not original source paths. Configure project.sourcemapBaseUrl to enable resolution."}
                        >
                          {sourceMapStatus === "partial" ? "partial maps" : "fallback mode"}
                        </span>
                      )}
                    </div>
                    {topUncovered.map((f) => {
                      // AUTO-009c — per-file uncovered count follows the
                      // selected metric. Backends without granularity
                      // surface `uncoveredBranches`/`uncoveredFunctions` as
                      // 0 (or undefined) so the row degrades cleanly to
                      // line-only.
                      const uncovered = metricKey === "line" ? f.uncoveredLines
                        : metricKey === "branch" ? (f.uncoveredBranches ?? 0)
                        : (f.uncoveredFunctions ?? 0);
                      const unit = metricKey === "line" ? "lines"
                        : metricKey === "branch" ? "branches"
                        : "functions";
                      return (
                        <div key={`${f.file}::${f.bundleUrl || ""}`} className="truncate" title={f.bundleUrl ? `${f.file}\nbundle: ${f.bundleUrl}` : f.file}>
                          <code className="dash-cov-file-code">{f.file}</code>
                          <span className="dash-cov-file-uncovered">{uncovered}</span>
                          <span className="dash-cov-file-meta">{` uncovered ${unit}`}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
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

      {/* ONB-002 (audit): API error → shared empty-state shape so the
          Dashboard's error surface matches the four pages retrofitted in
          this PR. The Retry CTA was always there; now it lives in the
          standard `.empty-state-actions` row instead of dangling below
          the raw description. */}
      {loadError && (
        <div className="mb-md">
          <EmptyState
            icon={<CloudOff size={32} color="var(--red)" />}
            title="Could not load dashboard data"
            description="The API may be temporarily unavailable. Your data is safe."
            action={{ label: "Retry", onClick: () => dashboardQuery.refetch(), variant: "ghost" }}
          />
        </div>
      )}

      {/* ONB-002 (audit): first-run onboarding via the shared primitive.
          Same Rocket icon used by Tests.jsx's onboarding branch so the two
          surfaces read as related once a user signs in. */}
      {isEmpty ? (
        <div className="mb-md">
          <EmptyState
            icon={<Rocket size={32} color="var(--accent)" />}
            title="Welcome to Sentri!"
            description="Create your first project to start crawling your web app and AI-generating tests automatically."
            action={{ label: "Create First Project", onClick: () => navigate("/projects/new") }}
          />
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
            <StatCard label="Total Tests" value={data?.totalTests ?? 0} sub={`${tbr.approved || 0} approved · ${tbr.draft || 0} draft`} color="var(--blue)" icon={<SquareCheckBig size={16} />} />
            <StatCard label="Total Runs" value={data?.totalRuns ?? 0} sub={`${rbs.completed || 0} passed · ${rbs.failed || 0} failed`} color="var(--purple)" icon={<FileText size={16} />} />
          </div>
          {/* ── AUTO-009 / AUTO-009b / AUTO-009c: Coverage panel with metric toggle ── */}
          <CoveragePanel data={data} Activity={Activity} SparklineChart={SparklineChart} />

          {/* ── Row 2: Duration / Created / Fixed / Healing ── */}
          <div className="stat-grid">
            <StatCard label="Avg Duration" value={fmtDurationMs(data?.avgRunDurationMs)} sub={data?.mttrMs ? `MTTR: ${fmtDurationMs(data.mttrMs)}` : "Per test run"} color="var(--accent)" icon={<Clock size={16} />} />
            <StatCard label="Created Today" value={data?.testsCreatedToday ?? 0} sub={`${data?.testsCreatedThisWeek ?? 0} this week · ${data?.testsGeneratedTotal ?? 0} total`} color="var(--blue)" icon={<Plus size={16} />} />
            <StatCard label="Auto-Fixed" value={data?.testsAutoFixed ?? 0} sub="By feedback loop" color="var(--green)" icon={<Wrench size={16} />} />
            <StatCard label="Self-Healed" value={data?.healingSuccesses ?? 0} sub={`${data?.healingEntries ?? 0} elements tracked`} color="var(--purple)" icon={<Shield size={16} />} />
          </div>



          {/* ── Row 2b: Platform Health (DASH-003, audit) ──
              The four BullMQ worker stat cards (Runner Mode / Queue Depth /
              Active Workers / Completed Jobs) moved to `/system` per the
              audit's recommendation — that's operator infrastructure data
              that occupies dashboard real estate without serving the QA
              persona. The single Platform Health card here collapses the
              same signals into one green/amber/red indicator: green when
              the queue is healthy, amber on backed-up queues or missing
              workers, red on any failed job. Drill into /system for the
              full breakdown.

              `stat-grid` keeps the 4-column track even with one card so
              the dashboard's row rhythm doesn't shift below it. */}
          <div className="stat-grid">
            <WorkerPoolPanel workerPool={data?.workerPool} variant="health" />
          </div>

          {/* ── Row 3: Flaky Tests + Defect Breakdown ── */}
          {data?.totalRuns > 0 && (() => {
            // The backend currently surfaces six named categories in
            // `defectBreakdown` (BOT_BLOCK + SELECTOR_ISSUE + NAVIGATION_FAIL
            // + TIMEOUT + ASSERTION_FAIL + UNKNOWN) and may add more without
            // a frontend change — `backend/src/routes/dashboard.js:130` falls
            // back to UNKNOWN for unrecognised keys. Three named categories
            // exist in the classifier but aren't in the dashboard's init
            // shape today (NETWORK_MOCK_FAIL / FRAME_FAIL / API_ASSERTION_FAIL);
            // we still aggregate any value the API returns for them into the
            // "Other" bucket so a backend update that wires them in doesn't
            // silently drop counts from the chart total. BOT_BLOCK is its
            // own segment with a distinct gray hue so operators can tell
            // bot-blocked sites apart from real defects at a glance.
            const NAMED_KEYS = new Set([
              "BOT_BLOCK", "SELECTOR_ISSUE", "NAVIGATION_FAIL", "TIMEOUT", "ASSERTION_FAIL",
            ]);
            let otherCount = dfb.UNKNOWN || 0;
            for (const [key, value] of Object.entries(dfb)) {
              if (!NAMED_KEYS.has(key) && key !== "UNKNOWN") otherCount += Number(value) || 0;
            }
            const defectSegs = [
              { label: "Bot-blocked", count: dfb.BOT_BLOCK || 0,       color: "#94a3b8"       },
              { label: "Selector",    count: dfb.SELECTOR_ISSUE || 0,  color: "var(--purple)" },
              { label: "Navigation",  count: dfb.NAVIGATION_FAIL || 0, color: "var(--blue)"   },
              { label: "Timeout",     count: dfb.TIMEOUT || 0,         color: "var(--amber)"  },
              { label: "Assertion",   count: dfb.ASSERTION_FAIL || 0,  color: "var(--red)"    },
              { label: "Other",       count: otherCount,               color: "#6b7280"       },
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

          {/* ── DIF-012: Per-environment pass rate + last green run ── */}
          {(data?.environmentPassRates?.length ?? 0) > 0 && (
            <div className="card card-padded mb-md">
              <div className="flex-between mb-md">
                <div className="flex-center gap-sm">
                  <Activity size={14} color="var(--accent)" />
                  <span className="section-title" style={{ marginBottom: 0 }}>Environments</span>
                </div>
                <span className="text-xs text-muted">
                  {data.environmentPassRates.length} environment{data.environmentPassRates.length !== 1 ? "s" : ""}
                </span>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Environment</th>
                    <th>Pass rate</th>
                    <th>Last green run</th>
                  </tr>
                </thead>
                <tbody>
                  {data.environmentPassRates.map((row) => {
                    const key = `${row.projectId}::${row.environmentId || "default"}`;
                    const pct = row.passRate;
                    const rateClass = pct == null ? "dash-env-rate--none"
                      : pct >= 80 ? "dash-env-rate--good"
                      : pct >= 50 ? "dash-env-rate--warn"
                      : "dash-env-rate--bad";
                    return (
                      <tr key={key}>
                        <td className="dash-env-project" onClick={() => navigate(`/projects/${row.projectId}`)}>
                          {row.projectName}
                        </td>
                        <td className="dash-env-name">
                          {row.environmentName}
                          {row.baseUrl && <span className="dash-env-base">{row.baseUrl}</span>}
                        </td>
                        <td>
                          <span className={`dash-env-rate ${rateClass}`}>
                            {pct == null ? "—" : `${pct}%`}
                          </span>
                          <span className="dash-env-count">
                            ({row.passed}/{row.total})
                          </span>
                        </td>
                        <td>
                          {row.lastGreenRunAt ? (
                            <span
                              className="dash-env-green-link"
                              onClick={() => row.lastGreenRunId && navigate(`/runs/${row.lastGreenRunId}`)}
                            >
                              {new Date(row.lastGreenRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </span>
                          ) : (
                            <span className="dash-env-never">Never</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── AUTO-022: AI eval-harness trend + drill-down ── */}
          <EvalPanel evalTrend={data?.evalTrend ?? null} />

          {(data?.topAccessibilityOffenders?.length ?? 0) > 0 && (
            <div className="card card-padded mb-md">
              <div className="flex-between" style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Activity size={14} color="var(--red)" />
                  <span className="section-title" style={{ marginBottom: 0 }}>Top Accessibility Offenders</span>
                </div>
                <span className="text-xs text-muted">{data.topAccessibilityOffenders.length} project{data.topAccessibilityOffenders.length !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex-col gap-sm">
                {data.topAccessibilityOffenders.map((row) => (
                  <div key={row.projectId} className="list-row">
                    <div style={{ flex: 1, minWidth: 0, fontSize: "0.86rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.projectName}
                    </div>
                    <span className="badge badge-red" style={{ fontSize: "0.68rem" }}>
                      {row.violations} violations
                    </span>
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

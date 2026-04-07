/**
 * @module utils/pdfReportGenerator
 * @description Generates a full executive HTML report from live Sentri data,
 * opens it in a new tab, and triggers the browser print dialog for PDF export.
 *
 * Separated from Dashboard.jsx for testability and maintainability.
 * Split into focused functions:
 *   - {@link fetchReportData}    — parallel API data fetching
 *   - {@link aggregateMetrics}   — compute KPIs, trends, breakdowns
 *   - {@link renderReportHtml}   — build the 13-section HTML document
 *   - {@link openPrintWindow}    — open blob URL and trigger print
 *
 * The HTML rendering is in a companion file (`pdfReportHtml.js`) to keep
 * each module under 300 lines.
 *
 * ### Exports
 * - {@link generateExecutivePDF} — orchestrates all four steps.
 */

import { api } from "../api.js";
import { renderReportHtml } from "./pdfReportHtml.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function healthLabel(p) {
  if (p === null) return { label: "No data",  col: "#9ca3af" };
  if (p >= 90)    return { label: "Excellent", col: "#16a34a" };
  if (p >= 75)    return { label: "Healthy",   col: "#16a34a" };
  if (p >= 50)    return { label: "Degraded",  col: "#d97706" };
  return            { label: "Critical",  col: "#dc2626" };
}

// ── 1. Data fetching ─────────────────────────────────────────────────────────

async function fetchReportData() {
  let dashboard = null, projects = [], allTests = [], allRuns = [], config = null, sysInfo = null;
  try {
    [dashboard, projects, allTests, config, sysInfo] = await Promise.all([
      api.getDashboard().catch(() => null), api.getProjects().catch(() => []),
      api.getAllTests().catch(() => []), api.getConfig().catch(() => null),
      api.getSystemInfo().catch(() => null),
    ]);
    const runArrays = await Promise.all(
      projects.map(p =>
        api.getRuns(p.id)
          .then(rs => rs.map(r => ({ ...r, projectId: p.id, projectName: p.name, projectUrl: p.url })))
          .catch(() => [])
      )
    );
    allRuns = runArrays.flat().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  } catch (e) { console.error("PDF data fetch error", e); }
  return { dashboard, projects, allTests, allRuns, config, sysInfo };
}

// ── 2. Metric aggregation ────────────────────────────────────────────────────

function aggregateMetrics({ dashboard, projects, allTests, allRuns, config, sysInfo }) {
  const testRuns = allRuns.filter(r => r.type === "test_run" || r.type === "run");
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const today = new Date(); today.setHours(0,0,0,0);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 30);
  const isToday = r => r.startedAt && new Date(r.startedAt) >= today;
  const isThisWeek = r => r.startedAt && new Date(r.startedAt) >= weekAgo;
  const isMonth = r => r.startedAt && new Date(r.startedAt) >= monthAgo;
  const completedRuns = testRuns.filter(r => r.status === "completed");
  const todayRuns = testRuns.filter(isToday);
  const todayComp = todayRuns.filter(r => r.status === "completed");
  const weekRuns = testRuns.filter(isThisWeek);
  const weekComp = weekRuns.filter(r => r.status === "completed");
  const monthComp = testRuns.filter(isMonth).filter(r => r.status === "completed");

  const agg = (runs) => {
    const passed = runs.reduce((s, r) => s + (r.passed || 0), 0);
    const failed = runs.reduce((s, r) => s + (r.failed || 0), 0);
    const total  = runs.reduce((s, r) => s + (r.total  || 0), 0);
    return { passed, failed, total, pct: total ? Math.round((passed / total) * 100) : null };
  };
  const avgDuration = (runs) => {
    const timed = runs.filter(r => r.startedAt && r.finishedAt);
    if (!timed.length) return null;
    return Math.round(timed.reduce((s, r) => s + (new Date(r.finishedAt) - new Date(r.startedAt)), 0) / timed.length);
  };

  const overall = agg(completedRuns), todaySt = agg(todayComp), weekSt = agg(weekComp), monthSt = agg(monthComp);
  const rec7 = agg(completedRuns.slice(0, 7)), pri7 = agg(completedRuns.slice(7, 14));
  const trendDelta = (rec7.pct !== null && pri7.pct !== null) ? rec7.pct - pri7.pct : null;

  const testResultMap = {};
  testRuns.forEach(run => { (run.results || []).forEach(res => { if (!testResultMap[res.testId]) testResultMap[res.testId] = new Set(); testResultMap[res.testId].add(res.status); }); });
  const flakyTests = allTests.filter(t => { const s = testResultMap[t.id]; return s && s.has("passed") && s.has("failed"); });

  const failCounts = {}, todayFailCounts = {};
  testRuns.forEach(run => { (run.results || []).forEach(res => { if (res.status === "failed") { failCounts[res.testId] = (failCounts[res.testId] || 0) + 1; if (isToday(run)) todayFailCounts[res.testId] = (todayFailCounts[res.testId] || 0) + 1; } }); });
  const topFailing = allTests.filter(t => failCounts[t.id]).sort((a, b) => failCounts[b.id] - failCounts[a.id]).slice(0, 10)
    .map(t => ({ ...t, failCount: failCounts[t.id], risk: failCounts[t.id] >= 5 ? "High" : failCounts[t.id] >= 2 ? "Medium" : "Low" }));
  const todayFailing = allTests.filter(t => todayFailCounts[t.id]).sort((a, b) => todayFailCounts[b.id] - todayFailCounts[a.id])
    .map(t => ({ ...t, failCount: todayFailCounts[t.id] }));

  const projMap = Object.fromEntries(projects.map(p => [p.id, p.name]));
  const projectBreakdown = projects.map(p => {
    const pRuns = testRuns.filter(r => r.projectId === p.id && r.status === "completed");
    const pTests = allTests.filter(t => t.projectId === p.id);
    return {
      name: p.name || p.id, url: p.url, tests: pTests.length,
      approved: pTests.filter(t => t.reviewStatus === "approved").length,
      draft: pTests.filter(t => t.reviewStatus === "draft").length,
      all: agg(pRuns), tod: agg(todayComp.filter(r => r.projectId === p.id)),
      wk: agg(weekComp.filter(r => r.projectId === p.id)),
      runs: pRuns.length, avgDur: avgDuration(pRuns),
      lastRun: testRuns.find(r => r.projectId === p.id),
    };
  });

  const dfb = dashboard?.defectBreakdown || {};
  const defects = [
    { label: "Selector Issues", count: dfb.SELECTOR_ISSUE || 0 },
    { label: "Navigation Failures", count: dfb.NAVIGATION_FAIL || 0 },
    { label: "Timeouts", count: dfb.TIMEOUT || 0 },
    { label: "Assertion Failures", count: dfb.ASSERTION_FAIL || 0 },
    { label: "Other", count: dfb.UNKNOWN || 0 },
  ].filter(d => d.count > 0);
  const totalDefects = defects.reduce((s, d) => s + d.count, 0);
  const approvedTests = allTests.filter(t => t.reviewStatus === "approved").length;
  const draftTests = allTests.filter(t => t.reviewStatus === "draft").length;
  const rejectedTests = allTests.filter(t => t.reviewStatus === "rejected").length;
  const rbs = {
    completed: testRuns.filter(r => r.status === "completed").length,
    failed: testRuns.filter(r => r.status === "failed").length,
    running: testRuns.filter(r => r.status === "running").length,
    aborted: testRuns.filter(r => r.status === "aborted").length,
  };
  const health = healthLabel(overall.pct);
  const monthDesc = monthSt.pct !== null
    ? `${monthSt.passed} passed, ${monthSt.failed} failed across ${monthComp.length} runs (${monthSt.pct}%)`
    : "No completed runs in the last 30 days";

  return {
    testRuns, dateStr, timeStr, completedRuns, todayRuns, todayComp,
    weekRuns, weekComp, monthComp, overall, todaySt, weekSt, monthSt,
    trendDelta, flakyTests, topFailing, todayFailing, projMap,
    projectBreakdown, defects, totalDefects, approvedTests, draftTests,
    rejectedTests, rbs, health, monthDesc, avgDuration,
    dashboard, projects, allTests, config, sysInfo,
  };
}

// ── 4. Open print window ─────────────────────────────────────────────────────

function openPrintWindow(html) {
  const blob = new Blob([html], { type: "text/html" });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, "_blank");
  if (win) setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function generateExecutivePDF() {
  const rawData = await fetchReportData();
  const metrics = aggregateMetrics(rawData);
  const html    = renderReportHtml(metrics);
  openPrintWindow(html);
}

import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, CheckCircle2, XCircle, Ban, TrendingUp, AlertTriangle,
  FlaskConical, FileText, Wrench, Clock, Plus, Shield, Crosshair, Activity,
  Download, RefreshCw,
} from "lucide-react";
import { api } from "../api.js";
import { fmtDurationMs, fmtRelativeDate } from "../utils/formatters.js";
import AgentTag from "../components/AgentTag.jsx";
import StatCard from "../components/StatCard.jsx";
import PassFailChart from "../components/PassFailChart.jsx";
import SparklineChart from "../components/SparklineChart.jsx";
import StackedBar from "../components/StackedBar.jsx";
import AppLogo from "../components/AppLogo.jsx";
import usePageTitle from "../hooks/usePageTitle.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function fmtMs(ms) {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function fmtDur(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  return new Date(finishedAt) - new Date(startedAt);
}

function pctColor(p) {
  if (p === null) return "#9ca3af";
  if (p >= 90) return "#16a34a";
  if (p >= 75) return "#16a34a";
  if (p >= 50) return "#d97706";
  return "#dc2626";
}

function healthLabel(p) {
  if (p === null) return { label: "No data",  col: "#9ca3af" };
  if (p >= 90)    return { label: "Excellent", col: "#16a34a" };
  if (p >= 75)    return { label: "Healthy",   col: "#16a34a" };
  if (p >= 50)    return { label: "Degraded",  col: "#d97706" };
  return            { label: "Critical",  col: "#dc2626" };
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

// ─────────────────────────────────────────────────────────────────────────────
// PDF Generator — pulls all live data, renders full executive report
// ─────────────────────────────────────────────────────────────────────────────
async function generateExecutivePDF() {
  // Fetch all data in parallel
  let dashboard = null, projects = [], allTests = [], allRuns = [], config = null, sysInfo = null;

  try {
    [dashboard, projects, allTests, config, sysInfo] = await Promise.all([
      api.getDashboard().catch(() => null),
      api.getProjects().catch(() => []),
      api.getAllTests().catch(() => []),
      api.getConfig().catch(() => null),
      api.getSystemInfo().catch(() => null),
    ]);

    // Fetch runs per project
    const runArrays = await Promise.all(
      projects.map(p =>
        api.getRuns(p.id)
          .then(rs => rs.map(r => ({ ...r, projectId: p.id, projectName: p.name, projectUrl: p.url })))
          .catch(() => [])
      )
    );
    allRuns = runArrays.flat().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  } catch (e) {
    console.error("PDF data fetch error", e);
  }

  const testRuns = allRuns.filter(r => r.type === "test_run" || r.type === "run");

  // ── Date/time ──
  const now      = new Date();
  const dateStr  = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr  = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  // ── Time windows ──
  const today     = new Date(); today.setHours(0,0,0,0);
  const weekAgo   = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo  = new Date(today); monthAgo.setDate(monthAgo.getDate() - 30);

  const isToday    = r => r.startedAt && new Date(r.startedAt) >= today;
  const isThisWeek = r => r.startedAt && new Date(r.startedAt) >= weekAgo;
  const isMonth    = r => r.startedAt && new Date(r.startedAt) >= monthAgo;

  const completedRuns = testRuns.filter(r => r.status === "completed");
  const todayRuns     = testRuns.filter(isToday);
  const todayComp     = todayRuns.filter(r => r.status === "completed");
  const weekRuns      = testRuns.filter(isThisWeek);
  const weekComp      = weekRuns.filter(r => r.status === "completed");
  const monthComp     = testRuns.filter(isMonth).filter(r => r.status === "completed");

  // ── Aggregators ──
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

  const overall  = agg(completedRuns);
  const todaySt  = agg(todayComp);
  const weekSt   = agg(weekComp);
  const monthSt  = agg(monthComp);

  // ── Trend direction: last 7 vs prior 7 ──
  const rec7  = agg(completedRuns.slice(0, 7));
  const pri7  = agg(completedRuns.slice(7, 14));
  const trendDelta = (rec7.pct !== null && pri7.pct !== null) ? rec7.pct - pri7.pct : null;

  // ── Flaky tests ──
  const testResultMap = {};
  testRuns.forEach(run => {
    (run.results || []).forEach(res => {
      if (!testResultMap[res.testId]) testResultMap[res.testId] = new Set();
      testResultMap[res.testId].add(res.status);
    });
  });
  const flakyTests = allTests.filter(t => {
    const s = testResultMap[t.id];
    return s && s.has("passed") && s.has("failed");
  });

  // ── Failure counts per test ──
  const failCounts = {}, todayFailCounts = {};
  testRuns.forEach(run => {
    (run.results || []).forEach(res => {
      if (res.status === "failed") {
        failCounts[res.testId] = (failCounts[res.testId] || 0) + 1;
        if (isToday(run)) todayFailCounts[res.testId] = (todayFailCounts[res.testId] || 0) + 1;
      }
    });
  });

  const topFailing = allTests
    .filter(t => failCounts[t.id])
    .sort((a, b) => failCounts[b.id] - failCounts[a.id])
    .slice(0, 10)
    .map(t => ({ ...t, failCount: failCounts[t.id], risk: failCounts[t.id] >= 5 ? "High" : failCounts[t.id] >= 2 ? "Medium" : "Low" }));

  const todayFailing = allTests
    .filter(t => todayFailCounts[t.id])
    .sort((a, b) => todayFailCounts[b.id] - todayFailCounts[a.id])
    .map(t => ({ ...t, failCount: todayFailCounts[t.id] }));

  // ── Per-project breakdown ──
  const projMap = Object.fromEntries(projects.map(p => [p.id, p.name]));
  const projectBreakdown = projects.map(p => {
    const pRuns  = testRuns.filter(r => r.projectId === p.id && r.status === "completed");
    const tRuns  = todayComp.filter(r => r.projectId === p.id);
    const wRuns  = weekComp.filter(r => r.projectId === p.id);
    const pTests = allTests.filter(t => t.projectId === p.id);
    const approved = pTests.filter(t => t.status === "approved").length;
    const draft    = pTests.filter(t => t.status === "draft").length;
    const lastRun  = testRuns.find(r => r.projectId === p.id);
    return {
      name: p.name || p.id, url: p.url,
      tests: pTests.length, approved, draft,
      all: agg(pRuns), tod: agg(tRuns), wk: agg(wRuns),
      runs: pRuns.length, avgDur: avgDuration(pRuns),
      lastRun,
    };
  });

  // ── Defect breakdown from dashboard ──
  const dfb = dashboard?.defectBreakdown || {};
  const defects = [
    { label: "Selector Issues",    count: dfb.SELECTOR_ISSUE || 0  },
    { label: "Navigation Failures",count: dfb.NAVIGATION_FAIL || 0 },
    { label: "Timeouts",           count: dfb.TIMEOUT || 0         },
    { label: "Assertion Failures", count: dfb.ASSERTION_FAIL || 0  },
    { label: "Other",              count: dfb.UNKNOWN || 0         },
  ].filter(d => d.count > 0);
  const totalDefects = defects.reduce((s, d) => s + d.count, 0);

  // ── Test inventory ──
  const approvedTests = allTests.filter(t => t.status === "approved").length;
  const draftTests    = allTests.filter(t => t.status === "draft").length;
  const rejectedTests = allTests.filter(t => t.status === "rejected").length;

  // ── Run status breakdown ──
  const rbs = {
    completed: testRuns.filter(r => r.status === "completed").length,
    failed:    testRuns.filter(r => r.status === "failed").length,
    running:   testRuns.filter(r => r.status === "running").length,
    aborted:   testRuns.filter(r => r.status === "aborted").length,
  };

  // ── Health label ──
  const health = healthLabel(overall.pct);

  // ── Helpers for HTML ──
  const pill = (text, type) => {
    const styles = {
      green:  "background:#dcfce7;color:#16a34a",
      red:    "background:#fee2e2;color:#dc2626",
      amber:  "background:#fef3c7;color:#d97706",
      blue:   "background:#dbeafe;color:#2563eb",
      purple: "background:#ede9fe;color:#7c3aed",
      gray:   "background:#f3f4f6;color:#6b7280",
    };
    return `<span style="display:inline-block;padding:2px 9px;border-radius:99px;font-size:8pt;font-weight:700;${styles[type] || styles.gray}">${text}</span>`;
  };

  const row = (label, value) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 16px;border-bottom:1px solid #f1f3f7;font-size:9.5pt"><span style="color:#6b7280">${label}</span><span style="font-weight:600">${value}</span></div>`;

  const kpi = (value, label, sub, valueColor = "#111827") =>
    `<div style="background:#f8f9fb;border:1px solid #e5e8ef;border-radius:10px;padding:14px 16px">
      <div style="font-size:19pt;font-weight:800;color:${valueColor};line-height:1">${value}</div>
      <div style="font-size:8pt;color:#6b7280;margin-top:4px">${label}</div>
      <div style="font-size:8pt;margin-top:3px;font-weight:600;color:#6b7280">${sub}</div>
    </div>`;

  const sectionHead = (title, badge = "") =>
    `<div style="font-size:8pt;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:#6b7280;margin:22px 0 10px;padding-bottom:6px;border-bottom:2px solid #e5e8ef">${title}${badge ? ` <span style="display:inline-block;padding:1px 9px;border-radius:99px;font-size:7.5pt;font-weight:700;background:#dbeafe;color:#2563eb;text-transform:none;letter-spacing:0">${badge}</span>` : ""}</div>`;

  const card = (content, titleBar = "") =>
    `<div style="background:#f8f9fb;border:1px solid #e5e8ef;border-radius:10px;overflow:hidden;margin-bottom:12px">
      ${titleBar ? `<div style="padding:8px 16px;background:#f1f3f7;border-bottom:1px solid #e5e8ef;font-size:8.5pt;font-weight:700;color:#374151">${titleBar}</div>` : ""}
      ${content}
    </div>`;

  // ── Monthly trend description ──
  const monthDesc = monthSt.pct !== null
    ? `${monthSt.passed} passed, ${monthSt.failed} failed across ${monthComp.length} runs (${monthSt.pct}%)`
    : "No completed runs in the last 30 days";

  // ─────────────────────────────────────────────────────────────────────────
  // HTML document
  // ─────────────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>Sentri Executive QA Report — ${dateStr}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:10.5pt;color:#111827;background:#fff;padding:40px 52px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  @media print{body{padding:20px 32px}@page{margin:1.4cm;size:A4}}
  a{color:#5b6ef5;text-decoration:none}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:7px 10px;font-size:7.5pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;background:#f1f3f7;border-bottom:1px solid #e5e8ef}
  td{padding:8px 10px;border-bottom:1px solid #f1f3f7;font-size:9pt;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .mono{font-family:"JetBrains Mono","Courier New",monospace;font-size:8.5pt}
</style>
</head>
<body>

<!-- ═══ HEADER ═══ -->
<div style="display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:16px;margin-bottom:24px;border-bottom:3px solid #5b6ef5">
  <div>
    <div style="font-size:22pt;font-weight:800;color:#5b6ef5;letter-spacing:-0.5px">Sentri<span style="color:#111827">.</span></div>
    <div style="font-size:8.5pt;color:#6b7280;margin-top:3px">Autonomous QA Platform · Daily Executive Report</div>
  </div>
  <div style="text-align:right">
    <div style="font-weight:700;font-size:11pt;color:#111827">${dateStr}</div>
    <div style="font-size:8.5pt;color:#6b7280;margin-top:3px">Generated at ${timeStr}</div>
    ${config?.providerName ? `<div style="font-size:8pt;color:#6b7280;margin-top:4px">AI Provider: <strong>${config.providerName}</strong>${config.model ? ` · <span class="mono">${config.model}</span>` : ""}</div>` : ""}
    <div style="margin-top:8px">${pill(health.label + " · Overall Quality", health.label === "Excellent" || health.label === "Healthy" ? "green" : health.label === "Degraded" ? "amber" : health.label === "Critical" ? "red" : "gray")}</div>
  </div>
</div>

<!-- ═══ SECTION 1: EXECUTIVE SUMMARY — TODAY ═══ -->
${sectionHead("1. Executive Summary — Today")}
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px">
  ${kpi(todayRuns.length, "Runs Today", `${todayComp.length} completed`)}
  ${kpi(todaySt.pct !== null ? todaySt.pct + "%" : "—", "Pass Rate Today", healthLabel(todaySt.pct).label, pctColor(todaySt.pct))}
  ${kpi(todaySt.failed || 0, "Failures Today", `of ${todaySt.total || 0} assertions`, todaySt.failed > 0 ? "#dc2626" : "#16a34a")}
  ${kpi(todayFailing.length, "Tests Failing Now", `${flakyTests.length} flaky detected`, todayFailing.length > 0 ? "#dc2626" : "#16a34a")}
</div>

<!-- ═══ SECTION 2: PLATFORM HEALTH — ALL TIME ═══ -->
${sectionHead("2. Platform Health — All Time")}
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px">
  ${kpi(testRuns.length, "Total Runs", `${completedRuns.length} completed · ${rbs.failed} failed`)}
  ${kpi(overall.pct !== null ? overall.pct + "%" : "—", "Overall Pass Rate", `${overall.passed} passed / ${overall.failed} failed`, pctColor(overall.pct))}
  ${kpi(allTests.length, "Total Tests", `${approvedTests} approved · ${draftTests} draft · ${rejectedTests} rejected`)}
  ${kpi(projects.length, "Projects Active", `${flakyTests.length} flaky test${flakyTests.length !== 1 ? "s" : ""} detected`)}
</div>
${card(`
  ${row("Average Run Duration (all time)", fmtMs(avgDuration(completedRuns)))}
  ${row("Average Run Duration (today)", fmtMs(avgDuration(todayComp)))}
  ${row("Mean Time to Repair (MTTR)", fmtMs(dashboard?.mttrMs))}
  ${row("Self-Healing Successes", (dashboard?.healingSuccesses ?? 0) + " elements auto-healed")}
  ${row("Elements Tracked", (dashboard?.healingEntries ?? 0) + " selector strategies")}
  ${row("AI Generated Tests", (dashboard?.testsGeneratedTotal ?? 0) + " total")}
  ${row("Auto-Fixed by Feedback Loop", (dashboard?.testsAutoFixed ?? 0) + " tests")}
`)}

<!-- ═══ SECTION 3: WEEKLY SUMMARY ═══ -->
${sectionHead("3. This Week (Last 7 Days)")}
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px">
  ${kpi(weekRuns.length, "Runs This Week", `${weekComp.length} completed`)}
  ${kpi(weekSt.pct !== null ? weekSt.pct + "%" : "—", "Weekly Pass Rate", `${weekSt.passed} passed / ${weekSt.failed} failed`, pctColor(weekSt.pct))}
  ${kpi(trendDelta !== null ? (trendDelta >= 0 ? "▲ " : "▼ ") + Math.abs(trendDelta) + "pp" : "—", "Trend vs Prior Week", trendDelta !== null ? (trendDelta >= 0 ? "Improving" : "Regressing") : "Insufficient data", trendDelta === null ? "#9ca3af" : trendDelta >= 0 ? "#16a34a" : "#dc2626")}
  ${kpi(fmtMs(avgDuration(weekComp)), "Avg Duration (week)", "Per completed run")}
</div>
${card(`
  ${row("30-Day Summary", monthDesc)}
  ${row("Tests Created This Week", (dashboard?.testsCreatedThisWeek ?? 0) + "")}
  ${row("Tests Created Today", (dashboard?.testsCreatedToday ?? 0) + "")}
  ${row("Runs Completed (week)", weekComp.length + "")}
  ${row("Runs Failed (week)", weekRuns.filter(r => r.status === "failed").length + "")}
  ${row("Runs Aborted (week)", weekRuns.filter(r => r.status === "aborted").length + "")}
`)}

<!-- ═══ SECTION 4: TEST INVENTORY & COVERAGE ═══ -->
${sectionHead("4. Test Inventory & Coverage")}
${card(`
  ${row("Total Tests Authored", allTests.length + "")}
  ${row("Approved (Active in CI)", `${pill(approvedTests, "green")}`)}
  ${row("Draft (Pending Review)", `${pill(draftTests, "blue")}`)}
  ${row("Rejected / Archived", `${pill(rejectedTests, "gray")}`)}
  ${row("Flaky Tests", flakyTests.length > 0 ? `${pill(flakyTests.length, "amber")} — inconsistent pass/fail results` : `${pill("None detected", "green")}`)}
  ${row("Projects with Coverage", projects.length + "")}
  ${row("Avg Tests per Project", projects.length ? Math.round(allTests.length / projects.length) + "" : "—")}
`)}

<!-- ═══ SECTION 5: RUN STATUS BREAKDOWN ═══ -->
${sectionHead("5. Run Status Breakdown")}
${card(`
  <table>
    <thead><tr><th>Status</th><th>Count</th><th>%</th><th>Note</th></tr></thead>
    <tbody>
      <tr><td>${pill("Completed", "green")}</td><td><strong>${rbs.completed}</strong></td><td>${testRuns.length ? Math.round((rbs.completed / testRuns.length) * 100) + "%" : "—"}</td><td style="color:#6b7280">All assertions executed</td></tr>
      <tr><td>${pill("Failed", "red")}</td><td><strong>${rbs.failed}</strong></td><td>${testRuns.length ? Math.round((rbs.failed / testRuns.length) * 100) + "%" : "—"}</td><td style="color:#6b7280">Run encountered fatal error</td></tr>
      <tr><td>${pill("Aborted", "gray")}</td><td><strong>${rbs.aborted}</strong></td><td>${testRuns.length ? Math.round((rbs.aborted / testRuns.length) * 100) + "%" : "—"}</td><td style="color:#6b7280">Cancelled before completion</td></tr>
      <tr><td>${pill("Running", "blue")}</td><td><strong>${rbs.running}</strong></td><td>—</td><td style="color:#6b7280">In progress now</td></tr>
      <tr style="background:#f8f9fb"><td><strong>Total</strong></td><td><strong>${testRuns.length}</strong></td><td><strong>100%</strong></td><td></td></tr>
    </tbody>
  </table>
`)}

<!-- ═══ SECTION 6: DEFECT CATEGORY ANALYSIS ═══ -->
${totalDefects > 0 ? `
${sectionHead("6. Defect Category Analysis", totalDefects + " total failures")}
${card(`
  <table>
    <thead><tr><th>Category</th><th>Count</th><th>Share</th><th>Description</th></tr></thead>
    <tbody>
      ${defects.map(d => `<tr><td><strong>${d.label}</strong></td><td>${d.count}</td><td>${Math.round((d.count / totalDefects) * 100)}%</td><td style="color:#6b7280">${d.label === "Selector Issues" ? "Element locators failing after UI changes" : d.label === "Navigation Failures" ? "Page routing or load errors" : d.label === "Timeouts" ? "Operations exceeding wait thresholds" : d.label === "Assertion Failures" ? "Expected vs actual value mismatch" : "Unclassified failures"}</td></tr>`).join("")}
    </tbody>
  </table>
`)}` : `${sectionHead("6. Defect Category Analysis")}
${card(`<div style="padding:12px 16px;color:#16a34a;font-weight:600;font-size:9.5pt">✓ No defects recorded — all assertions passing</div>`)}`}

<!-- ═══ SECTION 7: TODAY'S FAILING TESTS ═══ -->
${sectionHead("7. Today's Failing Tests", todayFailing.length > 0 ? todayFailing.length + " failures" : "")}
${todayFailing.length > 0 ? card(`
  <table>
    <thead><tr><th>#</th><th>Test Name</th><th>Project</th><th>Failures</th></tr></thead>
    <tbody>
      ${todayFailing.map((t, i) => `<tr><td style="color:#9ca3af;font-weight:700">${i + 1}</td><td style="font-weight:500">${t.name || "—"}</td><td style="color:#6b7280">${projMap[t.projectId] || t.projectId || "—"}</td><td>${pill(t.failCount + " failure" + (t.failCount > 1 ? "s" : ""), "red")}</td></tr>`).join("")}
    </tbody>
  </table>
`) : card(`<div style="padding:12px 16px;color:#16a34a;font-weight:600;font-size:9.5pt">✓ No failures recorded today</div>`)}

<!-- ═══ SECTION 8: CHRONIC FAILURES — ALL TIME ═══ -->
${topFailing.length > 0 ? `
${sectionHead("8. Chronic Failures — Top " + topFailing.length + " Tests (All Time)")}
${card(`
  <table>
    <thead><tr><th>Rank</th><th>Test Name</th><th>Project</th><th>Total Failures</th><th>Risk Level</th></tr></thead>
    <tbody>
      ${topFailing.map((t, i) => `<tr><td style="color:#9ca3af;font-weight:700">#${i + 1}</td><td style="font-weight:500;max-width:300px">${t.name || "—"}</td><td style="color:#6b7280">${projMap[t.projectId] || t.projectId || "—"}</td><td>${pill(t.failCount, "red")}</td><td>${t.risk === "High" ? pill("High", "red") : t.risk === "Medium" ? pill("Medium", "amber") : pill("Low", "green")}</td></tr>`).join("")}
    </tbody>
  </table>
`)}` : ""}

<!-- ═══ SECTION 9: FLAKY TESTS ═══ -->
${flakyTests.length > 0 ? `
${sectionHead("9. Flaky Tests — Inconsistent Results", flakyTests.length + " tests")}
${card(`
  <table>
    <thead><tr><th>#</th><th>Test Name</th><th>Project</th><th>Status</th></tr></thead>
    <tbody>
      ${flakyTests.map((t, i) => `<tr><td style="color:#9ca3af">${i + 1}</td><td>${t.name || "—"}</td><td style="color:#6b7280">${projMap[t.projectId] || t.projectId || "—"}</td><td>${pill("Intermittent", "amber")}</td></tr>`).join("")}
    </tbody>
  </table>
`)}` : ""}

<!-- ═══ SECTION 10: PER-PROJECT BREAKDOWN ═══ -->
${sectionHead("10. Per-Project Breakdown")}
${card(`
  <table>
    <thead>
      <tr>
        <th>Project</th>
        <th>URL</th>
        <th>Tests</th>
        <th>Total Runs</th>
        <th>Today</th>
        <th>Overall Pass %</th>
        <th>Weekly Pass %</th>
        <th>Avg Duration</th>
        <th>Last Run</th>
      </tr>
    </thead>
    <tbody>
      ${projectBreakdown.map(p => `<tr>
        <td style="font-weight:600">${p.name}</td>
        <td style="color:#6b7280;font-size:8pt" class="mono">${p.url ? p.url.replace(/^https?:\/\//, "") : "—"}</td>
        <td>${p.approved}<span style="color:#9ca3af;font-size:8pt"> / ${p.tests}</span></td>
        <td>${p.runs}</td>
        <td>${p.tod.total > 0 ? `${p.tod.passed}✓ ${p.tod.failed}✗` : "—"}</td>
        <td style="font-weight:700;color:${pctColor(p.all.pct)}">${p.all.pct !== null ? p.all.pct + "%" : "—"}</td>
        <td style="font-weight:700;color:${pctColor(p.wk.pct)}">${p.wk.pct !== null ? p.wk.pct + "%" : "—"}</td>
        <td class="mono">${fmtMs(p.avgDur)}</td>
        <td style="color:#6b7280;font-size:8.5pt">${p.lastRun ? fmtRelativeDate(p.lastRun.startedAt) : "Never"}</td>
      </tr>`).join("")}
    </tbody>
  </table>
`)}

<!-- ═══ SECTION 11: RUNTIME CONFIGURATION ═══ -->
${sectionHead("11. Runtime Configuration")}
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
  ${card(`
    ${row("Element Timeout", '<span class="mono">5,000 ms</span>')}
    ${row("Retry Count", '<span class="mono">3 attempts</span>')}
    ${row("Retry Delay", '<span class="mono">400 ms</span>')}
    ${row("Browser Engine", "Headless Chromium")}
    ${row("Viewport", '<span class="mono">1280 × 720</span>')}
    ${row("Self-Healing", pill("Enabled", "green"))}
    ${row("Healing Strategy", "Multi-strategy waterfall")}
  `, "Test Execution Defaults")}
  ${card(`
    ${row("Pass Rate Target", pill("≥ 90%", "green"))}
    ${row("Flaky Test Limit", pill("0 ideal", "amber"))}
    ${row("Failure Tolerance", pill("≤ 5%", "amber"))}
    ${row("Critical Failures", pill("0 tolerance", "red"))}
    ${row("Review Required", "All new tests (Draft → Approved)")}
    ${row("Healing History", `${sysInfo?.healingEntries ?? "—"} entries`)}
    ${sysInfo ? row("Node.js", '<span class="mono">' + sysInfo.nodeVersion + "</span>") : ""}
    ${sysInfo ? row("Playwright", '<span class="mono">' + (sysInfo.playwrightVersion || "—") + "</span>") : ""}
    ${sysInfo ? row("Heap Memory", sysInfo.memoryMB + " MB") : ""}
  `, "Quality Thresholds & System")}
</div>

<!-- ═══ SECTION 12: RECENT RUNS LOG ═══ -->
${completedRuns.length > 0 ? `
${sectionHead("12. Recent Run Log (Last 10)")}
${card(`
  <table>
    <thead><tr><th>Run ID</th><th>Project</th><th>Status</th><th>Passed</th><th>Failed</th><th>Total</th><th>Pass %</th><th>Duration</th><th>Started</th></tr></thead>
    <tbody>
      ${testRuns.slice(0, 10).map(r => {
        const dur = r.startedAt && r.finishedAt ? fmtMs(new Date(r.finishedAt) - new Date(r.startedAt)) : "—";
        const pct = r.total ? Math.round(((r.passed || 0) / r.total) * 100) : null;
        return `<tr>
          <td class="mono" style="color:#9ca3af;font-size:7.5pt">${(r.id || "").slice(0,8)}</td>
          <td style="font-weight:500">${projMap[r.projectId] || r.projectId || "—"}</td>
          <td>${r.status === "completed" ? pill("✓ Completed","green") : r.status === "failed" ? pill("✗ Failed","red") : r.status === "running" ? pill("● Running","blue") : pill(r.status,"gray")}</td>
          <td style="color:#16a34a;font-weight:600">${r.passed ?? "—"}</td>
          <td style="color:${(r.failed || 0) > 0 ? "#dc2626" : "#9ca3af"};font-weight:${(r.failed || 0) > 0 ? 700 : 400}">${r.failed ?? "—"}</td>
          <td>${r.total ?? "—"}</td>
          <td style="font-weight:700;color:${pctColor(pct)}">${pct !== null ? pct + "%" : "—"}</td>
          <td class="mono">${dur}</td>
          <td style="color:#6b7280;font-size:8pt">${r.startedAt ? fmtRelativeDate(r.startedAt) : "—"}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>
`)}` : ""}

<!-- ═══ SECTION 13: RECOMMENDED ACTIONS ═══ -->
${sectionHead("13. Recommended Actions")}
${card((() => {
  const actions = [];
  if (todayFailing.length > 0)
    actions.push(`<tr><td style="color:#dc2626;font-weight:700;white-space:nowrap">⚑ HIGH</td><td>${todayFailing.length} test${todayFailing.length > 1 ? "s" : ""} failing today — investigate and resolve before next CI cycle</td></tr>`);
  if (flakyTests.length > 0)
    actions.push(`<tr><td style="color:#d97706;font-weight:700;white-space:nowrap">⚐ MED</td><td>${flakyTests.length} flaky test${flakyTests.length > 1 ? "s" : ""} detected — review element selectors and environment stability</td></tr>`);
  if (draftTests > 0)
    actions.push(`<tr><td style="color:#2563eb;font-weight:700;white-space:nowrap">ℹ INFO</td><td>${draftTests} draft test${draftTests > 1 ? "s" : ""} awaiting review — approve or reject to maintain accurate coverage metrics</td></tr>`);
  if (trendDelta !== null && trendDelta < -10)
    actions.push(`<tr><td style="color:#dc2626;font-weight:700;white-space:nowrap">⚑ HIGH</td><td>Pass rate declined ${Math.abs(trendDelta)}pp vs prior 7-run period — root cause analysis recommended</td></tr>`);
  if (totalDefects > 0) {
    const topDefect = defects.sort((a,b) => b.count - a.count)[0];
    actions.push(`<tr><td style="color:#d97706;font-weight:700;white-space:nowrap">⚐ MED</td><td>${topDefect.label} is the leading failure category (${topDefect.count} occurrences) — prioritise selector stability</td></tr>`);
  }
  if (actions.length === 0)
    actions.push(`<tr><td style="color:#16a34a;font-weight:700;white-space:nowrap">✓ OK</td><td>All quality indicators nominal — no immediate actions required. Continue monitoring.</td></tr>`);
  return `<table style="width:100%"><tbody style="border:none">${actions.map(a => `<tr style="border-bottom:1px solid #f1f3f7">${a.replace(/<tr/,"<tr").replace(/padding:7px 16px;/g,"")}</tr>`).join("")}</tbody></table>`;
})())}

<!-- ═══ FOOTER ═══ -->
<div style="margin-top:36px;padding-top:14px;border-top:1px solid #e5e8ef;display:flex;justify-content:space-between;font-size:8pt;color:#9ca3af">
  <span>Sentri Autonomous QA Platform</span>
  <span>Confidential — For Internal Management Use Only</span>
  <span>Generated ${dateStr} at ${timeStr}</span>
</div>

<script>window.onload = function(){ window.print(); }</script>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, "_blank");
  if (win) setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF Export button component
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
      className="btn btn-ghost btn-sm"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        color: "var(--accent)",
        fontWeight: 600,
        boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
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

      {/* ── Hero Banner ─────────────────────────────────────────────── */}
      <div className="dash-hero">
        <div className="dash-hero-glow" />
        <svg className="dash-hero-shield" width="180" height="180" viewBox="0 0 40 40" fill="none">
          <path d="M20 1L3 8v11c0 9.5 7.2 18.2 17 20 9.8-1.8 17-10.5 17-20V8L20 1z" fill="#6366f1" />
        </svg>

        <div className="dash-hero-content">
          <div>
            <AppLogo size={48} variant="full" />
            <p className="dash-hero-desc">
              {greeting()}! Here's your real-time overview — system health, key metrics, and what your agents are up to right now.
            </p>
          </div>

          <div className="dash-hero-meta">
            <span className="dash-hero-pill">Autonomous QA</span>
            <span className="dash-hero-date">
              {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            </span>
            <ExportPDFButton />
          </div>
        </div>
      </div>

      {/* Error banner */}
      {loadError && (
        <div className="card empty-state mb-md" style={{ border: "1px solid #fca5a5" }}>
          <div className="empty-state-icon">⚠️</div>
          <div className="empty-state-title">Could not load dashboard data</div>
          <div className="empty-state-desc">The API may be temporarily unavailable. Your data is safe.</div>
          <button className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>Retry</button>
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
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 16 }}>
                <StatCard label="Flaky Tests" value={data?.flakyTestCount ?? 0} sub={data?.flakyTestCount > 0 ? "Inconsistent results" : "None detected"} color={data?.flakyTestCount > 0 ? "var(--amber)" : "var(--green)"} icon={<AlertTriangle size={16} />} />
                <div className="card card-padded">
                  <div className="flex-between" style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Crosshair size={14} color="var(--text3)" />
                      <span className="section-title" style={{ marginBottom: 0 }}>Defect Categories</span>
                    </div>
                    {totalDefects > 0 && <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>{totalDefects} total failures</span>}
                  </div>
                  {totalDefects === 0 ? (
                    <div style={{ fontSize: "0.82rem", color: "var(--text3)" }}>
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
                <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>Last 8 weeks</span>
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
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: "0.875rem", marginBottom: 1 }}>{meta.label}</div>
                        <div className="page-subtitle truncate" style={{ fontSize: "0.78rem" }}>
                          {r.projectName || `Project ${r.projectId?.slice(0, 8)}`}
                        </div>
                      </div>
                      <div className="flex-center gap-sm" style={{ flexShrink: 0 }}>
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
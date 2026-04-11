/**
 * @module utils/pdfReportHtml
 * @description HTML template for the executive PDF report.
 * Companion to `pdfReportGenerator.js`.
 *
 * ### Exports
 * - {@link renderReportHtml} — `(metrics) → string` full HTML document.
 */

import { fmtRelativeDate } from "./formatters.js";

// ── HTML escaping ─────────────────────────────────────────────────────────────
// All user-sourced values (test names, project names, URLs, descriptions,
// step text) are interpolated directly into an HTML string template. Without
// escaping, a test named `<script>alert(1)</script>` renders executable markup
// in the generated PDF/HTML. This function is the single escape gate — every
// user-controlled value must pass through it before template interpolation.
function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function fmtMs(ms) {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function pctColor(p) {
  if (p === null) return "#9ca3af";
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

function pill(text, type) {
  const s = { green: "background:#dcfce7;color:#16a34a", red: "background:#fee2e2;color:#dc2626", amber: "background:#fef3c7;color:#d97706", blue: "background:#dbeafe;color:#2563eb", purple: "background:#ede9fe;color:#7c3aed", gray: "background:#f3f4f6;color:#6b7280" };
  return `<span style="display:inline-block;padding:2px 9px;border-radius:99px;font-size:8pt;font-weight:700;${s[type] || s.gray}">${text}</span>`;
}

function row(l, v) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 16px;border-bottom:1px solid #f1f3f7;font-size:9.5pt"><span style="color:#6b7280">${l}</span><span style="font-weight:600">${v}</span></div>`;
}

function kpi(v, l, sub, vc = "#111827") {
  return `<div style="background:#f8f9fb;border:1px solid #e5e8ef;border-radius:10px;padding:14px 16px"><div style="font-size:19pt;font-weight:800;color:${vc};line-height:1">${v}</div><div style="font-size:8pt;color:#6b7280;margin-top:4px">${l}</div><div style="font-size:8pt;margin-top:3px;font-weight:600;color:#6b7280">${sub}</div></div>`;
}

function sh(title, badge = "") {
  return `<div style="font-size:8pt;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:#6b7280;margin:22px 0 10px;padding-bottom:6px;border-bottom:2px solid #e5e8ef">${title}${badge ? ` <span style="display:inline-block;padding:1px 9px;border-radius:99px;font-size:7.5pt;font-weight:700;background:#dbeafe;color:#2563eb;text-transform:none;letter-spacing:0">${badge}</span>` : ""}</div>`;
}

function card(c, tb = "") {
  return `<div style="background:#f8f9fb;border:1px solid #e5e8ef;border-radius:10px;overflow:hidden;margin-bottom:12px">${tb ? `<div style="padding:8px 16px;background:#f1f3f7;border-bottom:1px solid #e5e8ef;font-size:8.5pt;font-weight:700;color:#374151">${tb}</div>` : ""}${c}</div>`;
}

function g4(items) { return `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px">${items}</div>`; }

// ── Main export ──────────────────────────────────────────────────────────────
// 1:1 port of Dashboard.jsx lines 267-533. Sections built as array, joined.

export function renderReportHtml(m) {
  const { testRuns, dateStr, timeStr, completedRuns, todayRuns, todayComp, weekRuns, weekComp, overall, todaySt, weekSt, trendDelta, flakyTests, topFailing, todayFailing, projMap, projectBreakdown, defects, totalDefects, approvedTests, draftTests, rejectedTests, rbs, health, monthDesc, avgDuration, dashboard, projects, allTests, config, sysInfo } = m;
  const P = (n, d) => d ? Math.round((n / d) * 100) + "%" : "—";
  const dd = (l) => l === "Selector Issues" ? "Element locators failing after UI changes" : l === "Navigation Failures" ? "Page routing or load errors" : l === "Timeouts" ? "Operations exceeding wait thresholds" : l === "Assertion Failures" ? "Expected vs actual value mismatch" : "Unclassified failures";
  const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:10.5pt;color:#111827;background:#fff;padding:40px 52px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media print{body{padding:20px 32px}@page{margin:1.4cm;size:A4}}a{color:#5b6ef5;text-decoration:none}table{width:100%;border-collapse:collapse}th{text-align:left;padding:7px 10px;font-size:7.5pt;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;background:#f1f3f7;border-bottom:1px solid #e5e8ef}td{padding:8px 10px;border-bottom:1px solid #f1f3f7;font-size:9pt;vertical-align:middle}tr:last-child td{border-bottom:none}.mono{font-family:"JetBrains Mono","Courier New",monospace;font-size:8.5pt}`;
  const S = [];

  // Header
  S.push(`<div style="display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:16px;margin-bottom:24px;border-bottom:3px solid #5b6ef5"><div><div style="font-size:22pt;font-weight:800;color:#5b6ef5;letter-spacing:-0.5px">Sentri<span style="color:#111827">.</span></div><div style="font-size:8.5pt;color:#6b7280;margin-top:3px">Autonomous QA Platform · Daily Executive Report</div></div><div style="text-align:right"><div style="font-weight:700;font-size:11pt;color:#111827">${dateStr}</div><div style="font-size:8.5pt;color:#6b7280;margin-top:3px">Generated at ${timeStr}</div>${config?.providerName ? `<div style="font-size:8pt;color:#6b7280;margin-top:4px">AI Provider: <strong>${config.providerName}</strong>${config.model ? ` · <span class="mono">${config.model}</span>` : ""}</div>` : ""}<div style="margin-top:8px">${pill(health.label + " · Overall Quality", health.label === "Excellent" || health.label === "Healthy" ? "green" : health.label === "Degraded" ? "amber" : health.label === "Critical" ? "red" : "gray")}</div></div></div>`);

  // S1
  S.push(sh("1. Executive Summary — Today"));
  S.push(g4(`${kpi(todayRuns.length, "Runs Today", `${todayComp.length} completed`)}${kpi(todaySt.pct !== null ? todaySt.pct + "%" : "—", "Pass Rate Today", healthLabel(todaySt.pct).label, pctColor(todaySt.pct))}${kpi(todaySt.failed || 0, "Failures Today", `of ${todaySt.total || 0} assertions`, todaySt.failed > 0 ? "#dc2626" : "#16a34a")}${kpi(todayFailing.length, "Tests Failing Now", `${flakyTests.length} flaky detected`, todayFailing.length > 0 ? "#dc2626" : "#16a34a")}`));

  // S2
  S.push(sh("2. Platform Health — All Time"));
  S.push(g4(`${kpi(testRuns.length, "Total Runs", `${completedRuns.length} completed · ${rbs.failed} failed`)}${kpi(overall.pct !== null ? overall.pct + "%" : "—", "Overall Pass Rate", `${overall.passed} passed / ${overall.failed} failed`, pctColor(overall.pct))}${kpi(allTests.length, "Total Tests", `${approvedTests} approved · ${draftTests} draft · ${rejectedTests} rejected`)}${kpi(projects.length, "Projects Active", `${flakyTests.length} flaky test${flakyTests.length !== 1 ? "s" : ""} detected`)}`));
  S.push(card([row("Average Run Duration (all time)", fmtMs(avgDuration(completedRuns))), row("Average Run Duration (today)", fmtMs(avgDuration(todayComp))), row("Mean Time to Repair (MTTR)", fmtMs(dashboard?.mttrMs)), row("Self-Healing Successes", (dashboard?.healingSuccesses ?? 0) + " elements auto-healed"), row("Elements Tracked", (dashboard?.healingEntries ?? 0) + " selector strategies"), row("AI Generated Tests", (dashboard?.testsGeneratedTotal ?? 0) + " total"), row("Auto-Fixed by Feedback Loop", (dashboard?.testsAutoFixed ?? 0) + " tests")].join("")));

  // S3
  S.push(sh("3. This Week (Last 7 Days)"));
  S.push(g4(`${kpi(weekRuns.length, "Runs This Week", `${weekComp.length} completed`)}${kpi(weekSt.pct !== null ? weekSt.pct + "%" : "—", "Weekly Pass Rate", `${weekSt.passed} passed / ${weekSt.failed} failed`, pctColor(weekSt.pct))}${kpi(trendDelta !== null ? (trendDelta >= 0 ? "▲ " : "▼ ") + Math.abs(trendDelta) + "pp" : "—", "Trend vs Prior Week", trendDelta !== null ? (trendDelta >= 0 ? "Improving" : "Regressing") : "Insufficient data", trendDelta === null ? "#9ca3af" : trendDelta >= 0 ? "#16a34a" : "#dc2626")}${kpi(fmtMs(avgDuration(weekComp)), "Avg Duration (week)", "Per completed run")}`));
  S.push(card([row("30-Day Summary", monthDesc), row("Tests Created This Week", (dashboard?.testsCreatedThisWeek ?? 0) + ""), row("Tests Created Today", (dashboard?.testsCreatedToday ?? 0) + ""), row("Runs Completed (week)", weekComp.length + ""), row("Runs Failed (week)", weekRuns.filter(r => r.status === "failed").length + ""), row("Runs Aborted (week)", weekRuns.filter(r => r.status === "aborted").length + "")].join("")));

  // S4
  S.push(sh("4. Test Inventory & Coverage"));
  S.push(card([row("Total Tests Authored", allTests.length + ""), row("Approved (Active in CI)", pill(approvedTests, "green")), row("Draft (Pending Review)", pill(draftTests, "blue")), row("Rejected / Archived", pill(rejectedTests, "gray")), row("Flaky Tests", flakyTests.length > 0 ? `${pill(flakyTests.length, "amber")} — inconsistent pass/fail results` : pill("None detected", "green")), row("Projects with Coverage", projects.length + ""), row("Avg Tests per Project", projects.length ? Math.round(allTests.length / projects.length) + "" : "—")].join("")));

  // S5
  S.push(sh("5. Run Status Breakdown"));
  S.push(card(`<table><thead><tr><th>Status</th><th>Count</th><th>%</th><th>Note</th></tr></thead><tbody><tr><td>${pill("Completed", "green")}</td><td><strong>${rbs.completed}</strong></td><td>${P(rbs.completed, testRuns.length)}</td><td style="color:#6b7280">All assertions executed</td></tr><tr><td>${pill("Failed", "red")}</td><td><strong>${rbs.failed}</strong></td><td>${P(rbs.failed, testRuns.length)}</td><td style="color:#6b7280">Run encountered fatal error</td></tr><tr><td>${pill("Aborted", "gray")}</td><td><strong>${rbs.aborted}</strong></td><td>${P(rbs.aborted, testRuns.length)}</td><td style="color:#6b7280">Cancelled before completion</td></tr><tr><td>${pill("Running", "blue")}</td><td><strong>${rbs.running}</strong></td><td>—</td><td style="color:#6b7280">In progress now</td></tr><tr style="background:#f8f9fb"><td><strong>Total</strong></td><td><strong>${testRuns.length}</strong></td><td><strong>100%</strong></td><td></td></tr></tbody></table>`));

  // S6
  if (totalDefects > 0) { S.push(sh("6. Defect Category Analysis", totalDefects + " total failures")); S.push(card(`<table><thead><tr><th>Category</th><th>Count</th><th>Share</th><th>Description</th></tr></thead><tbody>${defects.map(d => `<tr><td><strong>${d.label}</strong></td><td>${d.count}</td><td>${Math.round((d.count / totalDefects) * 100)}%</td><td style="color:#6b7280">${dd(d.label)}</td></tr>`).join("")}</tbody></table>`)); }
  else { S.push(sh("6. Defect Category Analysis")); S.push(card(`<div style="padding:12px 16px;color:#16a34a;font-weight:600;font-size:9.5pt">✓ No defects recorded — all assertions passing</div>`)); }

  // S7
  S.push(sh("7. Today's Failing Tests", todayFailing.length > 0 ? todayFailing.length + " failures" : ""));
  S.push(todayFailing.length > 0 ? card(`<table><thead><tr><th>#</th><th>Test Name</th><th>Project</th><th>Failures</th></tr></thead><tbody>${todayFailing.map((t, i) => `<tr><td style="color:#9ca3af;font-weight:700">${i + 1}</td><td style="font-weight:500">${esc(t.name) || "—"}</td><td style="color:#6b7280">${esc(projMap[t.projectId] || t.projectId) || "—"}</td><td>${pill(t.failCount + " failure" + (t.failCount > 1 ? "s" : ""), "red")}</td></tr>`).join("")}</tbody></table>`) : card(`<div style="padding:12px 16px;color:#16a34a;font-weight:600;font-size:9.5pt">✓ No failures recorded today</div>`));

  // S8
  if (topFailing.length > 0) { S.push(sh("8. Chronic Failures — Top " + topFailing.length + " Tests (All Time)")); S.push(card(`<table><thead><tr><th>Rank</th><th>Test Name</th><th>Project</th><th>Total Failures</th><th>Risk Level</th></tr></thead><tbody>${topFailing.map((t, i) => `<tr><td style="color:#9ca3af;font-weight:700">#${i + 1}</td><td style="font-weight:500;max-width:300px">${esc(t.name) || "—"}</td><td style="color:#6b7280">${esc(projMap[t.projectId] || t.projectId) || "—"}</td><td>${pill(t.failCount, "red")}</td><td>${t.risk === "High" ? pill("High", "red") : t.risk === "Medium" ? pill("Medium", "amber") : pill("Low", "green")}</td></tr>`).join("")}</tbody></table>`)); }

  // S9
  if (flakyTests.length > 0) { S.push(sh("9. Flaky Tests — Inconsistent Results", flakyTests.length + " tests")); S.push(card(`<table><thead><tr><th>#</th><th>Test Name</th><th>Project</th><th>Status</th></tr></thead><tbody>${flakyTests.map((t, i) => `<tr><td style="color:#9ca3af">${i + 1}</td><td>${esc(t.name) || "—"}</td><td style="color:#6b7280">${esc(projMap[t.projectId] || t.projectId) || "—"}</td><td>${pill("Intermittent", "amber")}</td></tr>`).join("")}</tbody></table>`)); }

  // S10: Per-Project
  S.push(sh("10. Per-Project Breakdown"));
  S.push(card(`<table><thead><tr><th>Project</th><th>URL</th><th>Tests</th><th>Total Runs</th><th>Today</th><th>Overall Pass %</th><th>Weekly Pass %</th><th>Avg Duration</th><th>Last Run</th></tr></thead><tbody>${projectBreakdown.map(p => `<tr><td style="font-weight:600">${esc(p.name)}</td><td style="color:#6b7280;font-size:8pt" class="mono">${p.url ? esc(p.url.replace(/^https?:\/\//, "")) : "—"}</td><td>${p.approved}<span style="color:#9ca3af;font-size:8pt"> / ${p.tests}</span></td><td>${p.runs}</td><td>${p.tod.total > 0 ? `${p.tod.passed}✓ ${p.tod.failed}✗` : "—"}</td><td style="font-weight:700;color:${pctColor(p.all.pct)}">${p.all.pct !== null ? p.all.pct + "%" : "—"}</td><td style="font-weight:700;color:${pctColor(p.wk.pct)}">${p.wk.pct !== null ? p.wk.pct + "%" : "—"}</td><td class="mono">${fmtMs(p.avgDur)}</td><td style="color:#6b7280;font-size:8.5pt">${p.lastRun ? fmtRelativeDate(p.lastRun.startedAt) : "Never"}</td></tr>`).join("")}</tbody></table>`));

  // S11: Runtime Config
  S.push(sh("11. Runtime Configuration"));
  S.push(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">${card([row("Element Timeout", '<span class="mono">5,000 ms</span>'), row("Retry Count", '<span class="mono">3 attempts</span>'), row("Retry Delay", '<span class="mono">400 ms</span>'), row("Browser Engine", "Headless Chromium"), row("Viewport", '<span class="mono">1280 × 720</span>'), row("Self-Healing", pill("Enabled", "green")), row("Healing Strategy", "Multi-strategy waterfall")].join(""), "Test Execution Defaults")}${card([row("Pass Rate Target", pill("≥ 90%", "green")), row("Flaky Test Limit", pill("0 ideal", "amber")), row("Failure Tolerance", pill("≤ 5%", "amber")), row("Critical Failures", pill("0 tolerance", "red")), row("Review Required", "All new tests (Draft → Approved)"), row("Healing History", `${sysInfo?.healingEntries ?? "—"} entries`), sysInfo ? row("Node.js", '<span class="mono">' + sysInfo.nodeVersion + "</span>") : "", sysInfo ? row("Playwright", '<span class="mono">' + (sysInfo.playwrightVersion || "—") + "</span>") : "", sysInfo ? row("Heap Memory", sysInfo.memoryMB + " MB") : ""].join(""), "Quality Thresholds & System")}</div>`);

  // S12: Recent Runs
  if (completedRuns.length > 0) {
    S.push(sh("12. Recent Run Log (Last 10)"));
    S.push(card(`<table><thead><tr><th>Run ID</th><th>Project</th><th>Status</th><th>Passed</th><th>Failed</th><th>Total</th><th>Pass %</th><th>Duration</th><th>Started</th></tr></thead><tbody>${testRuns.slice(0, 10).map(r => { const dur = r.startedAt && r.finishedAt ? fmtMs(new Date(r.finishedAt) - new Date(r.startedAt)) : "—"; const p = r.total ? Math.round(((r.passed || 0) / r.total) * 100) : null; return `<tr><td class="mono" style="color:#9ca3af;font-size:7.5pt">${(r.id || "").slice(0,8)}</td><td style="font-weight:500">${projMap[r.projectId] || r.projectId || "—"}</td><td>${r.status === "completed" ? pill("✓ Completed","green") : r.status === "failed" ? pill("✗ Failed","red") : r.status === "running" ? pill("● Running","blue") : pill(r.status,"gray")}</td><td style="color:#16a34a;font-weight:600">${r.passed ?? "—"}</td><td style="color:${(r.failed || 0) > 0 ? "#dc2626" : "#9ca3af"};font-weight:${(r.failed || 0) > 0 ? 700 : 400}">${r.failed ?? "—"}</td><td>${r.total ?? "—"}</td><td style="font-weight:700;color:${pctColor(p)}">${p !== null ? p + "%" : "—"}</td><td class="mono">${dur}</td><td style="color:#6b7280;font-size:8pt">${r.startedAt ? fmtRelativeDate(r.startedAt) : "—"}</td></tr>`; }).join("")}</tbody></table>`));
  }

  // S13: Recommended Actions
  S.push(sh("13. Recommended Actions"));
  const actions = [];
  if (todayFailing.length > 0) actions.push(`<tr><td style="color:#dc2626;font-weight:700;white-space:nowrap">⚑ HIGH</td><td>${todayFailing.length} test${todayFailing.length > 1 ? "s" : ""} failing today — investigate and resolve before next CI cycle</td></tr>`);
  if (flakyTests.length > 0) actions.push(`<tr><td style="color:#d97706;font-weight:700;white-space:nowrap">⚐ MED</td><td>${flakyTests.length} flaky test${flakyTests.length > 1 ? "s" : ""} detected — review element selectors and environment stability</td></tr>`);
  if (draftTests > 0) actions.push(`<tr><td style="color:#2563eb;font-weight:700;white-space:nowrap">ℹ INFO</td><td>${draftTests} draft test${draftTests > 1 ? "s" : ""} awaiting review — approve or reject to maintain accurate coverage metrics</td></tr>`);
  if (trendDelta !== null && trendDelta < -10) actions.push(`<tr><td style="color:#dc2626;font-weight:700;white-space:nowrap">⚑ HIGH</td><td>Pass rate declined ${Math.abs(trendDelta)}pp vs prior 7-run period — root cause analysis recommended</td></tr>`);
  if (totalDefects > 0) { const top = [...defects].sort((a,b) => b.count - a.count)[0]; actions.push(`<tr><td style="color:#d97706;font-weight:700;white-space:nowrap">⚐ MED</td><td>${top.label} is the leading failure category (${top.count} occurrences) — prioritise selector stability</td></tr>`); }
  if (actions.length === 0) actions.push(`<tr><td style="color:#16a34a;font-weight:700;white-space:nowrap">✓ OK</td><td>All quality indicators nominal — no immediate actions required. Continue monitoring.</td></tr>`);
  S.push(card(`<table style="width:100%"><tbody style="border:none">${actions.map(a => `<tr style="border-bottom:1px solid #f1f3f7">${a.replace(/<tr/,"<tr").replace(/padding:7px 16px;/g,"")}</tr>`).join("")}</tbody></table>`));

  // Footer
  S.push(`<div style="margin-top:36px;padding-top:14px;border-top:1px solid #e5e8ef;display:flex;justify-content:space-between;font-size:8pt;color:#9ca3af"><span>Sentri Autonomous QA Platform</span><span>Confidential — For Internal Management Use Only</span><span>Generated ${dateStr} at ${timeStr}</span></div>`);

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Sentri Executive QA Report — ${dateStr}</title><style>${css}</style></head><body>${S.join("\n")}<script>window.onload = function(){ window.print(); }</script></body></html>`;
}

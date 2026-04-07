import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Search, Play, Trash2, ArrowRight, Ban,
  AlertTriangle, RefreshCw, Globe, ThumbsUp, ThumbsDown,
  RotateCcw, Info, StopCircle, Download, ChevronDown, Link2,
} from "lucide-react";
import { api } from "../api.js";
import CrawlDialsPanel from "../components/CrawlDialsPanel.jsx";
import { loadSavedConfig, countActiveDials } from "../utils/testDialsStorage.js";
import { EXPLORE_MODE_OPTIONS, PARALLEL_WORKERS_TUNING } from "../config/testDialsConfig.js";
import AgentTag from "../components/AgentTag.jsx";
import ModalShell from "../components/ModalShell.jsx";
import { cleanTestName } from "../utils/formatTestName.js";
import { testTypeBadgeClass, testTypeLabel, isBddTest } from "../utils/testTypeLabels.js";
import { StatusBadge, ReviewBadge, ScenarioBadges } from "../components/TestBadges.jsx";
import usePageTitle from "../hooks/usePageTitle.js";

function ConfBar({ score }) {
  if (score == null) return <span style={{ color: "var(--text3)", fontSize: "0.73rem" }}>—</span>;
  const color = score >= 80 ? "var(--green)" : score >= 60 ? "var(--amber)" : "var(--red)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 52, height: 4, borderRadius: 2, background: "var(--bg3)", overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: "0.73rem", color: "var(--text2)", fontWeight: 500 }}>{score}%</span>
    </div>
  );
}

function Toast({ msg, type, visible, onViewRun, runId }) {
  const colors = { success: "var(--green)", error: "var(--red)", info: "var(--accent)" };
  const navigate = useNavigate();
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 28, zIndex: 9999,
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8,
      fontSize: "0.83rem", fontWeight: 500, boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
      transition: "all 0.25s", opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(12px)", pointerEvents: visible ? "auto" : "none",
    }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: colors[type] || colors.info, flexShrink: 0 }} />
      {msg}
      {/* Opt-in navigation to run — don't auto-switch tabs */}
      {onViewRun && runId && (
        <button
          className="btn btn-ghost btn-xs"
          style={{ marginLeft: 8, pointerEvents: "auto" }}
          onClick={() => navigate(`/runs/${runId}`)}
        >
          View run <ArrowRight size={11} />
        </button>
      )}
    </div>
  );
}

// Tests created within this window are considered "new" and highlighted.
const NEW_TEST_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [project, setProject]             = useState(null);
  const [tests, setTests]                 = useState([]);
  const [runs, setRuns]                   = useState([]);
  const [activeRun, setActiveRun]         = useState(null);
  const [activeRunId, setActiveRunId]     = useState(null); // for toast link
  const [loading, setLoading]             = useState(true);
  const [actionLoading, setActionLoading] = useState(null);
  const [crawlDialsCfg, setCrawlDialsCfg] = useState(() => loadSavedConfig());
  const [showDialsPopover, setShowDialsPopover] = useState(false);
  const [tab, setTab]                     = useState("review");
  const [reviewFilter, setReviewFilter]   = useState("draft");
  const [categoryFilter, setCategoryFilter] = useState("all"); // "all" | "ui" | "api"
  const [search, setSearch]               = useState("");
  const [selected, setSelected]           = useState(new Set());
  const [reviewPage, setReviewPage]         = useState(1);  // Fix #21
  const PAGE_SIZE = 50;
  const [toast, setToast]                 = useState({ msg: "", type: "info", visible: false, showLink: false, runId: null });
  const [showNewBadges, setShowNewBadges] = useState(true);
  const [now, setNow] = useState(Date.now);
  usePageTitle(project?.name ? `${project.name} — Project` : "Project");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [traceability, setTraceability]     = useState(null);
  const [traceLoading, setTraceLoading]     = useState(false);

  // ── Highlight recently created tests ──────────────────────────────────────
  // Any test created within the last 5 minutes is "new" — works regardless of
  // how the user navigated here (breadcrumbs, back button, direct link, etc.)
  const newTestIds = useMemo(() => {
    if (!showNewBadges) return new Set();
    const cutoff = now - NEW_TEST_THRESHOLD_MS;
    const ids = new Set();
    for (const t of tests) {
      if (t.createdAt && new Date(t.createdAt).getTime() > cutoff) {
        ids.add(t.id);
      }
    }
    return ids;
  }, [tests, showNewBadges, now]);

  // Auto-expire "NEW" badges: tick `now` every 60s so the useMemo re-evaluates
  // and drops tests that have aged past the 5-minute threshold.
  useEffect(() => {
    if (!showNewBadges) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [showNewBadges]);

  // Fetch traceability data when the tab is first switched to "traceability".
  // Previously this was an IIFE inside the render body which violated React's
  // rule against calling setState during render and caused duplicate API calls
  // in concurrent mode.
  useEffect(() => {
    if (tab !== "traceability" || traceability || traceLoading) return;
    setTraceLoading(true);
    api.getTraceability(id).then(setTraceability).catch(() => {}).finally(() => setTraceLoading(false));
  }, [tab, traceability, traceLoading, id]);

  const showToast = (msg, type = "info", runId = null) => {
    setToast({ msg, type, visible: true, showLink: !!runId, runId });
    setTimeout(() => setToast(t => ({ ...t, visible: false })), type === "error" ? 5000 : 3500);
  };

  const refresh = useCallback(async () => {
    try {
      const [p, t, r] = await Promise.all([api.getProject(id), api.getTests(id), api.getRuns(id)]);
      setProject(p); setTests(t); setRuns(r);
      // Clamp reviewPage so it doesn't point past the last page after
      // a review action removes tests from the current filter view.
      setReviewPage(prev => {
        const total = Math.max(1, Math.ceil(t.length / PAGE_SIZE));
        return prev > total ? total : prev;
      });
    } catch (err) {
      console.error("ProjectDetail refresh error:", err);
      // Don't wipe existing state on transient errors — only set project to null
      // on initial load (when project was never fetched successfully).
    }
  }, [id]);

  useEffect(() => { refresh().finally(() => setLoading(false)); }, [refresh]);

  useEffect(() => {
    if (!activeRun) return;
    const timer = setInterval(async () => {
      const run = await api.getRun(activeRun).catch(() => null);
      api.getRuns(id).then(r => { if (r) setRuns(r); }).catch(() => {});
      if (!run || run.status !== "running") {
        setActiveRun(null);
        refresh();
        clearInterval(timer);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [activeRun, refresh, id]);

  // FIX #5: No longer auto-switching tab. Run starts in background; toast has opt-in "View run" link.
  async function doCrawl() {
    setActionLoading("crawl");
    try {
      // Pre-flight: check if an AI provider is configured before starting
      const config = await api.getConfig().catch(() => null);
      if (!config?.hasProvider) {
        showToast("No AI provider configured — go to Settings to add an API key or enable Ollama.", "error");
        setActionLoading(null);
        return;
      }
      // Send structured config to the backend — it validates and builds the prompt server-side
      const { runId } = await api.crawl(id, crawlDialsCfg ? { dialsConfig: crawlDialsCfg } : undefined);
      setActiveRun(runId);
      setActiveRunId(runId);
      showToast("Crawl started — new tests will appear as Draft", "info", runId);
    } catch (err) { showToast(err.message, "error"); }
    finally { setActionLoading(null); }
  }

  async function doRun() {
    setActionLoading("run");
    try {
      // Pass dials config so parallelWorkers reaches the backend
      const { runId } = await api.runTests(id, crawlDialsCfg ? { dialsConfig: crawlDialsCfg } : undefined);
      setActiveRun(runId);
      setActiveRunId(runId);
      const pw = crawlDialsCfg?.parallelWorkers;
      const modeHint = pw > 1 ? ` (${pw}x parallel)` : "";
      showToast(`Regression run started${modeHint}`, "info", runId);
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  }

  async function reviewOne(testId, action) {
    try {
      if (action === "approve") await api.approveTest(id, testId);
      else if (action === "reject") await api.rejectTest(id, testId);
      else if (action === "restore") await api.restoreTest(id, testId);
      await refresh();
      setSelected(s => { const n = new Set(s); n.delete(testId); return n; });
      const msgs = { approve: "Test approved → Regression suite", reject: "Test rejected", restore: "Test restored to Draft" };
      showToast(msgs[action], action === "approve" ? "success" : action === "reject" ? "error" : "info");
    } catch (err) { showToast(err.message, "error"); }
  }

  const [bulkConfirm, setBulkConfirm] = React.useState(null); // {action, ids}

  function requestBulkAction(action) {
    const ids = selected.size > 0
      ? Array.from(selected)
      : filteredByReview.map(t => t.id);
    if (!ids.length) return;
    // Require confirmation when operating on all visible tests
    if (selected.size === 0 && ids.length > 1) {
      setBulkConfirm({ action, ids });
      return;
    }
    executeBulkAction(action, ids);
  }

  async function executeBulkAction(action, ids) {
    setBulkConfirm(null);
    if (!ids?.length) return;
    try {
      const res = await api.bulkUpdateTests(id, ids, action);
      await refresh(); setSelected(new Set());
      const label = action === "approve" ? "approved → Regression" : action === "reject" ? "rejected" : "restored to Draft";
      showToast(`${res.updated} tests ${label}`, action === "approve" ? "success" : "info");
    } catch (err) { showToast(err.message, "error"); }
  }

  async function executeBulkDelete(ids) {
    setBulkConfirm(null);
    if (!ids?.length) return;
    try {
      const res = await api.bulkDeleteTests(id, ids);
      await refresh(); setSelected(new Set());
      showToast(`${res.deleted} test${res.deleted !== 1 ? "s" : ""} deleted`, "info");
    } catch (err) { showToast(err.message, "error"); }
  }

  function requestBulkDelete() {
    const ids = selected.size > 0
      ? Array.from(selected)
      : filteredByReview.map(t => t.id);
    if (!ids.length) return;
    setBulkConfirm({ action: "delete", ids });
  }

  // Keep old name as alias so existing call sites work unchanged
  function bulkAction(action) { requestBulkAction(action); }

  function toggleSelect(testId) {
    setSelected(s => { const n = new Set(s); n.has(testId) ? n.delete(testId) : n.add(testId); return n; });
  }

  function toggleAll(checked, ids) {
    setSelected(checked ? new Set(ids) : new Set());
  }

  const draftTests    = tests.filter(t => !t.reviewStatus || t.reviewStatus === "draft");
  const approvedTests = tests.filter(t => t.reviewStatus === "approved");
  const rejectedTests = tests.filter(t => t.reviewStatus === "rejected");
  const isApiTest     = t => t.generatedFrom === "api_har_capture" || t.generatedFrom === "api_user_described";
  const apiTests      = tests.filter(isApiTest);
  const uiTests       = tests.filter(t => !isApiTest(t));

  const filteredByReview = tests.filter(t => {
    const statusOk =
      reviewFilter === "all"   ? true :
      reviewFilter === "draft" ? (!t.reviewStatus || t.reviewStatus === "draft") :
                                  t.reviewStatus === reviewFilter;
    const categoryOk =
      categoryFilter === "all" ? true :
      categoryFilter === "api" ? isApiTest(t) :
      categoryFilter === "ui"  ? !isApiTest(t) : true;
    const searchOk = !search ||
      t.name?.toLowerCase().includes(search.toLowerCase()) ||
      t.sourceUrl?.toLowerCase().includes(search.toLowerCase());
    return statusOk && categoryOk && searchOk;
  }).sort((a, b) => {
    // Newest first — so tests from the latest generation run appear at the top
    const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return db - da;
  });

  // Paginate review tab (50 per page)
  const reviewTotalPages = Math.max(1, Math.ceil(filteredByReview.length / PAGE_SIZE));
  const pagedReview = filteredByReview.slice((reviewPage - 1) * PAGE_SIZE, reviewPage * PAGE_SIZE);

  const passed = approvedTests.filter(t => t.lastResult === "passed").length;
  const failed = approvedTests.filter(t => t.lastResult === "failed").length;

  if (loading) return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      {[80, 400].map((h, i) => <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 16 }} />)}
    </div>
  );
  if (!project) return (
    <div style={{ padding: "80px 0", textAlign: "center", color: "var(--text2)", maxWidth: 480, margin: "0 auto" }}>
      <div style={{ fontSize: "2.5rem", marginBottom: 12 }}>🔍</div>
      <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--text)", marginBottom: 8 }}>Project not found</div>
      <div style={{ fontSize: "0.875rem", marginBottom: 24 }}>This project may have been deleted or the link is invalid.</div>
      <button className="btn btn-primary" onClick={() => navigate("/projects")}>Back to Projects</button>
    </div>
  );

  // Build dynamic bulk button labels based on selection scope
  const bulkScope = selected.size > 0 ? `${selected.size} selected` : `all ${filteredByReview.length} draft${filteredByReview.length !== 1 ? "s" : ""}`;

  return (
    <div className="fade-in" style={{ maxWidth: 980, margin: "0 auto" }}>

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
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-end" }}>
            {/* ── Row 1: Mode selector + Crawl button + Run button ── */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {/* Explore mode segmented control — always visible */}
              <div style={{
                display: "flex", borderRadius: "var(--radius)", overflow: "hidden",
                border: "1px solid var(--border)", flexShrink: 0,
              }}>
                {EXPLORE_MODE_OPTIONS.map(opt => {
                  const active = (crawlDialsCfg?.exploreMode || "crawl") === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setCrawlDialsCfg(prev => ({ ...prev, exploreMode: opt.id }))}
                      style={{
                        padding: "5px 12px", border: "none", cursor: "pointer",
                        fontSize: "0.78rem", fontWeight: active ? 600 : 400,
                        background: active ? "var(--accent-bg)" : "var(--surface)",
                        color: active ? "var(--accent)" : "var(--text2)",
                        transition: "all 0.12s",
                        borderRight: opt.id === "crawl" ? "1px solid var(--border)" : "none",
                      }}
                      title={opt.desc}
                    >
                      {opt.id === "crawl" ? "🔗" : "⚡"} {opt.label}
                    </button>
                  );
                })}
              </div>

              <button className="btn btn-ghost btn-sm" onClick={doCrawl} disabled={!!actionLoading}>
                {actionLoading === "crawl" ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}
                {tests.length > 0 ? "Re-Crawl" : "Crawl & Generate"}
              </button>
              {/* Parallel workers compact selector */}
              <div style={{
                display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                padding: "3px 8px", borderRadius: "var(--radius)",
                border: "1px solid var(--border)", background: "var(--surface)",
                fontSize: "0.72rem", color: "var(--text2)",
              }} title={PARALLEL_WORKERS_TUNING.desc}>
                <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>⚡</span>
                <select
                  value={crawlDialsCfg?.parallelWorkers ?? PARALLEL_WORKERS_TUNING.defaultVal}
                  onChange={e => setCrawlDialsCfg(prev => ({ ...prev, parallelWorkers: parseInt(e.target.value, 10) }))}
                  style={{
                    background: "transparent", border: "none", color: "var(--accent)",
                    fontWeight: 700, fontSize: "0.78rem", cursor: "pointer",
                    fontFamily: "var(--font-mono)", padding: 0, outline: "none",
                  }}
                >
                  {Array.from({ length: PARALLEL_WORKERS_TUNING.max }, (_, i) => i + 1).map(n => (
                    <option key={n} value={n}>{n}x</option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary btn-sm" onClick={doRun}
                disabled={!!actionLoading || approvedTests.length === 0}
                title={approvedTests.length === 0 ? "Approve tests first to run regression" : undefined}>
                {actionLoading === "run" ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
                Run ({approvedTests.length})
              </button>
            </div>

            {/* ── Row 2: Dials popover + Export dropdown ── */}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {/* Test Dials popover trigger */}
              <div style={{ position: "relative" }}>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => setShowDialsPopover(v => !v)}
                  style={{
                    gap: 5,
                    background: showDialsPopover ? "var(--accent-bg)" : undefined,
                    borderColor: showDialsPopover ? "var(--accent)" : undefined,
                  }}
                >
                  ⚙ Dials
                  <span className="active-count-pill" style={{ fontSize: "0.65rem", padding: "1px 6px" }}>
                    {countActiveDials(crawlDialsCfg)}
                  </span>
                  <ChevronDown size={10} style={{ transform: showDialsPopover ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
                </button>
                {showDialsPopover && (
                  <>
                    <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setShowDialsPopover(false)} />
                    <div style={{
                      position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 100,
                      width: 420, maxHeight: "70vh", overflowY: "auto",
                      background: "var(--surface)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius-lg)", boxShadow: "0 12px 40px rgba(0,0,0,0.15)",
                      padding: 16,
                    }}>
                      <CrawlDialsPanel value={crawlDialsCfg} onChange={setCrawlDialsCfg} />
                    </div>
                  </>
                )}
              </div>

              {/* Export dropdown */}
              {tests.length > 0 && (
                <div style={{ position: "relative" }}>
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => setShowExportMenu(v => !v)}
                    style={{ gap: 4 }}
                  >
                    <Download size={11} /> Export <ChevronDown size={10} />
                  </button>
                  {showExportMenu && (
                    <>
                      <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setShowExportMenu(false)} />
                      <div style={{
                        position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 100,
                        background: "var(--surface)", border: "1px solid var(--border)",
                        borderRadius: "var(--radius)", boxShadow: "var(--shadow)",
                        minWidth: 220, padding: 4,
                      }}>
                        <div style={{ padding: "6px 12px", fontSize: "0.7rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                          Export all {tests.length} tests
                        </div>
                        {[
                          { label: "Zephyr Scale CSV", desc: "Zephyr Scale / Zephyr Squad import",    url: api.exportZephyrUrl(id) },
                          { label: "TestRail CSV",     desc: "TestRail bulk import",                   url: api.exportTestRailUrl(id) },
                        ].map(fmt => (
                          <a key={fmt.label} href={fmt.url} download onClick={() => setShowExportMenu(false)}
                            style={{ display: "block", padding: "8px 12px", borderRadius: 6, textDecoration: "none", color: "var(--text)" }}
                            onMouseEnter={e => e.currentTarget.style.background = "var(--bg2)"}
                            onMouseLeave={e => e.currentTarget.style.background = "none"}>
                            <div style={{ fontSize: "0.84rem", fontWeight: 500 }}>{fmt.label}</div>
                            <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 1 }}>{fmt.desc}</div>
                          </a>
                        ))}
                        {approvedTests.length > 0 && (
                          <>
                            <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                            <div style={{ padding: "6px 12px", fontSize: "0.7rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                              Approved only ({approvedTests.length})
                            </div>
                            {[
                              { label: "Zephyr CSV (approved)", url: api.exportZephyrUrl(id, "approved") },
                              { label: "TestRail CSV (approved)", url: api.exportTestRailUrl(id, "approved") },
                            ].map(fmt => (
                              <a key={fmt.label} href={fmt.url} download onClick={() => setShowExportMenu(false)}
                                style={{ display: "block", padding: "7px 12px", borderRadius: 6, textDecoration: "none", color: "var(--text)", fontSize: "0.82rem" }}
                                onMouseEnter={e => e.currentTarget.style.background = "var(--bg2)"}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                {fmt.label}
                              </a>
                            ))}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {tests.length > 0 && (
          <div style={{ display: "flex", gap: 24, marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
            {[
              { label: "Draft",    val: draftTests.length,    color: "var(--amber)" },
              { label: "Approved", val: approvedTests.length, color: "var(--green)" },
              { label: "Rejected", val: rejectedTests.length, color: "var(--red)"   },
              { label: "Passing",  val: passed,               color: "var(--green)" },
              { label: "Failing",  val: failed,               color: "var(--red)"   },
              ...(apiTests.length > 0 ? [
                { label: "UI Tests",  val: uiTests.length,  color: "#7c3aed" },
                { label: "API Tests", val: apiTests.length,  color: "#2563eb" },
              ] : []),
            ].map((s, i) => (
              <div key={i}>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, color: s.color }}>{s.val}</div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
            {approvedTests.length > 0 && (() => {
              const pct = Math.round((passed / approvedTests.length) * 100);
              return (
                <div style={{ marginLeft: "auto", alignSelf: "center" }}>
                  <div className="progress-bar progress-bar-green" style={{ width: 140 }}>
                    <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 4, textAlign: "right" }}>
                    {pct}% passing
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Active run banner — now the primary CTA to view run, tab stays put */}
      {activeRun && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "var(--blue-bg)", border: "1px solid #bfdbfe", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <RefreshCw size={14} color="var(--blue)" className="spin" />
            <span style={{ fontWeight: 500, fontSize: "0.875rem", color: "var(--blue)" }}>Run in progress…</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              className="btn btn-xs"
              style={{ background: "var(--red-bg)", color: "var(--red)", border: "1px solid #fca5a5" }}
              onClick={async () => {
                try {
                  await api.abortRun(activeRun);
                  setActiveRun(null);
                  showToast("Run aborted", "info");
                  refresh();
                } catch (err) { showToast(err.message, "error"); }
              }}
            >
              <StopCircle size={11} /> Stop
            </button>
            <button className="btn btn-ghost btn-xs" onClick={() => navigate(`/runs/${activeRun}`)}>
              View live <ArrowRight size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Draft-pending reminder — only show on Runs tab or when viewing non-draft filter */}
      {draftTests.length > 0 && (tab === "runs" || (tab === "review" && reviewFilter !== "draft")) && (
        <div style={{ marginBottom: 16, padding: "10px 16px", background: "var(--amber-bg)", border: "1px solid #fcd34d", borderRadius: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <Info size={14} color="var(--amber)" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: "0.82rem", color: "#92400e" }}>
            <strong>{draftTests.length} test{draftTests.length !== 1 ? "s" : ""}</strong> pending review — approve to add to regression.
          </span>
          <button className="btn btn-ghost btn-xs" style={{ marginLeft: "auto", flexShrink: 0 }} onClick={() => { setTab("review"); setReviewFilter("draft"); }}>
            Review drafts <ArrowRight size={11} />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", marginBottom: 14 }}>
        {[
          ["review", `Tests (${tests.length})`],
          ["runs",   `Runs (${runs.length})`],
          ["traceability", "Traceability"],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: "10px 18px", fontSize: "0.875rem",
            fontWeight: tab === key ? 600 : 400,
            color: tab === key ? "var(--accent)" : "var(--text2)",
            borderBottom: tab === key ? "2px solid var(--accent)" : "2px solid transparent",
            marginBottom: -1, display: "flex", alignItems: "center", gap: 6,
          }}>
            {key === "review" && draftTests.length > 0 && (
              <span style={{ background: "var(--amber)", color: "#fff", borderRadius: "99px", fontSize: "0.65rem", fontWeight: 700, padding: "1px 6px" }}>{draftTests.length}</span>
            )}
            {label}
          </button>
        ))}
      </div>

      {/* ── GENERATED TESTS / REVIEW TAB ── */}
      {tab === "review" && (
        <div>
          {/* New tests banner — only show on draft or all filter (new tests are always drafts) */}
          {newTestIds.size > 0 && (reviewFilter === "draft" || reviewFilter === "all") && (
            <div style={{
              marginBottom: 14, padding: "10px 16px",
              background: "var(--green-bg)", border: "1px solid #86efac",
              borderRadius: 10, display: "flex", alignItems: "center", gap: 10,
            }}>
              <span style={{ fontSize: "1rem" }}>✨</span>
              <span style={{ fontSize: "0.82rem", color: "#14532d" }}>
                <strong>{newTestIds.size} new test{newTestIds.size !== 1 ? "s" : ""}</strong> generated — review and approve to add to regression.
              </span>
              <button
                className="btn btn-ghost btn-xs"
                style={{ marginLeft: "auto", flexShrink: 0 }}
                onClick={() => setShowNewBadges(false)}
              >
                Dismiss
              </button>
            </div>
          )}

          {tests.length === 0 ? (
            <div className="card" style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
              <Search size={32} style={{ opacity: 0.25, marginBottom: 12 }} />
              <div style={{ fontWeight: 600, marginBottom: 6 }}>No tests yet</div>
              <div style={{ fontSize: "0.875rem" }}>Click "Crawl & Generate Tests" — all generated tests will appear here as Draft for your review.</div>
            </div>
          ) : (
            <>
              {/* Filter + search row */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                {[
                  ["draft",    `Draft (${draftTests.length})`,       "var(--amber)"],
                  ["approved", `Approved (${approvedTests.length})`, "var(--green)"],
                  ["rejected", `Rejected (${rejectedTests.length})`, "var(--red)"  ],
                  ["all",      `All (${tests.length})`,              "var(--text2)"],
                ].map(([key, label, color]) => (
                  <button key={key} onClick={() => { setReviewFilter(key); setSelected(new Set()); setReviewPage(1); }} style={{
                    padding: "5px 12px", borderRadius: "99px", fontSize: "0.78rem", fontWeight: 600,
                    border: `1px solid ${reviewFilter === key ? color : "var(--border)"}`,
                    background: "transparent", color: reviewFilter === key ? color : "var(--text2)",
                    cursor: "pointer", transition: "all 0.12s",
                  }}>{label}</button>
                ))}

                {/* Category filter (UI / API) — only show when API tests exist */}
                {apiTests.length > 0 && (
                  <>
                    <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px", flexShrink: 0 }} />
                    {[
                      ["ui",  `UI (${uiTests.length})`,   "#7c3aed"],
                      ["api", `🌐 API (${apiTests.length})`, "#2563eb"],
                    ].map(([key, label, color]) => (
                      <button key={key} onClick={() => { setCategoryFilter(categoryFilter === key ? "all" : key); setSelected(new Set()); setReviewPage(1); }} style={{
                        padding: "5px 12px", borderRadius: "99px", fontSize: "0.78rem", fontWeight: 600,
                        border: `1px solid ${categoryFilter === key ? color : "var(--border)"}`,
                        background: categoryFilter === key ? `${color}14` : "transparent",
                        color: categoryFilter === key ? color : "var(--text2)",
                        cursor: "pointer", transition: "all 0.12s",
                      }}>{label}</button>
                    ))}
                  </>
                )}
                <div style={{ flex: 1 }} />
                <div style={{ position: "relative" }}>
                  <Search size={12} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
                  <input className="input" value={search} onChange={e => { setSearch(e.target.value); setReviewPage(1); }}
                    placeholder="Search tests..." style={{ paddingLeft: 26, height: 32, fontSize: "0.82rem", width: 200 }} />
                </div>
              </div>

              {/* Bulk action bar — dynamic labels show exact scope */}
              {(reviewFilter === "draft" || selected.size > 0) && filteredByReview.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--accent-bg)", border: "1px solid rgba(91,110,245,0.2)", borderRadius: 8, marginBottom: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.82rem", color: "var(--accent)", fontWeight: 500 }}>
                    {selected.size > 0 ? `${selected.size} selected` : `${filteredByReview.length} draft tests visible`}
                  </span>
                  <button className="btn btn-sm" style={{ background: "var(--green-bg)", color: "var(--green)", border: "1px solid #86efac" }}
                    onClick={() => bulkAction("approve")}>
                    <ThumbsUp size={12} /> Approve {bulkScope}
                  </button>
                  <button className="btn btn-sm" style={{ background: "var(--red-bg)", color: "var(--red)", border: "1px solid #fca5a5" }}
                    onClick={() => bulkAction("reject")}>
                    <ThumbsDown size={12} /> Reject {bulkScope}
                  </button>
                  <button className="btn btn-sm" style={{ background: "var(--red-bg)", color: "var(--red)", border: "1px solid #fca5a5" }}
                    onClick={requestBulkDelete}>
                    <Trash2 size={12} /> Delete {bulkScope}
                  </button>
                  {selected.size > 0 && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear selection</button>
                  )}
                </div>
              )}

              <div className="card">
                {filteredByReview.length === 0 ? (
                  <div style={{ padding: "48px 24px", textAlign: "center", color: "var(--text2)", fontSize: "0.875rem" }}>
                    No {reviewFilter !== "all" ? reviewFilter : ""} tests
                  </div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 36, paddingRight: 0 }}>
                          <input type="checkbox"
                            checked={pagedReview.length > 0 && pagedReview.every(t => selected.has(t.id))}
                            onChange={e => toggleAll(e.target.checked, pagedReview.map(t => t.id))}
                            style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                        </th>
                        <th>Test ID</th>
                        <th>Test Name</th>
                        <th>Status</th>
                        <th>Review</th>
                        <th>Type</th>
                        <th>Confidence</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedReview.map(t => {
                        const rs = t.reviewStatus || "draft";
                        const isSelected = selected.has(t.id);
                        const isNew = newTestIds.has(t.id);
                        return (
                          <tr key={t.id} style={{
                            background: isSelected ? "var(--accent-bg)" : isNew ? "rgba(34,197,94,0.06)" : undefined,
                            transition: "background 0.3s",
                          }}>
                            <td style={{ paddingRight: 0 }}>
                              <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(t.id)}
                                style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                            </td>
                            <td>
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text3)" }}>
                                {t.id.length > 8 ? t.id.slice(0, 8) + "…" : t.id}
                              </span>
                            </td>
                            <td style={{ cursor: "pointer" }} onClick={() => navigate(`/tests/${t.id}`)}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <AgentTag type="TA" />
                                <div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ fontWeight: 500, fontSize: "0.875rem" }}>{cleanTestName(t.name)}</span>
                                    {isNew && (
                                      <span style={{
                                        fontSize: "0.6rem", fontWeight: 700, padding: "1px 5px",
                                        borderRadius: 4, background: "var(--green)", color: "#fff",
                                        letterSpacing: "0.03em", lineHeight: 1.5,
                                      }}>NEW</span>
                                    )}
                                  </div>
                                  {t.description && <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 1 }}>{t.description?.slice(0, 64)}</div>}
                                  <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                                    <ScenarioBadges test={t} isBddTest={isBddTest} />
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td><StatusBadge s={t.lastResult} /></td>
                            <td><ReviewBadge status={rs} /></td>
                            <td>
                              {t.type && (
                                <span className={`badge ${testTypeBadgeClass(t.type)}`}>
                                  {testTypeLabel(t.type, true)}
                                </span>
                              )}
                            </td>
                            <td><ConfBar score={t.qualityScore != null ? Math.min(100, Math.round(t.qualityScore)) : null} /></td>
                            <td>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {rs === "draft" && (
                                  <>
                                    <button className="btn btn-xs" style={{ background: "var(--green-bg)", color: "var(--green)", border: "1px solid #86efac" }}
                                      onClick={() => reviewOne(t.id, "approve")}>
                                      <ThumbsUp size={11} /> Approve
                                    </button>
                                    <button className="btn btn-xs" style={{ background: "var(--red-bg)", color: "var(--red)", border: "1px solid #fca5a5" }}
                                      onClick={() => reviewOne(t.id, "reject")}>
                                      <ThumbsDown size={11} /> Reject
                                    </button>
                                  </>
                                )}
                                {(rs === "approved" || rs === "rejected") && (
                                  <button className="btn btn-ghost btn-xs" onClick={() => reviewOne(t.id, "restore")} title="Move back to Draft">
                                    <RotateCcw size={11} /> Restore
                                  </button>
                                )}
                                <button className="btn btn-ghost btn-xs" onClick={() => {
                                  if (!window.confirm(`Delete test "${t.name}"? This cannot be undone.`)) return;
                                  api.deleteTest(id, t.id).then(refresh).catch(err => showToast(err.message, "error"));
                                }}>
                                  <Trash2 size={11} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Pagination */}
              {reviewTotalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
                  <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>
                    {filteredByReview.length} tests · page {reviewPage} of {reviewTotalPages}
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-ghost btn-xs" disabled={reviewPage === 1} onClick={() => setReviewPage(p => p - 1)}>← Prev</button>
                    <button className="btn btn-ghost btn-xs" disabled={reviewPage === reviewTotalPages} onClick={() => setReviewPage(p => p + 1)}>Next →</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── RUNS TAB ── */}
      {tab === "runs" && (
        <div className="card">
          {runs.length === 0 ? (
            <div style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>No runs yet</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Run ID</th><th>Type</th><th>Status</th><th>Tests / Pages</th><th>Started</th><th></th></tr>
              </thead>
              <tbody>
                {[...runs]
                  .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
                  .map(r => {
                    const isCrawl    = r.type === "crawl";
                    const isGenerate = r.type === "generate";
                    const isRun      = r.type === "run" || r.type === "test_run";
                    return (
                      <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/runs/${r.id}`)}>
                        <td>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text3)" }}>
                            {r.id.length > 8 ? r.id.slice(0, 8) + "…" : r.id}
                          </span>
                        </td>
                        <td>
                          {isCrawl    && <span className="badge badge-accent">🔍 crawl</span>}
                          {isGenerate && <span className="badge badge-blue">⚡ generate</span>}
                          {isRun      && <span className="badge badge-green">▶ run</span>}
                          {!isCrawl && !isGenerate && !isRun && <span className="badge badge-gray">{r.type}</span>}
                        </td>
                        <td>
                          {r.status === "completed" && <span className="badge badge-green">✓ Completed</span>}
                          {r.status === "running"   && <span className="badge badge-blue" style={{ animation: "pulse 1.5s ease-in-out infinite" }}>● Running</span>}
                          {r.status === "failed"    && <span className="badge badge-red">✗ Failed</span>}
                          {r.status === "aborted"   && <span className="badge badge-gray"><Ban size={10} /> Aborted</span>}
                          {!["completed","running","failed","aborted"].includes(r.status) && <span className="badge badge-gray">{r.status}</span>}
                        </td>
                        <td>
                          {isCrawl && (
                            <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                              {r.pagesFound ?? "—"} <span style={{ fontWeight: 400, color: "var(--text3)", fontSize: "0.73rem" }}>pages</span>
                            </span>
                          )}
                          {isGenerate && (
                            <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                              {r.testsGenerated ?? r.pipelineStats?.rawTestsGenerated ?? "—"} <span style={{ fontWeight: 400, color: "var(--text3)", fontSize: "0.73rem" }}>tests</span>
                            </span>
                          )}
                          {isRun && (
                            <span>
                              <span style={{ color: "var(--green)", fontWeight: 600 }}>{r.passed ?? "—"}</span>
                              <span style={{ color: "var(--text3)", margin: "0 4px" }}>/</span>
                              <span style={{ color: "var(--red)", fontWeight: 600 }}>{r.failed ?? "—"}</span>
                              <span style={{ color: "var(--text3)", fontSize: "0.73rem", marginLeft: 4 }}>pass/fail</span>
                            </span>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                            {new Date(r.startedAt).toLocaleString()}
                          </span>
                        </td>
                        <td><ArrowRight size={14} color="var(--text3)" /></td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── TRACEABILITY TAB ── */}
      {tab === "traceability" && (
        <div>
          {traceLoading && (
            <div className="card" style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
              <RefreshCw size={20} className="spin" style={{ opacity: 0.3, marginBottom: 12 }} />
              <div>Loading traceability matrix…</div>
            </div>
          )}

          {traceability && (
            <>
              {/* Summary stats */}
              <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
                {[
                  { label: "Total tests",    val: traceability.totalTests,   color: "var(--text)" },
                  { label: "Linked issues",   val: traceability.linkedIssues, color: "var(--accent)" },
                  { label: "Unlinked tests",  val: traceability.unlinkedTests, color: traceability.unlinkedTests > 0 ? "var(--amber)" : "var(--green)" },
                ].map((s, i) => (
                  <div key={i} className="card" style={{ padding: "16px 20px", flex: 1, minWidth: 140 }}>
                    <div style={{ fontSize: "1.4rem", fontWeight: 700, color: s.color }}>{s.val}</div>
                    <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Linked issues matrix */}
              {Object.keys(traceability.matrix || {}).length > 0 && (
                <div className="card" style={{ marginBottom: 16 }}>
                  <div style={{ padding: "16px 20px 0", display: "flex", alignItems: "center", gap: 8 }}>
                    <Link2 size={15} color="var(--accent)" />
                    <h3 style={{ fontWeight: 700, fontSize: "0.95rem", margin: 0 }}>Requirement → Test Coverage</h3>
                  </div>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Issue Key</th>
                        <th>Tests</th>
                        <th>Types</th>
                        <th>Status</th>
                        <th>Last Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(traceability.matrix).map(([issueKey, issueTests]) => (
                        <tr key={issueKey}>
                          <td>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--accent)", fontWeight: 600 }}>
                              {issueKey}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              {issueTests.map(t => (
                                <span
                                  key={t.testId}
                                  style={{ fontSize: "0.78rem", color: "var(--text)", cursor: "pointer" }}
                                  onClick={() => navigate(`/tests/${t.testId}`)}
                                >
                                  {t.name}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {[...new Set(issueTests.map(t => t.type).filter(Boolean))].map(type => (
                                <span key={type} className={`badge ${testTypeBadgeClass(type)}`} style={{ fontSize: "0.65rem" }}>
                                  {testTypeLabel(type, true)}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {[...new Set(issueTests.map(t => t.reviewStatus))].map(rs => (
                                <ReviewBadge key={rs} status={rs} />
                              ))}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {[...new Set(issueTests.map(t => t.lastResult).filter(Boolean))].map(r => (
                                <StatusBadge key={r} s={r} />
                              ))}
                              {issueTests.every(t => !t.lastResult) && <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>Not run</span>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Unlinked tests */}
              {traceability.unlinked?.length > 0 && (
                <div className="card">
                  <div style={{ padding: "16px 20px 0", display: "flex", alignItems: "center", gap: 8 }}>
                    <Info size={15} color="var(--amber)" />
                    <h3 style={{ fontWeight: 700, fontSize: "0.95rem", margin: 0 }}>
                      Unlinked Tests ({traceability.unlinked.length})
                    </h3>
                    <span style={{ fontSize: "0.75rem", color: "var(--text3)", marginLeft: 8 }}>
                      These tests aren't linked to any requirement — link them via Test Detail to improve coverage visibility.
                    </span>
                  </div>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Test Name</th>
                        <th>Type</th>
                        <th>Priority</th>
                        <th>Review</th>
                        <th>Last Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {traceability.unlinked.slice(0, 20).map(t => (
                        <tr key={t.testId} style={{ cursor: "pointer" }} onClick={() => navigate(`/tests/${t.testId}`)}>
                          <td style={{ fontSize: "0.82rem" }}>{t.name}</td>
                          <td>
                            {t.type && <span className={`badge ${testTypeBadgeClass(t.type)}`} style={{ fontSize: "0.65rem" }}>{testTypeLabel(t.type, true)}</span>}
                          </td>
                          <td>
                            <span className={`badge ${t.priority === "high" ? "badge-red" : "badge-gray"}`} style={{ fontSize: "0.65rem" }}>
                              {t.priority || "medium"}
                            </span>
                          </td>
                          <td><ReviewBadge status={t.reviewStatus} /></td>
                          <td><StatusBadge s={t.lastResult} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {traceability.unlinked.length > 20 && (
                    <div style={{ padding: "10px 20px", fontSize: "0.78rem", color: "var(--text3)", textAlign: "center" }}>
                      Showing 20 of {traceability.unlinked.length} unlinked tests
                    </div>
                  )}
                </div>
              )}

              {/* Empty state */}
              {Object.keys(traceability.matrix || {}).length === 0 && traceability.unlinked?.length === 0 && (
                <div className="card" style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
                  <Link2 size={32} style={{ opacity: 0.2, marginBottom: 12 }} />
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>No traceability data yet</div>
                  <div style={{ fontSize: "0.875rem" }}>Link tests to Jira issues in the Test Detail page to build your requirement → test → result matrix.</div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <Toast msg={toast.msg} type={toast.type} visible={toast.visible} onViewRun={toast.showLink} runId={toast.runId} />

      {/* Bulk action confirmation modal */}
      {bulkConfirm && (
        <ModalShell onClose={() => setBulkConfirm(null)} width="min(420px, 95vw)" style={{ padding: "28px 32px" }}>
          <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 10 }}>Confirm bulk action</div>
          <div style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: 20, lineHeight: 1.6 }}>
            You are about to <strong>{bulkConfirm.action}</strong> <strong>{bulkConfirm.ids.length} tests</strong>{bulkConfirm.action === "delete" ? ". This cannot be undone." : " (all visible tests). This cannot be undone easily."}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setBulkConfirm(null)}>Cancel</button>
            <button
              className={`btn btn-sm ${bulkConfirm.action === "approve" ? "btn-primary" : "btn-danger"}`}
              onClick={() => bulkConfirm.action === "delete"
                ? executeBulkDelete(bulkConfirm.ids)
                : executeBulkAction(bulkConfirm.action, bulkConfirm.ids)}
            >
              {bulkConfirm.action === "approve" ? "Approve all" : bulkConfirm.action === "delete" ? "Delete all" : "Reject all"}
            </button>
          </div>
        </ModalShell>
      )}

      {/* Fix #20: Keyboard shortcut hint */}
      <KeyboardShortcuts
        tab={tab}
        selected={selected}
        filteredByReview={filteredByReview}
        onApprove={() => bulkAction("approve")}
        onReject={() => bulkAction("reject")}
        onClearSelection={() => setSelected(new Set())}
      />
    </div>
  );
}

// Keyboard shortcuts for review actions — only active on the review tab
function KeyboardShortcuts({ tab, selected, filteredByReview, onApprove, onReject, onClearSelection }) {
  React.useEffect(() => {
    function handler(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      // Only fire approve/reject when on the review tab AND something is selected
      // to prevent accidental bulk actions — matches Tests.jsx behavior
      if (tab === "review" && selected.size > 0) {
        if (e.key === "a" && !e.metaKey && !e.ctrlKey) onApprove();
        if (e.key === "r" && !e.metaKey && !e.ctrlKey) onReject();
      }
      if (e.key === "Escape") onClearSelection();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tab, selected, onApprove, onReject, onClearSelection]);
  return null;
}

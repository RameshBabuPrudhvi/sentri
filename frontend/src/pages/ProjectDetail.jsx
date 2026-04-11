import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Search, Trash2, ArrowRight,
  ThumbsUp, ThumbsDown,
  RotateCcw, Info,
} from "lucide-react";
import { api } from "../api.js";
import AgentTag from "../components/AgentTag.jsx";
import ModalShell from "../components/ModalShell.jsx";
import { cleanTestName } from "../utils/formatTestName.js";
import { testTypeBadgeClass, testTypeLabel, isBddTest } from "../utils/testTypeLabels.js";
import { StatusBadge, ReviewBadge, ScenarioBadges } from "../components/TestBadges.jsx";
import usePageTitle from "../hooks/usePageTitle.js";
import useProjectRunMonitor from "../hooks/useProjectRunMonitor.js";
import { useNotifications } from "../context/NotificationContext.jsx";
import ActiveRunBanner from "../components/project/ActiveRunBanner.jsx";
import RunToast from "../components/project/RunToast.jsx";
import RunsTab from "../components/project/RunsTab.jsx";
import TraceabilityTab from "../components/project/TraceabilityTab.jsx";
import ProjectHeader from "../components/project/ProjectHeader.jsx";

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
  const [parallelWorkers, setParallelWorkers] = useState(1);
  const [tab, setTab]                     = useState("review");
  const [reviewFilter, setReviewFilter]   = useState("draft");
  const [categoryFilter, setCategoryFilter] = useState("all"); // "all" | "ui" | "api"
  const [search, setSearch]               = useState("");
  const [selected, setSelected]           = useState(new Set());
  const [reviewPage, setReviewPage]         = useState(1);  // Fix #21
  const PAGE_SIZE = 10;
  const [toast, setToast]                 = useState({ msg: "", type: "info", visible: false, showLink: false, runId: null });
  const [showNewBadges, setShowNewBadges] = useState(true);
  const [now, setNow] = useState(Date.now);
  usePageTitle(project?.name ? `${project.name} — Project` : "Project");
  const [traceability, setTraceability]     = useState(null);
  const [traceLoading, setTraceLoading]     = useState(false);
  const { addNotification } = useNotifications();

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

  const handleRunSettled = useCallback((evt) => {
    setActiveRun(null);
    refresh();

    // Push in-app notification when a run finishes on the project page.
    // evt may be a "done" SSE payload ({ status, passed, failed, ... }) or
    // a full run object from a snapshot ({ status, passed, failed, tests, ... }).
    if (evt) {
      const status = evt.status ?? "completed";
      const passed = evt.passed;
      const failed = evt.failed;
      const testsGenerated = evt.testsGenerated ?? (Array.isArray(evt.tests) ? evt.tests.length : undefined);
      const isTestRun = passed != null || failed != null;
      const notifType = status === "completed" ? "success"
                      : status === "aborted"   ? "warning"
                      : "error";
      addNotification({
        type: notifType,
        title: status === "aborted" ? "Run aborted"
             : status === "failed"  ? "Run failed"
             : "Run complete",
        body: isTestRun
          ? `${passed ?? 0} passed · ${failed ?? 0} failed`
          : `${testsGenerated ?? 0} test(s) generated`,
        link: activeRunId ? `/runs/${activeRunId}` : null,
      });
    }
  }, [refresh, addNotification, activeRunId]);
  const { sseDown, retryIn } = useProjectRunMonitor(activeRun, handleRunSettled);

  async function doRun() {
    setActionLoading("run");
    try {
      const body = parallelWorkers > 1 ? { dialsConfig: { parallelWorkers } } : undefined;
      const { runId } = await api.runTests(id, body);
      setActiveRun(runId);
      setActiveRunId(runId);
      const modeHint = parallelWorkers > 1 ? ` (${parallelWorkers}x parallel)` : "";
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
      <ProjectHeader
        project={project}
        projectId={id}
        tests={tests}
        parallelWorkers={parallelWorkers}
        onWorkersChange={setParallelWorkers}
        actionLoading={actionLoading}
        onRun={doRun}
        stats={{ draftTests, approvedTests, rejectedTests, apiTests, uiTests, passed, failed }}
      />

      {/* Active run banner — now the primary CTA to view run, tab stays put */}
      <ActiveRunBanner
        activeRun={activeRun}
        sseDown={sseDown}
        retryIn={retryIn}
        onAbort={async () => {
          try {
            await api.abortRun(activeRun);
            setActiveRun(null);
            showToast("Run aborted", "info");
            refresh();
          } catch (err) { showToast(err.message, "error"); }
        }}
        onViewLive={() => navigate(`/runs/${activeRun}`)}
      />

      {/* Draft-pending reminder — only show on Runs tab or when viewing non-draft filter */}
      {draftTests.length > 0 && (tab === "runs" || (tab === "review" && reviewFilter !== "draft")) && (
        <div className="pd-banner pd-banner--amber">
          <Info size={14} color="var(--amber)" className="shrink-0" />
          <span className="pd-banner-text-amber">
            <strong>{draftTests.length} test{draftTests.length !== 1 ? "s" : ""}</strong> pending review — approve to add to regression.
          </span>
          <button className="btn btn-ghost btn-xs" style={{ marginLeft: "auto" }} onClick={() => { setTab("review"); setReviewFilter("draft"); }}>
            Review drafts <ArrowRight size={11} />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="pd-tab-bar">
        {[
          ["review", `Tests (${tests.length})`],
          ["runs",   `Runs (${runs.length})`],
          ["traceability", "Traceability"],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`pd-tab${tab === key ? " pd-tab--active" : ""}`}>
            {key === "review" && draftTests.length > 0 && (
              <span className="pd-tab-badge">{draftTests.length}</span>
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
            <div className="pd-banner pd-banner--green">
              <span style={{ fontSize: "1rem" }}>✨</span>
              <span className="pd-banner-text-green">
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
            <div className="card pd-empty">
              <Search size={32} style={{ opacity: 0.25, marginBottom: 12 }} />
              <div style={{ fontWeight: 600, marginBottom: 6 }}>No tests yet</div>
              <div style={{ fontSize: "0.875rem", marginBottom: 14 }}>Go to the Tests page to crawl this project or generate tests from a user story.</div>
              <button className="btn btn-primary btn-sm" onClick={() => navigate("/tests")}>
                Go to Tests
              </button>
            </div>
          ) : (
            <>
              {/* Filter + search row */}
              <div className="pd-filter-row">
                {[
                  ["draft",    `Draft (${draftTests.length})`,       "var(--amber)"],
                  ["approved", `Approved (${approvedTests.length})`, "var(--green)"],
                  ["rejected", `Rejected (${rejectedTests.length})`, "var(--red)"  ],
                  ["all",      `All (${tests.length})`,              "var(--text2)"],
                ].map(([key, label, color]) => (
                  <button key={key} onClick={() => { setReviewFilter(key); setSelected(new Set()); setReviewPage(1); }}
                    className="pd-filter-pill"
                    style={{
                      borderColor: reviewFilter === key ? color : undefined,
                      color: reviewFilter === key ? color : undefined,
                    }}>{label}</button>
                ))}

                {apiTests.length > 0 && (
                  <>
                    <div className="pd-filter-divider" />
                    {[
                      ["ui",  `UI (${uiTests.length})`,   "#7c3aed"],
                      ["api", `🌐 API (${apiTests.length})`, "#2563eb"],
                    ].map(([key, label, color]) => (
                      <button key={key} onClick={() => { setCategoryFilter(categoryFilter === key ? "all" : key); setSelected(new Set()); setReviewPage(1); }}
                        className="pd-filter-pill"
                        style={{
                          borderColor: categoryFilter === key ? color : undefined,
                          background: categoryFilter === key ? `${color}14` : undefined,
                          color: categoryFilter === key ? color : undefined,
                        }}>{label}</button>
                    ))}
                  </>
                )}
                <div className="flex-1" />
                <div className="pd-search-wrap">
                  <Search size={12} color="var(--text3)" className="pd-search-icon" />
                  <input className="input pd-search-input" value={search} onChange={e => { setSearch(e.target.value); setReviewPage(1); }}
                    placeholder="Search tests..." />
                </div>
              </div>

              {/* Bulk action bar — dynamic labels show exact scope */}
              {(reviewFilter === "draft" || selected.size > 0) && filteredByReview.length > 0 && (
                <div className="pd-bulk-bar">
                  <span className="pd-bulk-label">
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

              <div className="card pd-review-table">
                {filteredByReview.length === 0 ? (
                  <div className="pd-empty-sm">
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
                            className="pd-checkbox" />
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
                                className="pd-checkbox" />
                            </td>
                            <td>
                              <span className="mono-id">
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
                                      <span className="pd-new-badge">NEW</span>
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
                <div className="pd-pagination">
                  <span className="text-xs text-muted">
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
      {tab === "runs" && <RunsTab runs={runs} />}

      {/* ── TRACEABILITY TAB ── */}
      {tab === "traceability" && (
        <TraceabilityTab traceability={traceability} traceLoading={traceLoading} />
      )}

      <RunToast msg={toast.msg} type={toast.type} visible={toast.visible} onViewRun={toast.showLink} runId={toast.runId} />

      {/* Bulk action confirmation modal */}
      {bulkConfirm && (
        <ModalShell onClose={() => setBulkConfirm(null)} width="min(420px, 95vw)" style={{ padding: "28px 32px" }}>
          <div className="pd-confirm-title">Confirm bulk action</div>
          <div className="pd-confirm-body">
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

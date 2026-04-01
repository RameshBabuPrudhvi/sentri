import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Search, Play, Trash2, ArrowRight, CheckCircle2, XCircle,
  AlertTriangle, RefreshCw, Globe, ThumbsUp, ThumbsDown,
  RotateCcw, Info, Shield, AlertCircle,
} from "lucide-react";
import { api } from "../api.js";

function StatusBadge({ s }) {
  if (!s) return <span className="badge badge-gray">Not run</span>;
  if (s === "passed")    return <span className="badge badge-green"><CheckCircle2 size={10} /> Passing</span>;
  if (s === "failed")    return <span className="badge badge-red"><XCircle size={10} /> Failing</span>;
  if (s === "running")   return <span className="badge badge-blue pulse">● Running</span>;
  if (s === "completed") return <span className="badge badge-green">✓ Completed</span>;
  return <span className="badge badge-gray">{s}</span>;
}

function ReviewBadge({ status }) {
  if (status === "approved") return <span className="badge badge-green"><CheckCircle2 size={10} /> Approved</span>;
  if (status === "rejected") return <span className="badge badge-red"><XCircle size={10} /> Rejected</span>;
  return <span className="badge badge-amber"><AlertCircle size={10} /> Draft</span>;
}

function AgentTag({ type = "TA" }) {
  const s = { QA: "avatar-qa", TA: "avatar-ta", EX: "avatar-ex" };
  return <div className={`avatar ${s[type] || "avatar-ta"}`}>{type}</div>;
}

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
  const [tab, setTab]                     = useState("review");
  const [reviewFilter, setReviewFilter]   = useState("draft");
  const [search, setSearch]               = useState("");
  const [selected, setSelected]           = useState(new Set());
  const [reviewPage, setReviewPage]         = useState(1);  // Fix #21
  const PAGE_SIZE = 50;
  const [toast, setToast]                 = useState({ msg: "", type: "info", visible: false, showLink: false, runId: null });

  const showToast = (msg, type = "info", runId = null) => {
    setToast({ msg, type, visible: true, showLink: !!runId, runId });
    setTimeout(() => setToast(t => ({ ...t, visible: false })), type === "error" ? 5000 : 3500);
  };

  const refresh = useCallback(async () => {
    try {
      const [p, t, r] = await Promise.all([api.getProject(id), api.getTests(id), api.getRuns(id)]);
      setProject(p); setTests(t); setRuns(r);
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
      const { runId } = await api.crawl(id);
      setActiveRun(runId);
      setActiveRunId(runId);
      showToast("Crawl started — new tests will appear as Draft", "info", runId);
    } catch (err) { showToast(err.message, "error"); }
    finally { setActionLoading(null); }
  }

  async function doRun() {
    setActionLoading("run");
    try {
      const { runId } = await api.runTests(id);
      setActiveRun(runId);
      setActiveRunId(runId);
      showToast("Regression run started", "info", runId);
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

  const filteredByReview = tests.filter(t => {
    const statusOk =
      reviewFilter === "all"   ? true :
      reviewFilter === "draft" ? (!t.reviewStatus || t.reviewStatus === "draft") :
                                  t.reviewStatus === reviewFilter;
    const searchOk = !search ||
      t.name?.toLowerCase().includes(search.toLowerCase()) ||
      t.sourceUrl?.toLowerCase().includes(search.toLowerCase());
    return statusOk && searchOk;
  });

  const regressionTests = approvedTests.filter(t =>
    !search || t.name?.toLowerCase().includes(search.toLowerCase())
  );

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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-ghost btn-sm" onClick={doCrawl} disabled={!!actionLoading}>
              {actionLoading === "crawl" ? <RefreshCw size={14} className="spin" /> : <Search size={14} />}
              {tests.length > 0 ? "Re-Crawl" : "Crawl & Generate Tests"}
            </button>
            <button className="btn btn-primary btn-sm" onClick={doRun}
              disabled={!!actionLoading || approvedTests.length === 0}
              title={approvedTests.length === 0 ? "Approve tests first to run regression" : undefined}>
              {actionLoading === "run" ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
              Run Regression ({approvedTests.length})
            </button>
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
            ].map((s, i) => (
              <div key={i}>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, color: s.color }}>{s.val}</div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
            {approvedTests.length > 0 && (
              <div style={{ marginLeft: "auto", alignSelf: "center" }}>
                <div className="progress-bar progress-bar-green" style={{ width: 140 }}>
                  <div className="progress-bar-fill" style={{ width: `${Math.round(passed / approvedTests.length * 100)}%` }} />
                </div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 4, textAlign: "right" }}>
                  {Math.round(passed / approvedTests.length * 100)}% passing
                </div>
              </div>
            )}
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
          <button className="btn btn-ghost btn-xs" onClick={() => navigate(`/runs/${activeRun}`)}>
            View live <ArrowRight size={12} />
          </button>
        </div>
      )}

      {/* Draft-pending reminder */}
      {draftTests.length > 0 && tab !== "runs" && (
        <div style={{ marginBottom: 16, padding: "10px 16px", background: "var(--amber-bg)", border: "1px solid #fcd34d", borderRadius: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <Info size={14} color="var(--amber)" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: "0.82rem", color: "#92400e" }}>
            <strong>{draftTests.length} test{draftTests.length !== 1 ? "s" : ""}</strong> pending review — approve to add to regression.
          </span>
          <button className="btn btn-ghost btn-xs" style={{ marginLeft: "auto", flexShrink: 0 }} onClick={() => { setTab("review"); setReviewFilter("draft"); }}>
            Review <ArrowRight size={11} />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", marginBottom: 14 }}>
        {[
          ["review",     "Generated Tests (Review Required)"],
          ["regression", `Regression Suite (${approvedTests.length})`],
          ["runs",       `Runs (${runs.length})`],
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
                        <th>Review Status</th>
                        <th>Confidence</th>
                        <th>Source Page</th>
                        <th>Generated</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedReview.map(t => {
                        const rs = t.reviewStatus || "draft";
                        const isSelected = selected.has(t.id);
                        return (
                          <tr key={t.id} style={{ background: isSelected ? "var(--accent-bg)" : undefined }}>
                            <td style={{ paddingRight: 0 }}>
                              <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(t.id)}
                                style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                            </td>
                            <td>
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text3)" }}>
                                {t.id.slice(0, 8)}…
                              </span>
                            </td>
                            <td style={{ cursor: "pointer" }} onClick={() => navigate(`/tests/${t.id}`)}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <AgentTag type="TA" />
                                <div>
                                  <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{t.name}</div>
                                  {t.description && <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 1 }}>{t.description?.slice(0, 64)}</div>}
                                  <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                                    {t.isJourneyTest && <span className="badge badge-purple">Journey</span>}
                                    {t.scenario === "positive" && <span className="badge badge-green" style={{ fontSize: "0.65rem" }}>✓ Positive</span>}
                                    {t.scenario === "negative" && <span className="badge badge-red" style={{ fontSize: "0.65rem" }}>✗ Negative</span>}
                                    {t.scenario === "edge_case" && <span className="badge badge-amber" style={{ fontSize: "0.65rem" }}>⚡ Edge case</span>}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td><ReviewBadge status={rs} /></td>
                            <td><ConfBar score={t.qualityScore != null ? Math.round(t.qualityScore * 100) : null} /></td>
                            <td>
                              <span style={{ fontSize: "0.73rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                                {t.sourceUrl ? t.sourceUrl.replace(/^https?:\/\/[^/]+/, "") || "/" : "—"}
                              </span>
                            </td>
                            <td>
                              <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                                {t.createdAt ? new Date(t.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                              </span>
                            </td>
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
                                <button className="btn btn-ghost btn-xs" onClick={() => api.deleteTest(id, t.id).then(refresh)}>
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

      {/* ── REGRESSION SUITE TAB ── */}
      {tab === "regression" && (
        <div>
          <div style={{ marginBottom: 14, padding: "10px 16px", background: "var(--green-bg)", border: "1px solid #86efac", borderRadius: 10, display: "flex", alignItems: "center", gap: 10 }}>
            <Shield size={14} color="var(--green)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: "0.82rem", color: "#14532d" }}>
              Only <strong>approved tests</strong> appear here. Draft and rejected tests cannot enter regression.
            </span>
          </div>

          {approvedTests.length === 0 ? (
            <div className="card" style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
              <Shield size={32} style={{ opacity: 0.2, marginBottom: 12 }} />
              <div style={{ fontWeight: 600, marginBottom: 6 }}>No approved tests yet</div>
              <div style={{ fontSize: "0.875rem", marginBottom: 16 }}>Review and approve generated tests to populate this suite.</div>
              <button className="btn btn-primary btn-sm" onClick={() => { setTab("review"); setReviewFilter("draft"); }}>
                Go to review queue <ArrowRight size={13} />
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <div style={{ position: "relative" }}>
                  <Search size={12} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
                  <input className="input" value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search regression tests..." style={{ paddingLeft: 26, height: 32, fontSize: "0.82rem", width: 220 }} />
                </div>
                <div style={{ flex: 1 }} />
                <button className="btn btn-primary btn-sm" onClick={doRun} disabled={!!actionLoading}>
                  {actionLoading === "run" ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
                  Run All ({approvedTests.length})
                </button>
              </div>
              <div className="card">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Test ID</th><th>Test Name</th><th>Last Result</th><th>Type</th><th>Priority</th><th>Confidence</th><th>Last Run</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {regressionTests.map(t => (
                      <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/tests/${t.id}`)}>
                        <td>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text3)" }}>
                            {t.id.slice(0, 8)}…
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <AgentTag type="TA" />
                            <div>
                              <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{t.name}</div>
                              <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                                {t.isJourneyTest && <span className="badge badge-purple">Journey</span>}
                                {t.scenario === "positive" && <span className="badge badge-green" style={{ fontSize: "0.65rem" }}>✓ Positive</span>}
                                {t.scenario === "negative" && <span className="badge badge-red" style={{ fontSize: "0.65rem" }}>✗ Negative</span>}
                                {t.scenario === "edge_case" && <span className="badge badge-amber" style={{ fontSize: "0.65rem" }}>⚡ Edge case</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td><StatusBadge s={t.lastResult} /></td>
                        <td><span className="badge badge-gray">{t.type || "—"}</span></td>
                        <td>
                          <span className={`badge ${t.priority === "high" ? "badge-red" : t.priority === "medium" ? "badge-amber" : "badge-gray"}`}>
                            {t.priority || "—"}
                          </span>
                        </td>
                        <td><ConfBar score={t.qualityScore != null ? Math.round(t.qualityScore * 100) : null} /></td>
                        <td>
                          <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                            {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                          </span>
                        </td>
                        <td>
                          <button className="btn btn-ghost btn-xs" onClick={e => { e.stopPropagation(); reviewOne(t.id, "restore"); }} title="Move back to Draft">
                            <RotateCcw size={11} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                            {r.id.slice(0, 8)}…
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
                          {!["completed","running","failed"].includes(r.status) && <span className="badge badge-gray">{r.status}</span>}
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

      <Toast msg={toast.msg} type={toast.type} visible={toast.visible} onViewRun={toast.showLink} runId={toast.runId} />

      {/* Bulk action confirmation modal */}
      {bulkConfirm && (
        <>
          <div onClick={() => setBulkConfirm(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 999 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 1000, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "28px 32px", width: "min(420px,95vw)", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
            <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 10 }}>Confirm bulk action</div>
            <div style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: 20, lineHeight: 1.6 }}>
              You are about to <strong>{bulkConfirm.action}</strong> <strong>{bulkConfirm.ids.length} tests</strong> (all visible tests). This cannot be undone easily.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setBulkConfirm(null)}>Cancel</button>
              <button
                className={`btn btn-sm ${bulkConfirm.action === "approve" ? "btn-primary" : "btn-danger"}`}
                onClick={() => executeBulkAction(bulkConfirm.action, bulkConfirm.ids)}
              >
                {bulkConfirm.action === "approve" ? "Approve all" : "Reject all"}
              </button>
            </div>
          </div>
        </>
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

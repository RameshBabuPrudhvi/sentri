import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Search, Download, X, CheckCircle2, XCircle, Clock,
  ChevronRight, Loader2, Play, Flag, Sparkles,
  AlertCircle, ArrowUpDown, Trash2,
  ThumbsUp, ThumbsDown,
} from "lucide-react";
import { api } from "../api.js";
import { invalidateProjectDataCache } from "../hooks/useProjectData.js";
import GenerateTestModal from "../components/GenerateTestModal.jsx";
import CrawlProjectModal from "../components/CrawlProjectModal.jsx";
import AgentTag from "../components/AgentTag.jsx";
import RunRegressionModal from "../components/RunRegressionModal.jsx";
import ModalShell from "../components/ModalShell.jsx";
import { cleanTestName } from "../utils/formatTestName.js";
import { testTypeBadgeClass, testTypeLabel, isBddTest } from "../utils/testTypeLabels.js";
import { exportCsv } from "../utils/exportCsv.js";
import { StatusBadge, ScenarioBadges } from "../components/TestBadges.jsx";
import usePageTitle from "../hooks/usePageTitle.js";

// Exclude "All" sentinel entries — reset is handled by clicking an active filter
// or the explicit clear-all button in the bar.
const STATUS_FILTERS = [
  { key: "Passing", tooltip: "Passing",  activeColor: "#16a34a", activeBg: "rgba(34,197,94,0.12)",   icon: <CheckCircle2 size={14} /> },
  { key: "Failing", tooltip: "Failing",  activeColor: "#dc2626", activeBg: "rgba(239,68,68,0.12)",   icon: <XCircle      size={14} /> },
  { key: "Not Run", tooltip: "Not run",  activeColor: "#64748b", activeBg: "rgba(100,116,139,0.12)", icon: <Clock        size={14} /> },
];
const REVIEW_FILTERS = [
  { key: "Approved", tooltip: "Approved", activeColor: "#16a34a", activeBg: "rgba(34,197,94,0.12)",  icon: <ThumbsUp    size={14} /> },
  { key: "Draft",    tooltip: "Draft",    activeColor: "#d97706", activeBg: "rgba(217,119,6,0.12)",  icon: <AlertCircle size={14} /> },
];
const CATEGORY_FILTERS = [
  { key: "UI",  tooltip: "UI tests",  activeColor: "#7c3aed", activeBg: "rgba(124,58,237,0.12)", label: "UI"  },
  { key: "API", tooltip: "API tests", activeColor: "#2563eb", activeBg: "rgba(37,99,235,0.12)",  label: "🌐 API" },
];

const PAGE_SIZE = 10;

// ── Relative time utility ──────────────────────────────────────────────────────

const RELATIVE_UNITS = [
  { max: 60,          divisor: 1,       unit: "second"  },
  { max: 3600,        divisor: 60,      unit: "minute"  },
  { max: 86400,       divisor: 3600,    unit: "hour"    },
  { max: 2592000,     divisor: 86400,   unit: "day"     },
  { max: 31536000,    divisor: 2592000, unit: "month"   },
  { max: Infinity,    divisor: 31536000,unit: "year"    },
];

function relativeTime(dateStr) {
  if (!dateStr) return "—";
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 10) return "just now";
  for (const { max, divisor, unit } of RELATIVE_UNITS) {
    if (diff < max) {
      const val = Math.floor(diff / divisor);
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-val, unit);
    }
  }
  return "—";
}


// ── Review Modal ───────────────────────────────────────────────────────────────

function ReviewModal({ projects, onClose }) {
  const navigate = useNavigate();

  return (
    <ModalShell onClose={onClose} width="min(420px, 95vw)" style={{ overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 22px 16px", borderBottom: "1px solid var(--border)" }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>Review & Fix Tests</h2>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
      </div>
      <div style={{ padding: "20px 22px 24px" }}>
        <p style={{ fontSize: "0.82rem", color: "var(--text2)", marginTop: 0, marginBottom: 20, lineHeight: 1.6 }}>
          Go to a project to review generated draft tests, approve them for regression, or reject failing ones.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
          {projects.length === 0 ? (
            <div style={{ fontSize: "0.82rem", color: "var(--text3)", textAlign: "center", padding: "16px 0" }}>No projects yet.</div>
          ) : projects.map(p => (
            <button
              key={p.id}
              className="btn btn-ghost btn-sm"
              style={{ justifyContent: "flex-start", gap: 10 }}
              onClick={() => { onClose(); navigate(`/projects/${p.id}`); }}
            >
              <Flag size={13} color="var(--accent)" />
              {p.name}
              <ChevronRight size={13} style={{ marginLeft: "auto" }} />
            </button>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Empty State ────────────────────────────────────────────────────────────────

function EmptyState({ projects, tests, search, reviewFilter, onCreateTest, onClearSearch, onClearFilters, navigate }) {
  // No projects at all — first-time user
  if (projects.length === 0) {
    return (
      <div style={{ padding: "52px 40px", textAlign: "center" }}>
        <div style={{ fontSize: "2rem", marginBottom: 14 }}>🚀</div>
        <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 8, color: "var(--text)" }}>
          Welcome to Tests
        </div>
        <div style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: 8, lineHeight: 1.7, maxWidth: 380, margin: "0 auto 20px" }}>
          Start by creating a project. Sentri will crawl your app and AI-generate test cases for you to review and run.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
            Create first project
          </button>
        </div>
      </div>
    );
  }

  // Has projects, no tests at all — crawl hasn't been run yet
  if (tests.length === 0) {
    return (
      <div style={{ padding: "52px 40px", textAlign: "center" }}>
        <div style={{ fontSize: "2rem", marginBottom: 14 }}>🧪</div>
        <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 8, color: "var(--text)" }}>
          No tests generated yet
        </div>
        <div style={{ fontSize: "0.875rem", color: "var(--text2)", lineHeight: 1.7, maxWidth: 400, margin: "0 auto 20px" }}>
          Use <strong>Crawl</strong> above to auto-discover pages and generate tests, or <strong>Generate</strong> from a user story.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button className="btn btn-ghost btn-sm" onClick={onCreateTest}>
            Generate with AI ✦
          </button>
        </div>
      </div>
    );
  }

  // Has tests, but the active filter hides them all
  const draftCount  = tests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length;
  const approvedCount = tests.filter(t => t.reviewStatus === "approved").length;

  // Contextual hint based on which filter is active
  let hint = null;
  if (reviewFilter === "Approved" && draftCount > 0) {
    hint = (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 10,
        background: "var(--amber-bg)", border: "1px solid rgba(217,119,6,0.2)",
        borderRadius: "var(--radius)", padding: "10px 16px",
        fontSize: "0.82rem", color: "var(--amber)", marginBottom: 20, textAlign: "left",
      }}>
        <span style={{ fontSize: "1rem" }}>💡</span>
        <span>
          You have <strong>{draftCount} draft {draftCount === 1 ? "test" : "tests"}</strong> waiting for review.
          Switch to <strong>Draft</strong> to approve them and add them to your regression suite.
        </span>
      </div>
    );
  } else if (reviewFilter === "Draft" && approvedCount > 0) {
    hint = (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 10,
        background: "var(--blue-bg)", border: "1px solid rgba(37,99,235,0.15)",
        borderRadius: "var(--radius)", padding: "10px 16px",
        fontSize: "0.82rem", color: "var(--blue)", marginBottom: 20, textAlign: "left",
      }}>
        <span style={{ fontSize: "1rem" }}>ℹ️</span>
        <span>No draft tests — all <strong>{approvedCount}</strong> tests have already been reviewed.</span>
      </div>
    );
  }

  return (
    <div style={{ padding: "52px 40px", textAlign: "center" }}>
      <div style={{ fontSize: "2rem", marginBottom: 14 }}>🔍</div>
      <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 8, color: "var(--text)" }}>
        No tests match your filters
      </div>
      {hint && <div style={{ marginBottom: 4 }}>{hint}</div>}
      <div style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: 20 }}>
        {search ? `No results for "${search}".` : "Try adjusting your filters."}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <button className="btn btn-ghost btn-sm" onClick={onClearFilters}>
          Clear filters
        </button>
        <button className="btn btn-primary btn-sm" onClick={onCreateTest}>
          Generate with AI ✦
        </button>
      </div>
    </div>
  );
}

// ── Tests Page ─────────────────────────────────────────────────────────────────

export default function Tests() {
  usePageTitle("Tests");
  const [projects, setProjects] = useState([]);
  const [tests, setTests] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const search        = searchParams.get("q")        || "";
  const filter        = searchParams.get("status")   || "All";
  const reviewFilter  = searchParams.get("review")   || "All Tests";
  const categoryFilter= searchParams.get("category") || "All";

  const setSearch        = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set("q", v) : n.delete("q"); return n; }, { replace: true }), [setSearchParams]);
  const setFilter        = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "All" ? n.set("status", v) : n.delete("status"); return n; }, { replace: true }), [setSearchParams]);
  const setReviewFilter  = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "All Tests" ? n.set("review", v) : n.delete("review"); return n; }, { replace: true }), [setSearchParams]);
  const setCategoryFilter= useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "All" ? n.set("category", v) : n.delete("category"); return n; }, { replace: true }), [setSearchParams]);

  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCrawlModal, setShowCrawlModal] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [page, setPage] = useState(1);
  const [sortCol, setSortCol] = useState(null);   // "status" | "lastRun" | "project"
  const [sortDir, setSortDir] = useState("asc");   // "asc" | "desc"
  const [selected, setSelected] = useState(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(null); // {action, ids}
  const [bulkError, setBulkError] = useState(null);    // partial failure feedback
  const [hoveredRow, setHoveredRow] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const navigate = useNavigate();
  const searchRef = useRef(null);

  useEffect(() => {
    // Use batch getAllTests endpoint — falls back to per-project if not available.
    // Wrap in try/catch so a transient API error doesn't wipe existing state.
    async function load() {
      try {
        const [projs, allFromBatch] = await Promise.all([
          api.getProjects(),
          api.getAllTests().catch(() => null),
        ]);
        setProjects(projs);
        if (allFromBatch) {
          setTests(allFromBatch);
        } else {
          const all = await Promise.all(projs.map(p => api.getTests(p.id).catch(() => [])));
          setTests(all.flat());
        }
      } catch (err) {
        console.error("Tests page load error:", err);
        // Don't setProjects([]) / setTests([]) — keep whatever state we had
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ── Filter counts ────────────────────────────────────────────────────────────
  const statusCounts = useMemo(() => ({
    All:      tests.length,
    Passing:  tests.filter(t => t.lastResult === "passed").length,
    Failing:  tests.filter(t => t.lastResult === "failed").length,
    "Not Run": tests.filter(t => !t.lastResult).length,
  }), [tests]);

  const reviewCounts = useMemo(() => ({
    "All Tests": tests.length,
    Approved:    tests.filter(t => t.reviewStatus === "approved").length,
    Draft:       tests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length,
  }), [tests]);

  const isApiTest = useCallback(t => t.generatedFrom === "api_har_capture" || t.generatedFrom === "api_user_described", []);
  const categoryCounts = useMemo(() => ({
    All: tests.length,
    API: tests.filter(isApiTest).length,
    UI:  tests.filter(t => !isApiTest(t)).length,
  }), [tests, isApiTest]);

  const projMap = useMemo(
    () => Object.fromEntries(projects.map(p => [p.id, p])),
    [projects]
  );

  const filtered = useMemo(() => {
    const list = tests.filter(t => {
      const matchReview =
        reviewFilter === "All Tests" ? true :
        reviewFilter === "Approved" ? t.reviewStatus === "approved" :
        reviewFilter === "Draft" ? (!t.reviewStatus || t.reviewStatus === "draft") : true;
      const matchSearch = !search
        || t.name?.toLowerCase().includes(search.toLowerCase())
        || t.description?.toLowerCase().includes(search.toLowerCase());
      const matchFilter =
        filter === "All" ? true :
        filter === "Passing" ? t.lastResult === "passed" :
        filter === "Failing" ? t.lastResult === "failed" :
        filter === "Not Run" ? !t.lastResult : true;
      const matchCategory =
        categoryFilter === "All" ? true :
        categoryFilter === "API" ? isApiTest(t) :
        categoryFilter === "UI" ? !isApiTest(t) : true;
      return matchReview && matchSearch && matchFilter && matchCategory;
    });
    // Sorting
    if (sortCol) {
      list.sort((a, b) => {
        let av, bv;
        if (sortCol === "status") { av = a.lastResult || ""; bv = b.lastResult || ""; }
        else if (sortCol === "lastRun") { av = a.lastRunAt || ""; bv = b.lastRunAt || ""; }
        else if (sortCol === "project") { av = projMap[a.projectId]?.name || ""; bv = projMap[b.projectId]?.name || ""; }
        else if (sortCol === "reviewStatus") { av = a.reviewStatus || "draft"; bv = b.reviewStatus || "draft"; }
        else if (sortCol === "type") { av = a.type || ""; bv = b.type || ""; }
        else if (sortCol === "priority") { av = a.priority || "medium"; bv = b.priority || "medium"; }
        else { av = ""; bv = ""; }
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return list;
  }, [tests, reviewFilter, search, filter, categoryFilter, sortCol, sortDir, projMap]);

  // ── Pagination ─────────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, filter, reviewFilter, categoryFilter]);

  // ── Sorting ────────────────────────────────────────────────────────────────
  function toggleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  function SortHeader({ col, children }) {
    const active = sortCol === col;
    return (
      <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(col)}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {children}
          <ArrowUpDown size={10} style={{ opacity: active ? 1 : 0.3, color: active ? "var(--accent)" : "var(--text3)" }} />
        </span>
      </th>
    );
  }

  // ── Bulk select & actions ──────────────────────────────────────────────────
  function toggleSelect(testId) {
    setSelected(s => { const n = new Set(s); n.has(testId) ? n.delete(testId) : n.add(testId); return n; });
  }

  function toggleAll(checked, ids) {
    setSelected(checked ? new Set(ids) : new Set());
  }

  async function executeBulkAction(action, ids) {
    setBulkConfirm(null);
    setBulkError(null);
    if (!ids?.length) return;
    setActionLoading(action);

    // ── Optimistic update ───────────────────────────────────────────────
    // Immediately reflect the new reviewStatus in local state so the list
    // updates without waiting for the server round-trip. If any requests
    // fail, we roll back only those specific tests to their original status.
    const idSet = new Set(ids);
    const newStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : null;

    // Capture original statuses BEFORE the state update — React state updater
    // functions must be pure (no side effects). Reading from the current `tests`
    // snapshot is safe because it's a stable reference at this point in the handler.
    const originalStatuses = {};
    if (newStatus) {
      for (const t of tests) {
        if (idSet.has(t.id)) originalStatuses[t.id] = t.reviewStatus;
      }
      setTests(prev => prev.map(t =>
        idSet.has(t.id) ? { ...t, reviewStatus: newStatus } : t
      ));
    }

    try {
      // Use allSettled so one failure doesn't abort the rest of the batch
      const results = await Promise.allSettled(ids.map(testId => {
        const t = tests.find(x => x.id === testId);
        if (!t) return Promise.resolve();
        if (action === "approve") return api.approveTest(t.projectId, testId);
        if (action === "reject") return api.rejectTest(t.projectId, testId);
        return Promise.resolve();
      }));

      // Roll back only the tests that failed — keep the successful ones updated
      const failedIds = ids.filter((_, i) => results[i].status === "rejected");
      if (failedIds.length > 0) {
        const failedSet = new Set(failedIds);
        setTests(prev => prev.map(t =>
          failedSet.has(t.id) ? { ...t, reviewStatus: originalStatuses[t.id] } : t
        ));
        const failedCount = failedIds.length;
        console.warn(`Bulk ${action}: ${failedCount}/${ids.length} failed`);
        setBulkError(`${failedCount} of ${ids.length} tests failed to ${action}. The rest were updated successfully.`);
        setTimeout(() => setBulkError(null), 6000);
      }

      // Bust shared cache so other pages (Dashboard, Reports, etc.) see fresh data
      invalidateProjectDataCache();
      setSelected(new Set());
    } catch (err) {
      // Full failure — roll back all optimistic updates
      if (newStatus) {
        setTests(prev => prev.map(t =>
          idSet.has(t.id) ? { ...t, reviewStatus: originalStatuses[t.id] } : t
        ));
      }
      console.error("Bulk action failed:", err);
    } finally {
      setActionLoading(null);
    }
  }

  async function executeBulkDelete(ids) {
    setBulkConfirm(null);
    setBulkError(null);
    if (!ids?.length) return;
    setActionLoading("delete");
    try {
      // Group by projectId so we can call the bulk endpoint per project
      const byProject = {};
      ids.forEach(testId => {
        const t = tests.find(x => x.id === testId);
        if (t) {
          if (!byProject[t.projectId]) byProject[t.projectId] = [];
          byProject[t.projectId].push(testId);
        }
      });
      const results = await Promise.allSettled(
        Object.entries(byProject).map(([projectId, testIds]) =>
          api.bulkDeleteTests(projectId, testIds)
        )
      );
      const failedCount = results.filter(r => r.status === "rejected").length;
      if (failedCount > 0) {
        setBulkError(`Some tests failed to delete. The rest were removed successfully.`);
        setTimeout(() => setBulkError(null), 6000);
      }
      invalidateProjectDataCache();
      try {
        const allFromBatch = await api.getAllTests().catch(() => null);
        if (allFromBatch) { setTests(allFromBatch); }
        else {
          const all = await Promise.all(projects.map(p => api.getTests(p.id).catch(() => [])));
          if (all.flat().length > 0) setTests(all.flat());
        }
      } catch (refreshErr) {
        console.error("Refresh after bulk delete failed:", refreshErr);
      }
      setSelected(new Set());
    } catch (err) {
      console.error("Bulk delete failed:", err);
    } finally {
      setActionLoading(null);
    }
  }

  function requestBulkAction(action) {
    const ids = selected.size > 0
      ? Array.from(selected)
      : filtered.filter(t => !t.reviewStatus || t.reviewStatus === "draft").map(t => t.id);
    if (!ids.length) return;
    if (selected.size === 0 && ids.length > 1) {
      setBulkConfirm({ action, ids });
      return;
    }
    executeBulkAction(action, ids);
  }

  // ── Row actions ────────────────────────────────────────────────────────────
  async function runSingleTest(e, testId) {
    e.stopPropagation();
    setActionLoading(testId);
    try {
      const { runId } = await api.runSingleTest(testId);
      navigate(`/runs/${runId}`);
    } catch (err) { console.error("Run failed:", err); }
    finally { setActionLoading(null); }
  }

  async function deleteSingleTest(e, t) {
    e.stopPropagation();
    setActionLoading(t.id);
    try {
      await api.deleteTest(t.projectId, t.id);
      invalidateProjectDataCache();
      setTests(prev => prev.filter(x => x.id !== t.id));
      setSelected(s => { const n = new Set(s); n.delete(t.id); return n; });
    } catch (err) { console.error("Delete failed:", err); }
    finally { setActionLoading(null); }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function handler(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "a" && !e.metaKey && !e.ctrlKey && selected.size > 0) requestBulkAction("approve");
      if (e.key === "r" && !e.metaKey && !e.ctrlKey && selected.size > 0) requestBulkAction("reject");
      if (e.key === "Escape") setSelected(new Set());
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, filtered]);

  // ── Export filtered tests to CSV (fetches full test details including steps) ──
  const [exportLoading, setExportLoading] = useState(false);

  async function handleExportCSV() {
    if (filtered.length === 0) return;
    setExportLoading(true);
    try {
      // Fetch full test details for each filtered test so we get the steps array.
      // We batch with Promise.allSettled so a single failure doesn't abort the export.
      const fullTests = await Promise.allSettled(
        filtered.map(t => api.getTest(t.id))
      );

      const headers = [
        "Test ID", "Name", "Description", "Step #", "Step",
        "Project", "Priority", "Type", "Category", "Review Status",
        "Status", "Last Run At", "Created At", "Source URL", "Journey",
      ];

      const rows = [];
      fullTests.forEach((result, idx) => {
        const t = result.status === "fulfilled" ? result.value : filtered[idx];
        const steps = Array.isArray(t.steps) && t.steps.length > 0 ? t.steps : [""];
        steps.forEach((step, stepIdx) => {
          rows.push([
            stepIdx === 0 ? t.id : "",
            stepIdx === 0 ? cleanTestName(t.name) : "",
            stepIdx === 0 ? (t.description || "") : "",
            step ? stepIdx + 1 : "",
            step || "",
            stepIdx === 0 ? (projMap[t.projectId]?.name || "") : "",
            stepIdx === 0 ? (t.priority || "medium") : "",
            stepIdx === 0 ? (t.type || "") : "",
            stepIdx === 0 ? ((t.generatedFrom === "api_har_capture" || t.generatedFrom === "api_user_described") ? "API" : "UI") : "",
            stepIdx === 0 ? (t.reviewStatus || "draft") : "",
            stepIdx === 0 ? (t.lastResult || "") : "",
            stepIdx === 0 ? (t.lastRunAt || "") : "",
            stepIdx === 0 ? (t.createdAt || "") : "",
            stepIdx === 0 ? (t.sourceUrl || "") : "",
            stepIdx === 0 ? (t.isJourneyTest ? "Yes" : "No") : "",
          ]);
        });
      });

      exportCsv(headers, rows, `sentri-tests-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      console.error("CSV export failed:", err);
    } finally {
      setExportLoading(false);
    }
  }

  const draftCount = tests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length;

  const quickActions = [
    {
      icon: <Search size={16} />,
      title: "Crawl",
      desc: "Discover pages & auto-generate tests",
      color: "var(--blue-bg)",
      iconColor: "var(--blue)",
      action: () => projects.length === 0 ? navigate("/projects/new") : setShowCrawlModal(true),
    },
    {
      icon: <Sparkles size={16} />,
      title: "Generate",
      desc: "Create tests from a user story",
      color: "var(--accent-bg)",
      iconColor: "var(--accent)",
      action: () => projects.length === 0 ? navigate("/projects/new") : setShowCreateModal(true),
    },
    {
      icon: <Play size={16} />,
      title: "Run Tests",
      desc: "Execute approved regression suite",
      color: "var(--green-bg)",
      iconColor: "var(--green)",
      action: () => projects.length === 0 ? navigate("/projects/new") : setShowRunModal(true),
    },
    {
      icon: <Flag size={16} />,
      title: "Review Drafts",
      desc: draftCount > 0 ? `${draftCount} draft${draftCount !== 1 ? "s" : ""} pending review` : "Approve or reject generated tests",
      color: "var(--amber-bg)",
      iconColor: "var(--amber)",
      badge: draftCount > 0 ? draftCount : null,
      action: () => projects.length === 0 ? navigate("/projects/new") : setShowReviewModal(true),
    },
  ];

  return (
    <div className="fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Tests</h1>
          <p className="page-subtitle">
            Manage, run, and review test cases across all projects
          </p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleExportCSV}
          disabled={filtered.length === 0 || exportLoading}
          title={filtered.length === 0 ? "No tests to export" : `Export ${filtered.length} filtered test${filtered.length !== 1 ? "s" : ""} as CSV (includes test steps)`}
        >
          {exportLoading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          {exportLoading ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      {/* Quick Actions */}
      <div className="stat-grid mb-lg">
        {quickActions.map((a, i) => (
          <div
            key={i}
            className="card"
            style={{ padding: 16, cursor: "pointer", transition: "box-shadow 0.15s", position: "relative" }}
            onClick={a.action}
            onMouseEnter={e => e.currentTarget.style.boxShadow = "var(--shadow)"}
            onMouseLeave={e => e.currentTarget.style.boxShadow = ""}
          >
            {a.badge != null && (
              <span style={{
                position: "absolute", top: 10, right: 10,
                minWidth: 20, height: 20, borderRadius: 10,
                background: a.iconColor, color: "#fff",
                fontSize: "0.68rem", fontWeight: 700,
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "0 5px", lineHeight: 1,
              }}>
                {a.badge > 99 ? "99+" : a.badge}
              </span>
            )}
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{
                width: 34, height: 34, borderRadius: 9,
                background: a.color, display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: 16, flexShrink: 0, color: a.iconColor,
              }}>
                {a.icon}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.88rem", marginBottom: 2 }}>{a.title}</div>
                <div style={{ fontSize: "0.75rem", color: "var(--text2)", lineHeight: 1.5 }}>{a.desc}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tests table */}
      <div className="card tests-table">
        <div className="tests-filter-bar" style={{
          padding: "14px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem", flex: "0 0 auto" }}>
            {categoryFilter !== "All" ? `${categoryFilter} Tests` : reviewFilter === "Draft" ? "Draft Tests" : reviewFilter === "All Tests" ? "All Tests" : "Regression Tests"} ({filtered.length})
          </div>
          {/* Search — constrained width so it doesn't dominate the bar */}
          <div style={{ width: 220, flexShrink: 0, position: "relative" }}>
            <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
            <input
              ref={searchRef}
              className="input"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tests… (/)"
              style={{ paddingLeft: 28, paddingRight: search ? 30 : 12, height: 32, fontSize: "0.82rem" }}
            />
            {search && (
              <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 0, display: "flex" }}>
                <X size={13} />
              </button>
            )}
          </div>

          {/* Spacer pushes filter group to the right */}
          <div className="tests-filter-spacer" style={{ flex: 1 }} />

          {/* ── Icon-only filter pill bar ─────────────────────────────── */}
          <div className="tests-filter-pills" style={{
            display: "flex", alignItems: "center", gap: 1,
            background: "var(--bg2)", padding: "3px 4px",
            borderRadius: "var(--radius)", border: "1px solid var(--border)",
          }}>
            <span style={{ fontSize: "0.68rem", color: "var(--text3)", fontWeight: 600, padding: "0 6px 0 2px", userSelect: "none", letterSpacing: "0.02em" }}>
              Filters
            </span>

            {/* Status filter icons */}
            {STATUS_FILTERS.map(f => {
              const active = filter === f.key;
              const count  = statusCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  title={`${f.tooltip} · ${count} test${count !== 1 ? "s" : ""} · click again to clear`}
                  onClick={() => setFilter(active ? "All" : f.key)}
                  style={{
                    position: "relative",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 30, height: 28, borderRadius: 6, border: "none",
                    cursor: "pointer", transition: "background 0.12s, color 0.12s, box-shadow 0.12s",
                    background: active ? f.activeBg      : "transparent",
                    color:      active ? f.activeColor   : "var(--text3)",
                    boxShadow:  active ? `0 0 0 1.5px ${f.activeColor}55` : "none",
                  }}
                >
                  {f.icon}
                  {/* Count dot on active */}
                  {active && (
                    <span style={{
                      position: "absolute", top: 2, right: 2,
                      minWidth: 14, height: 14, borderRadius: 7,
                      background: f.activeColor, color: "#fff",
                      fontSize: "0.55rem", fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      lineHeight: 1, padding: "0 2px",
                    }}>
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Divider */}
            <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 3px", flexShrink: 0 }} />

            {/* Review filter icons */}
            {REVIEW_FILTERS.map(f => {
              const active = reviewFilter === f.key;
              const count  = reviewCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  title={`${f.tooltip} · ${count} test${count !== 1 ? "s" : ""} · click again to clear`}
                  onClick={() => setReviewFilter(active ? "All Tests" : f.key)}
                  style={{
                    position: "relative",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 30, height: 28, borderRadius: 6, border: "none",
                    cursor: "pointer", transition: "background 0.12s, color 0.12s, box-shadow 0.12s",
                    background: active ? f.activeBg      : "transparent",
                    color:      active ? f.activeColor   : "var(--text3)",
                    boxShadow:  active ? `0 0 0 1.5px ${f.activeColor}55` : "none",
                  }}
                >
                  {f.icon}
                  {active && (
                    <span style={{
                      position: "absolute", top: 2, right: 2,
                      minWidth: 14, height: 14, borderRadius: 7,
                      background: f.activeColor, color: "#fff",
                      fontSize: "0.55rem", fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      lineHeight: 1, padding: "0 2px",
                    }}>
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Divider */}
            <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 3px", flexShrink: 0 }} />

            {/* Category filter buttons (UI / API) */}
            {CATEGORY_FILTERS.map(f => {
              const active = categoryFilter === f.key;
              const count  = categoryCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  title={`${f.tooltip} · ${count} test${count !== 1 ? "s" : ""} · click again to clear`}
                  onClick={() => setCategoryFilter(active ? "All" : f.key)}
                  style={{
                    position: "relative",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    padding: "0 8px", height: 28, borderRadius: 6, border: "none",
                    cursor: "pointer", transition: "background 0.12s, color 0.12s, box-shadow 0.12s",
                    fontSize: "0.68rem", fontWeight: 600, whiteSpace: "nowrap",
                    background: active ? f.activeBg      : "transparent",
                    color:      active ? f.activeColor   : "var(--text3)",
                    boxShadow:  active ? `0 0 0 1.5px ${f.activeColor}55` : "none",
                  }}
                >
                  {f.label}
                  {active && (
                    <span style={{
                      marginLeft: 4,
                      minWidth: 14, height: 14, borderRadius: 7,
                      background: f.activeColor, color: "#fff",
                      fontSize: "0.55rem", fontWeight: 700,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      lineHeight: 1, padding: "0 2px",
                    }}>
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Clear-all button — only visible when any filter is active */}
            {(filter !== "All" || reviewFilter !== "All Tests" || categoryFilter !== "All") && (
              <>
                <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 3px", flexShrink: 0 }} />
                <button
                  title="Clear all filters"
                  onClick={() => { setFilter("All"); setReviewFilter("All Tests"); setCategoryFilter("All"); }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 28, height: 28, borderRadius: 6, border: "none",
                    cursor: "pointer", background: "rgba(239,68,68,0.08)", color: "var(--red)",
                    transition: "background 0.12s",
                  }}
                >
                  <X size={12} />
                </button>
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 24 }}>
            {[...Array(5)].map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8, borderRadius: 8 }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            projects={projects}
            tests={tests}
            search={search}
            reviewFilter={reviewFilter}
            onCreateTest={() => setShowCreateModal(true)}
            onClearSearch={() => setSearch("")}
            onClearFilters={() => { setSearch(""); setFilter("All"); setReviewFilter("All Tests"); setCategoryFilter("All"); }}
            navigate={navigate}
          />
        ) : (
          <>
            {/* Bulk action bar */}
            {selected.size > 0 && (
              <div className="tests-bulk-bar" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: "var(--accent-bg)", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.82rem", color: "var(--accent)", fontWeight: 500 }}>
                  {selected.size} selected
                </span>
                <button className="btn btn-sm" style={{ background: "var(--green-bg)", color: "var(--green)", border: "1px solid #86efac" }}
                  onClick={() => requestBulkAction("approve")} disabled={!!actionLoading}>
                  <ThumbsUp size={12} /> Approve
                </button>
                <button className="btn btn-sm" style={{ background: "var(--red-bg)", color: "var(--red)", border: "1px solid #fca5a5" }}
                  onClick={() => requestBulkAction("reject")} disabled={!!actionLoading}>
                  <ThumbsDown size={12} /> Reject
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear selection</button>
              </div>
            )}
            {/* Partial failure feedback from bulk actions */}
            {bulkError && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: "var(--amber-bg)", borderBottom: "1px solid var(--border)", fontSize: "0.82rem", color: "var(--amber)" }}>
                <AlertCircle size={13} />
                {bulkError}
                <button className="btn btn-ghost btn-xs" style={{ marginLeft: "auto" }} onClick={() => setBulkError(null)}>
                  <X size={11} />
                </button>
              </div>
            )}
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36, paddingRight: 0 }}>
                    <input type="checkbox"
                      checked={paged.length > 0 && paged.every(t => selected.has(t.id))}
                      onChange={e => toggleAll(e.target.checked, paged.map(t => t.id))}
                      style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                  </th>
                  <th>Test ID</th>
                  <th>Test Name</th>
                  <SortHeader col="project">Project</SortHeader>
                  <SortHeader col="priority">Priority</SortHeader>
                  <SortHeader col="type">Type</SortHeader>
                  <SortHeader col="reviewStatus">Review</SortHeader>
                  <SortHeader col="status">Status</SortHeader>
                  <SortHeader col="lastRun">Last Run</SortHeader>
                </tr>
              </thead>
              <tbody>
                {paged.map(t => {
                  const isSelected = selected.has(t.id);
                  const isHovered = hoveredRow === t.id;
                  return (
                    <tr
                      key={t.id}
                      style={{ cursor: "pointer", background: isSelected ? "var(--accent-bg)" : undefined }}
                      onClick={() => navigate(`/tests/${t.id}`)}
                      onMouseEnter={() => setHoveredRow(t.id)}
                      onMouseLeave={() => setHoveredRow(null)}
                    >
                      <td style={{ paddingRight: 0 }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(t.id)}
                          style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                      </td>
                      <td>
                        <span className="mono-id">
                          {t.id.length > 8 ? t.id.slice(0, 8) + "…" : t.id}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <AgentTag type="TA" />
                          <div>
                            <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{cleanTestName(t.name)}</div>
                            {t.description && (
                              <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 1, maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {t.description}
                              </div>
                            )}
                            <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                              <ScenarioBadges test={t} isBddTest={isBddTest} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {projMap[t.projectId] && (
                          <span
                            className="badge badge-gray"
                            style={{ cursor: "pointer" }}
                            onClick={e => { e.stopPropagation(); navigate(`/projects/${t.projectId}`); }}
                          >
                            {projMap[t.projectId].name}
                          </span>
                        )}
                      </td>
                      <td>
                        {t.priority === "high"
                          ? <span className="badge badge-red">High</span>
                          : t.priority === "low"
                            ? <span className="badge badge-gray">Low</span>
                            : t.priority
                              ? <span className="badge badge-gray" style={{ textTransform: "capitalize" }}>{t.priority}</span>
                              : null}
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {t.type && (
                            <span className={`badge ${testTypeBadgeClass(t.type)}`}>
                              {testTypeLabel(t.type, true)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {t.reviewStatus === "draft" && <span className="badge badge-amber">Draft</span>}
                          {t.reviewStatus === "approved" && <span className="badge badge-green">Approved</span>}
                          {t.reviewStatus === "rejected" && <span className="badge badge-red">Rejected</span>}
                        </div>
                      </td>
                      <td><StatusBadge result={t.lastResult} /></td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ fontSize: "0.8rem", color: "var(--text2)" }} title={t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : undefined}>
                            {relativeTime(t.lastRunAt)}
                          </span>
                          {isHovered && (
                            <div style={{ display: "flex", gap: 4, marginLeft: "auto" }} onClick={e => e.stopPropagation()}>
                              <button className="btn btn-ghost btn-xs" title="Run test" onClick={e => runSingleTest(e, t.id)} disabled={actionLoading === t.id}>
                                {actionLoading === t.id ? <Loader2 size={11} className="spin" /> : <Play size={11} />}
                              </button>
                              <button className="btn btn-ghost btn-xs" title="Delete test" onClick={e => deleteSingleTest(e, t)} disabled={actionLoading === t.id}>
                                <Trash2 size={11} />
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="tests-pagination" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
                <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>
                  {filtered.length} tests · page {page} of {totalPages}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-ghost btn-xs" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
                  <button className="btn btn-ghost btn-xs" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Keyboard shortcut hints */}
      {selected.size > 0 && (
        <div className="tests-kbd-hints" style={{ marginTop: 8, textAlign: "center", fontSize: "0.72rem", color: "var(--text3)" }}>
          <kbd style={{ padding: "1px 5px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>a</kbd> approve
          {" · "}
          <kbd style={{ padding: "1px 5px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>r</kbd> reject
          {" · "}
          <kbd style={{ padding: "1px 5px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>Esc</kbd> clear
        </div>
      )}

      {/* Modals */}
      {showCrawlModal && (
        <CrawlProjectModal
          projects={projects}
          onClose={() => setShowCrawlModal(false)}
          defaultProjectId={filtered[0]?.projectId || projects[0]?.id || ""}
        />
      )}
      {showCreateModal && (
        <GenerateTestModal
          projects={projects}
          onClose={() => setShowCreateModal(false)}
        />
      )}
      {showRunModal && (
        <RunRegressionModal projects={projects} onClose={() => setShowRunModal(false)} defaultProjectId={filtered[0]?.projectId || projects[0]?.id || ""} />
      )}
      {showReviewModal && (
        <ReviewModal projects={projects} onClose={() => setShowReviewModal(false)} />
      )}

      {/* Bulk action confirmation modal */}
      {bulkConfirm && (
        <ModalShell onClose={() => setBulkConfirm(null)} width="min(420px, 95vw)" style={{ padding: "28px 32px" }}>
          <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 10 }}>Confirm bulk action</div>
          <div style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: 20, lineHeight: 1.6 }}>
            You are about to <strong>{bulkConfirm.action}</strong> <strong>{bulkConfirm.ids.length} tests</strong> (all visible draft tests). This cannot be undone easily.
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
        </ModalShell>
      )}
    </div>
  );
}
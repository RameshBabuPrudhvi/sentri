import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Search, X, CheckCircle2, XCircle, Clock,
  Loader2, Play, Bot,
  AlertCircle, ArrowUpDown, Trash2, Inbox, Atom,
  Rocket, FlaskConical, SearchX,
} from "lucide-react";
import EmptyState from "../components/shared/EmptyState.jsx";
import { api } from "../api.js";
import useProjectData, { invalidateProjectDataCache } from "../hooks/useProjectData.js";
import { queryClient, projectDataQueryKeys } from "../queryClient.js";
import AgentTag from "../components/shared/AgentTag.jsx";
import RunRegressionModal from "../components/run/RunRegressionModal.jsx";
import ModalShell from "../components/shared/ModalShell.jsx";
import ProjectExportMenu from "../components/project/ProjectExportMenu.jsx";
import { cleanTestName } from "../utils/formatTestName.js";
import { fmtRelativeTimeFull } from "../utils/formatters.js";
import { testTypeBadgeClass, testTypeLabel, isBddTest } from "../utils/testTypeLabels.js";
import { StatusBadge, ScenarioBadges } from "../components/shared/TestBadges.jsx";
import usePageTitle from "../hooks/usePageTitle.js";
import TablePagination from "../components/shared/TablePagination.jsx";
import { useToast } from "../context/ToastContext.jsx";

// Exclude "All" sentinel entries — reset is handled by clicking an active filter
// or the explicit clear-all button in the bar.
const STATUS_FILTERS = [
  { key: "Passing", tooltip: "Passing",  activeColor: "#16a34a", activeBg: "rgba(34,197,94,0.12)",   icon: <CheckCircle2 size={14} /> },
  { key: "Failing", tooltip: "Failing",  activeColor: "#dc2626", activeBg: "rgba(239,68,68,0.12)",   icon: <XCircle      size={14} /> },
  { key: "Not Run", tooltip: "Not run",  activeColor: "#64748b", activeBg: "rgba(100,116,139,0.12)", icon: <Clock        size={14} /> },
];
const REVIEW_FILTERS = [
  { key: "Approved",      tooltip: "Human-approved",                  activeColor: "#16a34a", activeBg: "rgba(34,197,94,0.12)",  icon: <CheckCircle2 size={14} /> },
  // AUTO-003b: dedicated filter so reviewers can audit the auto-approved
  // bypass path without trawling the activity log.
  { key: "Auto-approved", tooltip: "Auto-approved (review for spot-check)", activeColor: "#7c3aed", activeBg: "rgba(124,58,237,0.12)", icon: <Bot size={14} /> },
  { key: "Draft",         tooltip: "Draft",                           activeColor: "#d97706", activeBg: "rgba(217,119,6,0.12)",  icon: <AlertCircle size={14} /> },
];
const CATEGORY_FILTERS = [
  { key: "UI",  tooltip: "UI tests",  activeColor: "#7c3aed", activeBg: "rgba(124,58,237,0.12)", label: "UI"  },
  { key: "API", tooltip: "API tests", activeColor: "#2563eb", activeBg: "rgba(37,99,235,0.12)",  label: "🌐 API" },
];

const PAGE_SIZE = 10;

// ── Empty State ────────────────────────────────────────────────────────────────

/**
 * ONB-002 (audit) — Tests-page empty state. Branches over (no projects ⇒
 * onboarding) → (has projects but no tests ⇒ generate-prompt) → (filtered
 * to nothing ⇒ clear-filters). Delegates to the shared `<EmptyState>`
 * primitive at `components/shared/EmptyState.jsx` so the icon + title +
 * description + CTA shape stays uniform across Tests / Projects / Runs /
 * Healing. Inline styles previously used here are gone — the primitive
 * relies on the existing `.empty-state*` classes.
 */
function TestsEmptyState({ projects, tests, search, reviewFilter, onCreateTest, onClearFilters, navigate }) {
  // No projects at all — first-time onboarding surface.
  if (projects.length === 0) {
    return (
      <EmptyState
        variant="bare"
        icon={<Rocket size={32} color="var(--accent)" />}
        title="Welcome to Tests"
        description="Start by creating a project. Sentri will crawl your app and AI-generate test cases for you to review and run."
        action={{ label: "Create first project", onClick: () => navigate("/projects/new") }}
      />
    );
  }

  // Has projects, no tests at all — crawl hasn't been run yet.
  if (tests.length === 0) {
    return (
      <EmptyState
        variant="bare"
        icon={<FlaskConical size={32} color="var(--accent)" />}
        title="No tests generated yet"
        description={
          <>Use <strong>Crawl</strong> above to auto-discover pages and generate tests, or <strong>Generate</strong> from a requirement.</>
        }
        action={{ label: "Generate with AI ✦", onClick: onCreateTest, variant: "ghost" }}
      />
    );
  }

  // Has tests, but the active filter hides them all. Surface a contextual
  // hint (drafts pending review / no drafts left) so the user knows whether
  // to switch tabs or generate more — same coaching shape as ReviewQueue.
  const draftCount    = tests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length;
  const approvedCount = tests.filter(t => t.reviewStatus === "approved").length;

  let hint = null;
  if (reviewFilter === "Approved" && draftCount > 0) {
    hint = (
      <div className="banner banner-warning mb-md text-left">
        <span>💡</span>
        <span>
          You have <strong>{draftCount} draft {draftCount === 1 ? "test" : "tests"}</strong> waiting for review.
          Switch to <strong>Draft</strong> to approve them and add them to your regression suite.
        </span>
      </div>
    );
  } else if (reviewFilter === "Draft" && approvedCount > 0) {
    hint = (
      <div className="banner banner-info mb-md text-left">
        <span>ℹ️</span>
        <span>No draft tests — all <strong>{approvedCount}</strong> tests have already been reviewed.</span>
      </div>
    );
  }

  return (
    <EmptyState
      variant="bare"
      icon={<SearchX size={32} color="var(--text3)" />}
      title="No tests match your filters"
      description={search ? `No results for "${search}".` : "Try adjusting your filters."}
      hint={hint}
      secondaryAction={{ label: "Clear filters", onClick: onClearFilters }}
      action={{ label: "Generate with AI ✦", onClick: onCreateTest }}
    />
  );
}

// ── Tests Page ─────────────────────────────────────────────────────────────────

export default function Tests() {
  usePageTitle("Tests");
  const { projects, allTests: tests, loading } = useProjectData({ fetchRuns: false });
  const [searchParams, setSearchParams] = useSearchParams();

  // Mutate every cached tests query (regardless of projectIds suffix) so
  // optimistic updates surface immediately on every consumer.
  const updateTestsCache = useCallback((updater) => {
    queryClient.setQueriesData({ queryKey: projectDataQueryKeys.tests }, (prev) =>
      Array.isArray(prev) ? updater(prev) : prev,
    );
  }, []);
  const search        = searchParams.get("q")        || "";
  const filter        = searchParams.get("status")   || "All";
  const reviewFilter  = searchParams.get("review")   || "All Tests";
  const categoryFilter= searchParams.get("category") || "All";
  const staleFilter   = searchParams.get("stale")    === "true";

  const setSearch        = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set("q", v) : n.delete("q"); return n; }, { replace: true }), [setSearchParams]);
  const setFilter        = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "All" ? n.set("status", v) : n.delete("status"); return n; }, { replace: true }), [setSearchParams]);
  const setReviewFilter  = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "All Tests" ? n.set("review", v) : n.delete("review"); return n; }, { replace: true }), [setSearchParams]);
  const setCategoryFilter= useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "All" ? n.set("category", v) : n.delete("category"); return n; }, { replace: true }), [setSearchParams]);
  const setStaleFilter   = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set("stale", "true") : n.delete("stale"); return n; }, { replace: true }), [setSearchParams]);

  const [showRunModal, setShowRunModal] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("all");
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
  const { showToast } = useToast();

  // ── Filter counts ────────────────────────────────────────────────────────────
  const statusCounts = useMemo(() => ({
    All:      tests.length,
    Passing:  tests.filter(t => t.lastResult === "passed").length,
    Failing:  tests.filter(t => t.lastResult === "failed").length,
    "Not Run": tests.filter(t => !t.lastResult).length,
  }), [tests]);

  const reviewCounts = useMemo(() => ({
    "All Tests":     tests.length,
    // "Approved" = human-approved only — keeps the green badge honest
    // (auto-approved tests are surfaced via their own pill, per AUTO-003b).
    Approved:        tests.filter(t => t.reviewStatus === "approved" && t.approvalSource !== "auto").length,
    "Auto-approved": tests.filter(t => t.reviewStatus === "approved" && t.approvalSource === "auto").length,
    Draft:           tests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length,
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
      // Project filter — mirrors the Review Queue's project dropdown
      if (selectedProjectId !== "all" && t.projectId !== selectedProjectId) return false;
      const matchReview =
        reviewFilter === "All Tests" ? true :
        reviewFilter === "Approved" ? (t.reviewStatus === "approved" && t.approvalSource !== "auto") :
        reviewFilter === "Auto-approved" ? (t.reviewStatus === "approved" && t.approvalSource === "auto") :
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
      const matchStale = !staleFilter || t.isStale;
      return matchReview && matchSearch && matchFilter && matchCategory && matchStale;
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
  }, [tests, reviewFilter, search, filter, categoryFilter, staleFilter, selectedProjectId, sortCol, sortDir, projMap]);

  // ── Pagination ─────────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, filter, reviewFilter, categoryFilter, staleFilter, selectedProjectId]);

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
      <th className="t-sort-th" onClick={() => toggleSort(col)}>
        <span className="t-sort-th__inner">
          {children}
          <ArrowUpDown size={10} className={active ? "t-sort-icon--active" : "t-sort-icon"} />
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
      // Count actual test IDs that succeeded — NOT `ids.length - failedCount`
      // which mixes test-ID count with project-group count.
      const successCount = Object.entries(byProject)
        .filter((_, i) => results[i].status === "fulfilled")
        .reduce((n, [, pIds]) => n + pIds.length, 0);
      if (failedCount > 0) {
        setBulkError(`Some tests failed to delete. The rest were removed successfully.`);
        setTimeout(() => setBulkError(null), 6000);
        showToast(`${failedCount} test${failedCount !== 1 ? "s" : ""} failed to delete.`, "error");
      }
      if (successCount > 0) {
        showToast(`${successCount} test${successCount !== 1 ? "s" : ""} moved to recycle bin`, "success");
      }

      // ── Optimistic cache removal ─────────────────────────────────────
      // Drop the successfully-deleted tests from the cache immediately so the
      // UI updates the moment `actionLoading` clears in the finally block —
      // matches the pattern used by deleteSingleTest and executeBulkAction.
      // Without this, the fire-and-forget invalidate below would leave the
      // deleted tests visible until the background refetch resolves.
      const successfullyDeleted = new Set(
        Object.entries(byProject).flatMap(([, ids], i) =>
          results[i].status === "fulfilled" ? ids : [],
        ),
      );
      if (successfullyDeleted.size > 0) {
        updateTestsCache(prev => prev.filter(t => !successfullyDeleted.has(t.id)));
      }

      // Invalidate the shared cache so other pages (Dashboard, ProjectDetail,
      // Reports) see the deletion on next render. Fire-and-forget — the
      // optimistic patch above already updated the local view.
      invalidateProjectDataCache();
      setSelected(new Set());
    } catch (err) {
      console.error("Bulk delete failed:", err);
      showToast(err.message || "Bulk delete failed.", "error");
    } finally {
      setActionLoading(null);
    }
  }

  // ── Row actions ────────────────────────────────────────────────────────────
  async function runSingleTest(e, testId) {
    e.stopPropagation();
    setActionLoading(testId);
    try {
      const { runId } = await api.runSingleTest(testId);
      showToast("Test run started", "success");
      navigate(`/runs/${runId}`);
    } catch (err) {
      console.error("Run failed:", err);
      showToast(err.message || "Failed to start test run.", "error");
    }
    finally { setActionLoading(null); }
  }

  async function deleteSingleTest(e, t) {
    e.stopPropagation();
    setActionLoading(t.id);
    try {
      await api.deleteTest(t.projectId, t.id);
      updateTestsCache(prev => prev.filter(x => x.id !== t.id));
      invalidateProjectDataCache();
      setSelected(s => { const n = new Set(s); n.delete(t.id); return n; });
      showToast("Test moved to recycle bin", "success");
    } catch (err) {
      console.error("Delete failed:", err);
      showToast(err.message || "Failed to delete test.", "error");
    }
    finally { setActionLoading(null); }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function handler(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "Escape") setSelected(new Set());
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, filtered]);

  // Scope the draft chip's count + click target to the selected project so the
  // chip reads the same way the rest of the page does — when the user has
  // narrowed to one project, the Review Queue link should land them there too.
  const draftCount = tests.filter(t =>
    (!t.reviewStatus || t.reviewStatus === "draft") &&
    (selectedProjectId === "all" || t.projectId === selectedProjectId)
  ).length;

  // ── Export: unified with ProjectDetail via ProjectExportMenu (Zephyr / TestRail / Playwright ZIP).
  // All three export targets are project-scoped server-side, so the menu
  // surfaces one dropdown per project that has tests in the current workspace.
  const projectsWithTests = useMemo(() => {
    const counts = {};
    for (const t of tests) {
      if (!counts[t.projectId]) counts[t.projectId] = { total: 0, approved: 0 };
      counts[t.projectId].total += 1;
      if (t.reviewStatus === "approved") counts[t.projectId].approved += 1;
    }
    return projects.filter(p => counts[p.id]?.total > 0).map(p => ({
      ...p,
      totalTests: counts[p.id].total,
      approvedTests: counts[p.id].approved,
    }));
  }, [projects, tests]);

  return (
    <div className="fade-in">
      {/* ── Header ── */}
      <div className="page-header t-page-header">
        <div>
          <h1 className="page-title">Tests</h1>
          <p className="page-subtitle">Manage, run, and review test cases across all projects</p>
        </div>
        {/* Right-side controls: project dropdown + export — mirrors the
            Review Queue header (`.rq-header` / `.at-header__controls`)
            so the two audit surfaces share a layout vocabulary. */}
        <div className="t-header-controls">
          {projects.length > 1 && (
            <select
              className="input tests-header-select"
              value={selectedProjectId}
              onChange={e => setSelectedProjectId(e.target.value)}
              aria-label="Filter by project"
            >
              <option value="all">All projects</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          {projectsWithTests.length > 0 && (() => {
            const exportProject = selectedProjectId !== "all"
              ? projectsWithTests.find(p => p.id === selectedProjectId)
              : projectsWithTests[0];
            if (!exportProject) return null;
            return (
              <ProjectExportMenu
                projectId={exportProject.id}
                totalTests={exportProject.totalTests}
                approvedCount={exportProject.approvedTests}
                label="Export"
                buttonClassName="btn btn-ghost btn-sm"
              />
            );
          })()}
        </div>
      </div>

      {/* ── Quick Actions ──
          Three-card grid: Test Lab (creation), Review Drafts (approval),
          Run Tests (execution) — mirrors the three-pane mental model the
          Review Queue PR formalised (creation → approval → execution).
          Cards stay project-aware: when a single project is selected in
          the dropdown, deep-links carry `?projectId=…`/`/projects/:id/…`
          so the user lands in the same scope they're filtering on. */}
      <div className="stat-grid mb-lg t-quick-grid">
        {[
          {
            icon: <Atom size={16} />,
            title: "Test Lab",
            desc: "Crawl an app or generate from a requirement",
            color: "var(--accent-bg)",
            iconColor: "var(--accent)",
            action: () => projects.length === 0
              ? navigate("/projects/new")
              : navigate(selectedProjectId !== "all"
                  ? `/projects/${selectedProjectId}/test-lab`
                  : "/test-lab"),
          },
          {
            icon: <Inbox size={16} />,
            title: "Review Drafts",
            desc: draftCount > 0
              ? `${draftCount} draft${draftCount !== 1 ? "s" : ""} pending review`
              : "Approve or reject generated tests",
            color: "var(--amber-bg)",
            iconColor: "var(--amber)",
            badge: draftCount > 0 ? draftCount : null,
            action: () => projects.length === 0
              ? navigate("/projects/new")
              : navigate(selectedProjectId !== "all"
                  ? `/review-queue?projectId=${selectedProjectId}`
                  : "/review-queue"),
          },
          {
            icon: <Play size={16} />,
            title: "Run Tests",
            desc: "Execute approved regression suite",
            color: "var(--green-bg)",
            iconColor: "var(--green)",
            action: () => projects.length === 0 ? navigate("/projects/new") : setShowRunModal(true),
          },
        ].map((a, i) => (
          // `:hover` box-shadow is now in CSS (`.t-quick-card:hover`) — drops
          // the previous onMouseEnter / onMouseLeave handlers entirely.
          // Per-card colours flow through CSS custom properties (`--t-card-bg`
          // / `--t-card-fg` / `--t-badge-bg`) — only the data-driven swatch
          // values stay inline, per AGENT.md §127.
          <div
            key={i}
            className="card t-quick-card"
            style={{ "--t-card-bg": a.color, "--t-card-fg": a.iconColor, "--t-badge-bg": a.iconColor }}
            onClick={a.action}
          >
            {a.badge != null && (
              <span className="t-quick-badge">
                {a.badge > 99 ? "99+" : a.badge}
              </span>
            )}
            <div className="t-quick-body">
              <div className="t-quick-icon">{a.icon}</div>
              <div>
                <div className="t-quick-title">{a.title}</div>
                <div className="t-quick-desc">{a.desc}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

            {/* Tests table */}
      <div className="card tests-table">
        <div className="tests-filter-bar t-toolbar">
          <div className="t-toolbar-title">
            {categoryFilter !== "All" ? `${categoryFilter} Tests` : reviewFilter === "Draft" ? "Draft Tests" : reviewFilter === "All Tests" ? "All Tests" : "Regression Tests"} ({filtered.length})
          </div>
          {/* Search — constrained width so it doesn't dominate the bar */}
          <div className="t-search-wrap">
            <Search size={13} color="var(--text3)" className="t-search-icon" />
            <input
              ref={searchRef}
              className={`input t-search-input${search ? " t-search-input--has-clear" : ""}`}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tests… (/)"
            />
            {search && (
              <button onClick={() => setSearch("")} className="t-search-clear">
                <X size={13} />
              </button>
            )}
          </div>

          {/* Spacer pushes filter group to the right — `flex: 1` lives on
              the existing `.tests-filter-spacer` rule in tests.css. */}
          <div className="tests-filter-spacer" />

          {/* ── Icon-only filter pill bar ─────────────────────────────── */}
          <div className="tests-filter-pills t-pill-group">
            <span className="t-pill-group__label">Filters</span>

            {/* Status filter icons. The pill shell + count dot are CSS
                (`.t-pill` / `.t-pill-count`); per-filter colours flow
                through CSS custom properties so the rule cascade stays
                in one place. AGENT.md §127 carve-out for data-driven
                colour. */}
            {STATUS_FILTERS.map(f => {
              const active = filter === f.key;
              const count  = statusCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  title={`${f.tooltip} · ${count} test${count !== 1 ? "s" : ""} · click again to clear`}
                  onClick={() => setFilter(active ? "All" : f.key)}
                  className={`t-pill${active ? " t-pill--active" : ""}`}
                  style={active ? {
                    "--t-active-bg": f.activeBg,
                    "--t-active-color": f.activeColor,
                    "--t-active-shadow": `${f.activeColor}55`,
                  } : undefined}
                >
                  {f.icon}
                  {active && (
                    <span className="t-pill-count">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="t-pill-divider" />

            {/* Review filter icons — same `.t-pill` pattern as Status above. */}
            {REVIEW_FILTERS.map(f => {
              const active = reviewFilter === f.key;
              const count  = reviewCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  title={`${f.tooltip} · ${count} test${count !== 1 ? "s" : ""} · click again to clear`}
                  onClick={() => setReviewFilter(active ? "All Tests" : f.key)}
                  className={`t-pill${active ? " t-pill--active" : ""}`}
                  style={active ? {
                    "--t-active-bg": f.activeBg,
                    "--t-active-color": f.activeColor,
                    "--t-active-shadow": `${f.activeColor}55`,
                  } : undefined}
                >
                  {f.icon}
                  {active && (
                    <span className="t-pill-count">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="t-pill-divider" />

            {/* Category filter buttons (UI / API) — text-label `.t-pill-text` variant */}
            {CATEGORY_FILTERS.map(f => {
              const active = categoryFilter === f.key;
              const count  = categoryCounts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  title={`${f.tooltip} · ${count} test${count !== 1 ? "s" : ""} · click again to clear`}
                  onClick={() => setCategoryFilter(active ? "All" : f.key)}
                  className={`t-pill-text${active ? " t-pill-text--active" : ""}`}
                  style={active ? {
                    "--t-active-bg": f.activeBg,
                    "--t-active-color": f.activeColor,
                    "--t-active-shadow": `${f.activeColor}55`,
                  } : undefined}
                >
                  {f.label}
                  {active && (
                    <span className="t-pill-count t-pill-count--inline">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="t-pill-divider" />

            {/* Stale filter (AUTO-013) — fixed slate-500 palette, not per-filter colour */}
            <button
              title={`Stale tests · ${tests.filter(t => t.isStale).length} test${tests.filter(t => t.isStale).length !== 1 ? "s" : ""} · click again to clear`}
              onClick={() => setStaleFilter(!staleFilter)}
              className={`t-pill-text${staleFilter ? " t-pill-stale--active" : ""}`}
            >
              <Clock size={12} /> Stale
              {staleFilter && (
                <span className="t-pill-count t-pill-count--inline">
                  {tests.filter(t => t.isStale).length > 99 ? "99+" : tests.filter(t => t.isStale).length}
                </span>
              )}
            </button>

            {/* Clear-all button — only visible when any filter is active */}
            {(filter !== "All" || reviewFilter !== "All Tests" || categoryFilter !== "All" || staleFilter) && (
              <>
                <div className="t-pill-divider" />
                <button
                  title="Clear all filters"
                  onClick={() => { setFilter("All"); setReviewFilter("All Tests"); setCategoryFilter("All"); setStaleFilter(false); }}
                  className="t-clear-btn"
                >
                  <X size={12} />
                </button>
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div className="t-loading-block">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="skeleton t-loading-row" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <TestsEmptyState
            projects={projects}
            tests={tests}
            search={search}
            reviewFilter={reviewFilter}
            onCreateTest={() => navigate(`/projects/${projects[0]?.id || ""}/test-lab?tab=requirement`)}
            onClearFilters={() => { setSearch(""); setFilter("All"); setReviewFilter("All Tests"); setCategoryFilter("All"); setStaleFilter(false); }}
            navigate={navigate}
          />
        ) : (
          <>
            {/* Bulk action bar — delete only (review actions live in Review Queue) */}
            {selected.size > 0 && (
              <div className="tests-bulk-bar t-bulk-bar">
                <span className="t-bulk-label">
                  {selected.size} selected
                </span>
                <button
                  className="btn btn-sm t-bulk-delete"
                  onClick={() => {
                    const ids = Array.from(selected);
                    if (ids.length > 1) setBulkConfirm({ action: "delete", ids });
                    else executeBulkDelete(ids);
                  }}
                  disabled={!!actionLoading}
                >
                  <Trash2 size={12} /> Delete
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear selection</button>
              </div>
            )}
            {/* Partial failure feedback from bulk actions */}
            {bulkError && (
              <div className="t-bulk-error">
                <AlertCircle size={13} />
                {bulkError}
                <button className="btn btn-ghost btn-xs t-bulk-error__dismiss" onClick={() => setBulkError(null)}>
                  <X size={11} />
                </button>
              </div>
            )}
            <table className="table">
              <thead>
                <tr>
                  <th className="t-th-checkbox">
                    <input type="checkbox"
                      checked={paged.length > 0 && paged.every(t => selected.has(t.id))}
                      onChange={e => toggleAll(e.target.checked, paged.map(t => t.id))}
                      className="t-checkbox" />
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
                      className={`t-row${isSelected ? " t-row--selected" : ""}`}
                      onClick={() => navigate(`/tests/${t.id}`)}
                      onMouseEnter={() => setHoveredRow(t.id)}
                      onMouseLeave={() => setHoveredRow(null)}
                    >
                      <td className="t-td-checkbox" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(t.id)}
                          className="t-checkbox" />
                      </td>
                      <td>
                        <span className="mono-id">
                          {t.id.length > 8 ? t.id.slice(0, 8) + "…" : t.id}
                        </span>
                      </td>
                      <td>
                        <div className="t-name-cell">
                          <AgentTag type="TA" />
                          <div>
                            <div className="t-name-title">{cleanTestName(t.name)}</div>
                            {t.description && (
                              <div className="t-name-desc">
                                {t.description}
                              </div>
                            )}
                            <div className="t-name-tags">
                              <ScenarioBadges test={t} isBddTest={isBddTest} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {projMap[t.projectId] && (
                          <span
                            className="badge badge-gray t-project-badge"
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
                              ? <span className="badge badge-gray t-priority-cap">{t.priority}</span>
                              : null}
                      </td>
                      <td>
                        <div className="t-type-cell">
                          {t.type && (
                            <span className={`badge ${testTypeBadgeClass(t.type)}`}>
                              {testTypeLabel(t.type, true)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        {/* AUTO-003b: two-tone badge column.
                            🤖 Auto · 0.91 (purple) vs 👤 Human (green) vs
                            📝 Draft · 0.62 (amber). Provenance must be
                            visible at table density — never hover-only
                            (NEXT.md anti-pattern). */}
                        <div className="tests-review-cell">
                          {(!t.reviewStatus || t.reviewStatus === "draft") && (
                            <span className="badge badge-amber tests-review-badge">
                              📝 Draft
                              {Number.isFinite(t.confidenceScore) && (
                                <span className="tests-review-badge__score">
                                  · {t.confidenceScore.toFixed(2)}
                                </span>
                              )}
                            </span>
                          )}
                          {t.reviewStatus === "approved" && t.approvalSource === "auto" && (
                            <span
                              className="badge tests-review-badge tests-review-badge--auto"
                              aria-label={`Auto-approved at confidence ${t.confidenceScore?.toFixed?.(2) ?? "?"} (threshold ${t.approvalThreshold?.toFixed?.(2) ?? "?"})`}
                            >
                              🤖 Auto
                              {Number.isFinite(t.confidenceScore) && (
                                <span className="tests-review-badge__score">· {t.confidenceScore.toFixed(2)}</span>
                              )}
                            </span>
                          )}
                          {t.reviewStatus === "approved" && t.approvalSource !== "auto" && (
                            <span className="badge badge-green tests-review-badge">
                              👤 Human
                            </span>
                          )}
                          {t.reviewStatus === "rejected" && <span className="badge badge-red">Rejected</span>}
                        </div>
                      </td>
                      <td><StatusBadge result={t.lastResult} /></td>
                      <td>
                        <div className="t-lastrun-cell">
                          <span className="t-lastrun-text" title={t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : undefined}>
                            {fmtRelativeTimeFull(t.lastRunAt)}
                          </span>
                          {isHovered && (
                            <div className="t-hover-actions" onClick={e => e.stopPropagation()}>
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
            <TablePagination
              total={filtered.length}
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              label="tests"
            />
          </>
        )}
      </div>



      {/* Modals */}
      {/* CrawlProjectModal and GenerateTestModal have been migrated to the
          dedicated Test Lab page (/projects/:id/test-lab) — the quick-action
          cards above now navigate there instead of opening modals. */}
      {showRunModal && (
        <RunRegressionModal projects={projects} onClose={() => setShowRunModal(false)} defaultProjectId={filtered[0]?.projectId || projects[0]?.id || ""} />
      )}

      {/* Bulk delete confirmation modal */}
      {bulkConfirm && bulkConfirm.action === "delete" && (
        <ModalShell onClose={() => setBulkConfirm(null)} width="min(420px, 95vw)" ariaLabelledBy="tests-bulk-delete-title" className="t-modal-padding">
          <div id="tests-bulk-delete-title" className="modal-title">Delete {bulkConfirm.ids.length} tests?</div>
          <div className="t-modal-body">
            These tests will be moved to the recycle bin. This cannot be undone easily.
          </div>
          <div className="t-modal-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setBulkConfirm(null)}>Cancel</button>
            <button className="btn btn-danger btn-sm" onClick={() => executeBulkDelete(bulkConfirm.ids)}>
              Delete {bulkConfirm.ids.length} tests
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
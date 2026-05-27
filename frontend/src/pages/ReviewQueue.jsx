/**
 * @module pages/ReviewQueue
 * @description Two-pane review inbox for AI-generated draft tests.
 *
 * Left pane  — sortable, filterable list of draft (or rejected/approved) tests
 *              across all projects. Checkbox multi-select + bulk approve/reject.
 * Right pane — selected test detail: steps, generated code, quality score,
 *              metadata, and Approve / Reject / Edit decision buttons.
 *
 * Routing: /review-queue   (also reachable with ?projectId=PRJ-x to pre-filter)
 * CSS:     styles/pages/review-queue.css
 *
 * Backend: all required endpoints already exist — no new routes needed.
 *   GET  /projects/:id/tests?reviewStatus=draft   — via useProjectData
 *   PATCH /projects/:id/tests/:testId/approve
 *   PATCH /projects/:id/tests/:testId/reject
 *   POST  /projects/:id/tests/bulk  { testIds, action }
 */

import React, {
  useState, useMemo, useEffect, useRef,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  CheckCircle2, XCircle, ArrowLeft, RotateCcw,
  Search, X, Loader2, ExternalLink, Copy,
  ThumbsUp, ThumbsDown, AlertCircle, Trash2,
} from "lucide-react";
import { api } from "../api.js";
import useProjectData, { invalidateProjectDataCache } from "../hooks/useProjectData.js";
import useReviewQueueQuery, { useReviewQueueCounts, invalidateReviewQueueCache } from "../hooks/queries/useReviewQueueQuery.js";
import useAutoApprovalsQuery from "../hooks/queries/useAutoApprovalsQuery.js";
import { invalidateAutoApprovalsCache } from "../queryClient.js";
import usePageTitle from "../hooks/usePageTitle.js";
import { useAuth } from "../context/AuthContext.jsx";
import { userHasRole } from "../utils/roles.js";
import { cleanTestName } from "../utils/formatTestName.js";
import { fmtRelativeTimeFull } from "../utils/formatters.js";
import { testTypeBadgeClass, testTypeLabel } from "../utils/testTypeLabels.js";
import { ReviewBadge, StatusBadge } from "../components/shared/TestBadges.jsx";
import ModalShell from "../components/shared/ModalShell.jsx";
import { QualityScoreChip, qualityTierKey } from "../components/shared/QualityScoreChip.jsx";
import { useToast } from "../context/ToastContext.jsx";
import highlightCode from "../utils/highlightCode.js";
import "../styles/pages/review-queue.css";

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: "draft",    label: "Draft",    emptyLabel: "No drafts" },
  { id: "rejected", label: "Rejected", emptyLabel: "No rejected tests" },
  { id: "approved", label: "Approved", emptyLabel: "No approved tests" },
];

// Sort options. `newest` / `oldest` / `quality` / `name` are server-side
// (mapped to `SORT_BY_CLAUSES` in `backend/src/database/repositories/testRepo.js`)
// so they apply BEFORE pagination — the chosen order spans all pages, not
// just the current one. `project` is intentionally omitted: project names
// live in the `projects` table and require a JOIN; the cross-project list
// query is hot-path enough to keep simple, and the existing project-filter
// dropdown (top-right) covers the "narrow to one project" case directly.
const SORT_OPTIONS = [
  { id: "newest",  label: "Newest first"   },
  { id: "oldest",  label: "Oldest first"   },
  { id: "quality", label: "Quality score"  },
  { id: "name",    label: "Name (A→Z)"     },
];

// ── Inline code viewer with copy ──────────────────────────────────────────────
function CodeView({ code }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard unavailable */ });
  }

  const highlighted = useMemo(
    () => code ? highlightCode(code) : null,
    [code],
  );

  if (!code) return null;

  return (
    <div className="rq-code-wrap">
      <div className="rq-code-toolbar">
        {/* Generated Playwright code is JavaScript — the chip used to read
            "TypeScript" which was incorrect and misled reviewers about
            what language the snippet would run as. Audit §6.1. */}
        <span className="rq-code-lang">JavaScript</span>
        <button
          className="btn btn-ghost btn-xs rq-code-toolbar__copy"
          onClick={handleCopy}
        >
          {copied ? <CheckCircle2 size={10} color="var(--green)" /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className="rq-code-pre"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  );
}

// ── Detail sidebar ────────────────────────────────────────────────────────────
function DetailSidebar({
  test, project, tab, listIdx, listLen,
  actionLoading, onApprove, onReject, onRestore, onPrev, onNext, navigate,
}) {
  const score = test.qualityScore;

  return (
    <div className="rq-detail-sidebar">
      {/* Quality score */}
      {score != null && (() => {
        // Always-visible inline summary: the single biggest penalty and the
        // single biggest reward. Reviewers see the actionable signal without
        // having to click; the full factor list stays behind the chip below.
        const sorted = [...(test.qualityScoreFactors || [])].sort((a, b) => a.delta - b.delta);
        const worst  = sorted[0]?.delta < 0 ? sorted[0] : null;
        const best   = sorted[sorted.length - 1]?.delta > 0 ? sorted[sorted.length - 1] : null;
        return (
          <div className="rq-info-row">
            <div className="rq-info-label">Quality score</div>
            <div className="rq-quality-row rq-quality-row--flush">
              <span className={`rq-quality-score rq-quality-score--${qualityTierKey(score)}`}>
                {score}
              </span>
              <div
                className="rq-quality-bar"
                role="progressbar"
                aria-valuenow={score}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Quality score"
              >
                <div
                  className={`rq-quality-fill quality-bar-fill--${qualityTierKey(score)}`}
                  style={{ width: `${score}%` }}
                />
              </div>
            </div>
            {(worst || best) && (
              <div className="rq-quality-summary">
                {worst && (
                  <div className="rq-quality-summary__line rq-quality-summary__line--penalty">
                    − {worst.label} ({worst.delta})
                  </div>
                )}
                {best && (
                  <div className="rq-quality-summary__line rq-quality-summary__line--reward">
                    + {best.label} (+{best.delta})
                  </div>
                )}
              </div>
            )}
            {/* Click-to-expand factor breakdown — same component used in the
                list pane so reviewers can audit the score without leaving the
                detail view. */}
            <div className="rq-quality-explain">
              <QualityScoreChip score={score} factors={test.qualityScoreFactors} />
            </div>
          </div>
        );
      })()}

      {/* Project */}
      <div className="rq-info-row">
        <div className="rq-info-label">Project</div>
        <div className="rq-info-val">{project?.name ?? "—"}</div>
      </div>

      {/* Type */}
      {test.type && (
        <div className="rq-info-row">
          <div className="rq-info-label">Type</div>
          <span className={`badge ${testTypeBadgeClass(test.type)}`}>
            {testTypeLabel(test.type)}
          </span>
        </div>
      )}

      {/* Priority */}
      {test.priority && (
        <div className="rq-info-row">
          <div className="rq-info-label">Priority</div>
          <span className={`badge ${test.priority === "high" ? "badge-red" : test.priority === "low" ? "badge-gray" : "badge-gray"}`}>
            {test.priority.charAt(0).toUpperCase() + test.priority.slice(1)}
          </span>
        </div>
      )}

      {/* Status */}
      <div className="rq-info-row">
        <div className="rq-info-label">Last run</div>
        <StatusBadge result={test.lastResult} />
      </div>

      {/* Review status */}
      <div className="rq-info-row">
        <div className="rq-info-label">Review</div>
        <ReviewBadge status={test.reviewStatus} />
      </div>

      {/* Generated */}
      <div className="rq-info-row">
        <div className="rq-info-label">Generated</div>
        <div className="rq-info-val rq-info-val--sm">
          {fmtRelativeTimeFull(test.createdAt)}
        </div>
      </div>

      {/* Source URL */}
      {test.sourceUrl && (
        <div className="rq-info-row">
          <div className="rq-info-label">Source URL</div>
          <a
            href={test.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="rq-source-url"
          >
            {test.sourceUrl.replace(/^https?:\/\/[^/]+/, "") || "/"}
            <ExternalLink size={9} className="rq-source-url__icon" />
          </a>
        </div>
      )}

      <hr className="rq-sidebar-divider" />

      {/* Quick decision buttons.
          The three branches are mutually exclusive by construction:
          - draft     → Approve + Reject (the standard review decision)
          - rejected  → Restore to Draft only (sends the test back through
                        the queue for re-review; deliberately *not* a
                        direct path to approved, since that would skip
                        the trust contract the queue exists to enforce)
          - approved  → Reject only (approving an already-approved test
                        is a no-op; rejecting it is the only state change
                        a reviewer might want here)
          Each branch declares its tab explicitly so adding a fourth tab
          in the future requires a deliberate decision rather than an
          accidental fall-through. */}
      <div className="rq-info-label rq-info-label--gap">Quick decision</div>
      <div className="rq-decision-btns">
        {tab === "draft" && (
          <button
            className="btn-approve btn-block"
            onClick={() => onApprove(test)}
            disabled={!!actionLoading}
          >
            {actionLoading === `approve-${test.id}`
              ? <Loader2 size={12} className="spin" />
              : <CheckCircle2 size={12} />}
            Approve
          </button>
        )}
        {tab !== "rejected" && (
          <button
            className="btn-reject btn-block"
            onClick={() => onReject(test)}
            disabled={!!actionLoading}
          >
            {actionLoading === `reject-${test.id}`
              ? <Loader2 size={12} className="spin" />
              : <XCircle size={12} />}
            Reject
          </button>
        )}
        {tab === "rejected" && (
          // Sends the test back to `draft` (not `approved`) so it goes
          // through the review queue again. Re-approving a rejected test
          // without re-review would skip the trust contract that the
          // queue exists to enforce — see AUTO-003b in ROADMAP.md for
          // the equivalent constraint on auto-approval revocation.
          // Styled with the ghost variant rather than `btn-approve` so
          // it doesn't read as "approve" — restore is a re-queue, not a
          // decision.
          <button
            className="btn btn-ghost btn-sm btn-block btn-block--gap"
            onClick={() => onRestore(test)}
            disabled={!!actionLoading}
          >
            {actionLoading === `restore-${test.id}`
              ? <Loader2 size={12} className="spin" />
              : <RotateCcw size={12} />}
            Restore to Draft
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm btn-block btn-block--gap"
          onClick={() => navigate(`/tests/${test.id}`)}
        >
          Open in Test Detail <ExternalLink size={11} />
        </button>
      </div>

      {/* Prev / Next navigator */}
      <div className="rq-navigator">
        <button
          className="rq-navigator__btn"
          onClick={onPrev}
          disabled={listIdx <= 0}
        >
          ← Prev
        </button>
        <span className="rq-navigator__pos">
          {listIdx + 1} / {listLen}
        </span>
        <button
          className="rq-navigator__btn"
          onClick={onNext}
          disabled={listIdx >= listLen - 1}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
// Tests created within this window are highlighted with a "NEW" badge.
// Mirrors the threshold previously used by `ProjectDetail.jsx`.
const NEW_TEST_THRESHOLD_MS = 5 * 60 * 1000;

export default function ReviewQueue() {
  usePageTitle("Review Queue");
  const navigate   = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user: authUser } = useAuth();
  const canEdit = userHasRole(authUser, "qa_lead");
  const { showToast } = useToast();

  // Projects list only — tests now flow through the server-paginated
  // `useReviewQueueQuery` hook, so we no longer fetch every test in the
  // workspace just to render this page.
  const { projects, loading: projectsLoading } = useProjectData({ fetchTests: false, fetchRuns: false });

  // ── URL-driven state ────────────────────────────────────────────────────────
  const tab       = searchParams.get("tab")       || "draft";
  const projectId = searchParams.get("projectId") || "all";
  const listSearch = searchParams.get("q")        || "";

  const setTab       = (v) => setSearchParams(p => { const n = new URLSearchParams(p); n.set("tab", v); n.delete("q"); return n; }, { replace: true });
  const setProjectId = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "all" ? n.set("projectId", v) : n.delete("projectId"); return n; }, { replace: true });
  const setListSearch = (v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set("q", v) : n.delete("q"); return n; }, { replace: true });

  // ── Local state ─────────────────────────────────────────────────────────────
  const [selected,      setSelected]      = useState(new Set());
  const [activeTestId,  setActiveTestId]  = useState(null);
  const [sortBy,        setSortBy]        = useState("newest");
  const [catFilter,     setCatFilter]     = useState("all");
  const [actionLoading, setActionLoading] = useState(null);
  const [bulkError,     setBulkError]     = useState(null);
  const [showSortMenu,  setShowSortMenu]  = useState(false);
  const [page,          setPage]          = useState(1);
  const PAGE_SIZE = 50;
  const sortMenuRef = useRef(null);

  // Styled confirmation dialog state — replaces native `window.confirm` for
  // the three destructive paths (reject, delete, bulk approve/reject). Same
  // shape as Tests.jsx's `bulkConfirm` so the two pages share the mental
  // model. `kind` discriminates the copy; `payload` carries either the
  // single test or the array of selected ids. `null` = no modal.
  const [confirmDialog, setConfirmDialog] = useState(null);
  // ENT-004: review comment typed inside the reject/approve modal.
  // Cleared on modal close so stale text doesn't leak between actions.
  const [modalComment, setModalComment] = useState("");

  // Debounced search — `searchDraft` mirrors the input field (immediate
  // feedback so typing feels responsive), and a 300ms idle timer commits
  // it to the URL `?q` param, which is what drives `useReviewQueueQuery`'s
  // server fetch. Without this, every keystroke fired a paginated tests
  // request to the backend (10 chars typed = 10 round-trips).
  //
  // Bi-directional sync: external URL writes (clear button, tab switch
  // dropping `?q`, deep-link nav) reset `searchDraft` to match the new
  // committed value so the input doesn't display stale text.
  const [searchDraft, setSearchDraft] = useState(listSearch);
  useEffect(() => {
    if (searchDraft === listSearch) return;
    const t = setTimeout(() => setListSearch(searchDraft), 300);
    return () => clearTimeout(t);
    // `setListSearch` is a stable closure that calls `setSearchParams`;
    // omitting it from deps avoids re-running the effect when its
    // identity drifts but the URL itself hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);
  useEffect(() => {
    // External URL change (clear button, tab nav) — sync the input back
    // so the field matches what the server is filtering on.
    if (listSearch !== searchDraft) setSearchDraft(listSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listSearch]);

  // Reset to page 1 whenever the filter set changes — otherwise a "page 4"
  // cursor on the Draft tab would still apply when the user switches to
  // Approved (which may have <4 pages of items).
  useEffect(() => { setPage(1); }, [tab, projectId, listSearch, catFilter]);

  // ── Server-paginated tests for the current view ─────────────────────────────
  // `sortBy` is server-side (see SORT_OPTIONS comment + testRepo's
  // SORT_BY_CLAUSES whitelist). Changing the sort dropdown invalidates the
  // query key and re-fetches with the new ORDER BY, so the result spans
  // every page instead of reordering only the current one.
  const reviewQuery = useReviewQueueQuery({
    tab, projectId, search: listSearch, category: catFilter, sortBy, page, pageSize: PAGE_SIZE,
  });
  const pageTests = reviewQuery.data;
  const meta      = reviewQuery.meta;

  // Tab counts — single aggregate query against `GET /tests/counts` returns
  // Draft + Approved + Rejected in one round-trip. Replaces the previous
  // three `pageSize: 1` paginated probes which produced three concurrent
  // requests on every filter / page change. `sortBy` is intentionally
  // omitted (irrelevant for COUNT — keeps the cache key stable across sort
  // changes so the badges don't flicker on sort).
  const counts = useReviewQueueCounts({ projectId, search: listSearch, category: catFilter });
  const tabCounts    = { draft: counts.draft, rejected: counts.rejected, approved: counts.approved };
  const approvedCount = counts.approved;

  const loading = projectsLoading || reviewQuery.isLoading;

  // Close sort menu on outside click
  useEffect(() => {
    if (!showSortMenu) return;
    function h(e) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target)) setShowSortMenu(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showSortMenu]);

  // ── Project lookup map ──────────────────────────────────────────────────────
  const projMap = useMemo(
    () => Object.fromEntries(projects.map(p => [p.id, p])),
    [projects],
  );

  // ── "NEW" badge for recently-created tests ──────────────────────────────────
  // `now` ticks every 60s so the badge auto-expires without requiring a manual
  // refresh. Mirrors the tick cadence used by `ProjectDetail.jsx`.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const newTestIds = useMemo(() => {
    const cutoff = now - NEW_TEST_THRESHOLD_MS;
    const ids = new Set();
    for (const t of pageTests) {
      if (t.createdAt && new Date(t.createdAt).getTime() > cutoff) ids.add(t.id);
    }
    return ids;
  }, [pageTests, now]);

  // Sort is applied server-side via `sortBy` on `useReviewQueueQuery` (see
  // `SORT_BY_CLAUSES` in `testRepo.js`), so `pageTests` already arrives in
  // the requested order. Re-sorting client-side here would be redundant at
  // best, and at worst would mask a server-side ordering mismatch by hiding
  // it behind a JS comparator.
  const visibleTests = pageTests;

  // Reset to page 1 whenever sort changes — switching from "newest" to
  // "quality" with a page-3 cursor would otherwise show the third page of
  // the new ordering, which is rarely what the user wanted.
  useEffect(() => { setPage(1); }, [sortBy]);

  const totalPages = Math.max(1, Math.ceil(meta.total / PAGE_SIZE));

  // Auto-select first item when list changes and nothing is selected
  useEffect(() => {
    if (!activeTestId && visibleTests.length > 0) {
      setActiveTestId(visibleTests[0].id);
    } else if (activeTestId && !visibleTests.find(t => t.id === activeTestId)) {
      // Active test left the list (e.g. was approved while on draft tab).
      // The handleApprove/handleReject callbacks already attempt to advance to
      // the next item before the cache update lands; this is the fallback when
      // those callbacks aren't responsible for the disappearance (filter
      // change, refetch from another tab, etc.). Reset to the first item.
      setActiveTestId(visibleTests[0]?.id ?? null);
    }
  }, [visibleTests, activeTestId]);

  // Clear selection when tab changes
  useEffect(() => { setSelected(new Set()); }, [tab]);

  // ── AUTO-003b: Last 24h auto-approvals tray ─────────────────────────────────
  // One-line strip above the Draft list listing tests auto-approved in the
  // last 24h, with their confidence-score chips. Only rendered when:
  //   - we're on the Draft tab (it belongs to the review-inbox context)
  //   - a single project is selected AND that project has
  //     `autoApproveThreshold` configured (i.e. auto-approval is *on*; the
  //     tray would otherwise be permanently empty noise on projects that
  //     never auto-approve)
  //
  // Shares the `useAutoApprovalsQuery` hook with the sidebar badge — one
  // cache, one in-flight request when both are mounted, and a revoke
  // anywhere invalidates both via `invalidateAutoApprovalsCache()`. The
  // 24h window is hook-side (`scope: "24h"`) so there's no client-side
  // time filter to keep in step with the server's `after` bound.
  const trayProject = projectId !== "all" ? projMap[projectId] : null;
  const trayEnabled = !!trayProject && trayProject.autoApproveThreshold != null && tab === "draft";
  const trayQuery = useAutoApprovalsQuery({
    scope:     "24h",
    projectId: trayProject?.id,
    enabled:   trayEnabled,
    limit:     200,
  });
  const trayItems = trayEnabled ? (trayQuery.data || []) : [];

  const activeTest    = useMemo(() => visibleTests.find(t => t.id === activeTestId) ?? null, [visibleTests, activeTestId]);
  const activeProject = activeTest ? projMap[activeTest.projectId] : null;
  const activeIdx     = useMemo(() => visibleTests.findIndex(t => t.id === activeTestId), [visibleTests, activeTestId]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  // With server-side pagination, optimistic edits to the page array would be
  // invalidated by the next refetch anyway — and they couldn't keep tab counts
  // honest since those are separate queries. We instead invalidate the
  // review-queue cache on settle and let the next render show the truth.
  async function handleApprove(test) {
    setActionLoading(`approve-${test.id}`);
    try {
      await api.approveTest(test.projectId, test.id);
      // Advance to next item on the current page before refetch lands.
      const next = visibleTests.find((t, i) => i > activeIdx && t.id !== test.id);
      setActiveTestId(next?.id ?? null);
      invalidateReviewQueueCache();
      invalidateProjectDataCache();
      showToast("Test approved → regression suite", "success");
    } catch (err) {
      console.error("Approve failed:", err);
      setBulkError(`Approve failed: ${err.message}`);
      setTimeout(() => setBulkError(null), 5000);
      showToast(err.message || "Approve failed.", "error");
    } finally {
      setActionLoading(null);
    }
  }

  // Reject is destructive — a rejected test has to be manually restored
  // to draft to come back into the queue, and a misclicked `r` keypress
  // is otherwise silent. Splits into request → execute so the styled
  // `<ModalShell>` confirmation can sit between user intent and the API
  // call. (Approve is intentionally confirmation-free — it's the primary
  // action and adding friction there would slow the page's main flow.)
  function handleReject(test) {
    setConfirmDialog({ kind: "reject", payload: test });
  }

  async function executeReject(test, comment) {
    setActionLoading(`reject-${test.id}`);
    try {
      const body = comment ? { reviewComment: comment } : undefined;
      await api.rejectTest(test.projectId, test.id, body);
      const next = visibleTests.find((t, i) => i > activeIdx && t.id !== test.id);
      setActiveTestId(next?.id ?? null);
      invalidateReviewQueueCache();
      invalidateProjectDataCache();
      showToast("Test rejected", "success");
    } catch (err) {
      console.error("Reject failed:", err);
      setBulkError(`Reject failed: ${err.message}`);
      setTimeout(() => setBulkError(null), 5000);
      showToast(err.message || "Reject failed.", "error");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRestore(test) {
    // Sends the test back to `draft` so it re-enters the review queue.
    // Mirror of `handleApprove`/`handleReject` — uses the same advance-then-
    // invalidate dance so the active selection moves to the next visible
    // test before the refetch lands and the current row leaves the list.
    setActionLoading(`restore-${test.id}`);
    try {
      await api.restoreTest(test.projectId, test.id);
      const next = visibleTests.find((t, i) => i > activeIdx && t.id !== test.id);
      setActiveTestId(next?.id ?? null);
      invalidateReviewQueueCache();
      invalidateProjectDataCache();
      showToast("Test restored to draft", "success");
    } catch (err) {
      console.error("Restore failed:", err);
      setBulkError(`Restore failed: ${err.message}`);
      setTimeout(() => setBulkError(null), 5000);
      showToast(err.message || "Restore failed.", "error");
    } finally {
      setActionLoading(null);
    }
  }

  // Delete (soft) is destructive but recoverable via the recycle bin in
  // Settings. Same request/execute split as reject so a single
  // `<ModalShell>` handles both paths.
  function handleDelete(test) {
    setConfirmDialog({ kind: "delete", payload: test });
  }

  async function executeDelete(test) {
    setActionLoading(`delete-${test.id}`);
    try {
      await api.deleteTest(test.projectId, test.id);
      // Advance to next item, same pattern as approve/reject.
      const next = visibleTests.find((t, i) => i > activeIdx && t.id !== test.id);
      setActiveTestId(next?.id ?? null);
      invalidateReviewQueueCache();
      invalidateProjectDataCache();
      showToast("Test moved to recycle bin", "success");
    } catch (err) {
      console.error("Delete failed:", err);
      setBulkError(`Delete failed: ${err.message}`);
      setTimeout(() => setBulkError(null), 5000);
      showToast(err.message || "Delete failed.", "error");
    } finally {
      setActionLoading(null);
    }
  }

  // Always confirm bulk actions — a misclicked "Approve 47" is the worst
  // available misclick on this page and there's no per-row visual review
  // step in the bulk flow. Both approve and reject route through the
  // styled `<ModalShell>` (unlike single-test approve, which is the
  // primary one-click flow and stays confirmation-free).
  function handleBulkAction(action) {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setConfirmDialog({ kind: action === "approve" ? "bulkApprove" : "bulkReject", payload: ids });
  }

  async function executeBulkAction(action, ids) {
    if (!ids?.length) return;
    setBulkError(null);
    setActionLoading(`bulk-${action}`);

    // Group by project from the *current page* — selection only ever spans
    // tests that are visible, so we don't need a global test list.
    const byProject = {};
    for (const testId of ids) {
      const t = pageTests.find(x => x.id === testId);
      if (t) {
        if (!byProject[t.projectId]) byProject[t.projectId] = [];
        byProject[t.projectId].push(testId);
      }
    }

    const results = await Promise.allSettled(
      Object.entries(byProject).map(([pid, testIds]) =>
        api.bulkUpdateTests(pid, testIds, action),
      ),
    );

    const failedCount = results.filter(r => r.status === "rejected").length;
    const successCount = ids.length - failedCount;

    // Capture the per-project breakdown of ids that DID succeed so the Undo
    // CTA can address only those (a partial-success Undo for the failed
    // group would just 404 again). `successByProject` is referenced by
    // closure inside the toast's `action.onClick` below.
    const successByProject = {};
    Object.entries(byProject).forEach(([pid, pIds], i) => {
      if (results[i].status === "fulfilled") successByProject[pid] = pIds;
    });

    if (failedCount > 0) {
      setBulkError(`${failedCount} project group${failedCount !== 1 ? "s" : ""} failed to ${action}. Others updated.`);
      setTimeout(() => setBulkError(null), 5000);
      showToast(`${failedCount} project group${failedCount !== 1 ? "s" : ""} failed to ${action}.`, "error");
    }
    if (successCount > 0) {
      const verb = action === "approve" ? "approved → regression" : "rejected";
      // Industry-standard Undo affordance (Gmail / Linear / GitHub) — the
      // CTA fires `bulkUpdateTests(pid, ids, "restore")` which sends every
      // affected test back to `draft`. Same `Promise.allSettled` fan-out
      // pattern as the forward action so a partial Undo failure on one
      // project doesn't cancel the others. Toast dismisses itself when the
      // Undo handler completes (wired at the ToastContext layer).
      showToast(`${successCount} test${successCount !== 1 ? "s" : ""} ${verb}`, "success", {
        action: {
          label: "Undo",
          onClick: async () => {
            const undoResults = await Promise.allSettled(
              Object.entries(successByProject).map(([pid, pIds]) =>
                api.bulkUpdateTests(pid, pIds, "restore"),
              ),
            );
            const undoFailed = undoResults.filter(r => r.status === "rejected").length;
            invalidateReviewQueueCache();
            invalidateProjectDataCache();
            invalidateAutoApprovalsCache();
            if (undoFailed > 0) {
              showToast(`Undo partially failed (${undoFailed} project group${undoFailed !== 1 ? "s" : ""}).`, "error");
            } else {
              showToast(`Restored ${successCount} test${successCount !== 1 ? "s" : ""} to draft`, "info");
            }
          },
        },
      });
    }

    invalidateReviewQueueCache();
    invalidateProjectDataCache();
    // AUTO-003b: bulk-restore can send auto-approved tests back to draft,
    // which changes what the sidebar badge and tray should show. Invalidate
    // here so both surfaces refresh on the next render without waiting for
    // the 60s background tick. Cheap no-op for non-restore bulk actions.
    invalidateAutoApprovalsCache();
    setSelected(new Set());
    setActionLoading(null);
  }

  // ── Checkbox helpers ────────────────────────────────────────────────────────
  function toggleItem(id) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleAll() {
    if (selected.size === visibleTests.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleTests.map(t => t.id)));
    }
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  // The handler reads `handleApprove` / `handleReject` via refs so the closure
  // always sees the latest functions without forcing every render to re-bind
  // the global `keydown` listener. The `actionLoading` guard prevents rapid
  // `a`/`r` keypresses from firing concurrent requests for the same test.
  const handleApproveRef = useRef(handleApprove);
  const handleRejectRef  = useRef(handleReject);
  handleApproveRef.current = handleApprove;
  handleRejectRef.current  = handleReject;

  useEffect(() => {
    function handler(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      // Tab-gate approve/reject so the keyboard shortcuts mirror the visible
      // button predicates (see DetailSidebar's Quick-decision group and the
      // detail-pane header). Without this guard, pressing `a` on the rejected
      // tab would directly approve the test — bypassing the "restore to draft
      // first, then re-review" trust contract the queue exists to enforce.
      if (e.key === "a" && !e.metaKey && !e.ctrlKey && activeTest && !actionLoading && tab === "draft") {
        handleApproveRef.current(activeTest);
      }
      if (e.key === "r" && !e.metaKey && !e.ctrlKey && activeTest && !actionLoading && tab !== "rejected") {
        handleRejectRef.current(activeTest);
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (activeIdx < visibleTests.length - 1) setActiveTestId(visibleTests[activeIdx + 1].id);
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (activeIdx > 0) setActiveTestId(visibleTests[activeIdx - 1].id);
      }
      if (e.key === "Escape") setSelected(new Set());
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTest, activeIdx, visibleTests, actionLoading, tab]);

  // ── Render ──────────────────────────────────────────────────────────────────
  // `data-mobile-view` toggles which pane is visible on narrow viewports.
  // Desktop ignores the attribute (both panes always rendered side-by-side);
  // mobile CSS reads it to show only the list ("list") or only the detail
  // ("detail"). Picking a row sets it to "detail"; the back-button in the
  // detail header sets it to "list".
  const [mobileView, setMobileView] = useState("list");
  useEffect(() => {
    if (activeTestId) setMobileView("detail");
  }, [activeTestId]);

  return (
    <div className="rq-page" data-mobile-view={mobileView}>

      {/* ── Header ── */}
      <div className="rq-header">
        <h1 className="rq-header__title">
          <ThumbsUp size={16} color="var(--accent)" />
          Review Queue
          {tabCounts.draft > 0 && (
            <span className="badge badge-amber">{tabCounts.draft} draft{tabCounts.draft !== 1 ? "s" : ""}</span>
          )}
        </h1>
        <div className="rq-header__spacer" />
        <div className="rq-header__controls">
          {/* Project filter */}
          <select
            className="input rq-header-select"
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
          >
            <option value="all">All projects</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Tab bar ──
          WAI-ARIA authoring practices: tablist + tab + aria-selected +
          aria-controls. The body panes below carry matching `id` + `role="tabpanel"`
          so screen readers announce the relationship. */}
      <div className="rq-tabs" role="tablist" aria-label="Review status">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            id={`rq-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`rq-tabpanel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`rq-tab ${tab === t.id ? "rq-tab--active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            <span className={`badge rq-tab__badge ${
              t.id === "draft"    ? "badge-amber" :
              t.id === "rejected" ? "badge-red"   : "badge-green"
            }`}>
              {tabCounts[t.id]}
            </span>
          </button>
        ))}
      </div>

      {/* ── Body ── */}
      {loading ? (
        <div className="rq-loading">
          <Loader2 size={18} className="spin" />
          <span className="rq-loading__text">Loading tests…</span>
        </div>
      ) : (
        <div
          className="rq-body"
          role="tabpanel"
          id={`rq-tabpanel-${tab}`}
          aria-labelledby={`rq-tab-${tab}`}
        >

          {/* ── Left: list pane ── */}
          <div className="rq-list-pane">

            {/* List header with sort */}
            <div className="rq-list-pane__header">
              <span className="rq-list-pane__count">
                {meta.total === 0
                  ? "0 tests"
                  : `${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + visibleTests.length} of ${meta.total}`}
                {reviewQuery.isFetching && !reviewQuery.isLoading && " · refreshing…"}
              </span>
              <div className="rq-sort-menu-wrap" ref={sortMenuRef}>
                <button
                  className="rq-list-pane__sort"
                  onClick={() => setShowSortMenu(v => !v)}
                >
                  {SORT_OPTIONS.find(s => s.id === sortBy)?.label} ▾
                </button>
                {showSortMenu && (
                  <div className="rq-sort-menu">
                    {SORT_OPTIONS.map(opt => (
                      <button
                        key={opt.id}
                        className={`rq-sort-menu__item ${sortBy === opt.id ? "rq-sort-menu__item--active" : ""}`}
                        onClick={() => { setSortBy(opt.id); setShowSortMenu(false); }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Search */}
            <div className="rq-list-search">
              <Search size={12} className="rq-list-search__icon" />
              <input
                className="rq-list-search__input"
                placeholder="Search tests…"
                value={searchDraft}
                onChange={e => setSearchDraft(e.target.value)}
              />
              {searchDraft && (
                <button
                  className="rq-list-search__clear"
                  onClick={() => { setSearchDraft(""); setListSearch(""); }}
                  aria-label="Clear search"
                >
                  <X size={11} />
                </button>
              )}
            </div>

            {/* Category chips */}
            <div className="rq-filter-chips">
              {[
                { id: "all",     label: "All" },
                { id: "web",     label: "Web" },
                { id: "api",     label: "API" },
                { id: "journey", label: "Journey" },
              ].map(c => (
                <button
                  key={c.id}
                  className={`rq-chip ${catFilter === c.id ? "rq-chip--active" : ""}`}
                  onClick={() => setCatFilter(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/* Select-all when items exist — real <label> + <input> so the
                checkbox is in the tab order, screen-reader announced, and
                togglable via Space per native semantics. */}
            {visibleTests.length > 0 && (
              <label className="rq-select-all">
                <input
                  type="checkbox"
                  className="rq-item__check rq-select-all__check"
                  checked={selected.size === visibleTests.length && visibleTests.length > 0}
                  onChange={toggleAll}
                  aria-label={selected.size === visibleTests.length ? "Deselect all tests" : "Select all tests"}
                />
                <span className="rq-select-all__label">
                  {selected.size === visibleTests.length ? "Deselect all" : "Select all"}
                </span>
              </label>
            )}

            {/* AUTO-003b: 24h auto-approvals tray. Renders only when the
                selected project has auto-approval enabled and we're on the
                Draft tab. Score chips reuse `qualityColor()` for the same
                visual encoding as the per-test quality chips below. */}
            {trayEnabled && trayItems.length > 0 && (
              <div
                className="rq-auto-tray"
                role="region"
                aria-label="Auto-approvals in the last 24 hours"
              >
                <span className="rq-auto-tray__label">
                  🤖 {trayItems.length} auto-approved (24h):
                </span>
                {trayItems.slice(0, 20).map((a) => {
                  const score = a.meta?.score;
                  const score100 = typeof score === "number" ? Math.round(score <= 1 ? score * 100 : score) : null;
                  const clickable = !!a.testId;
                  return (
                    <button
                      key={a.id}
                      className={`rq-auto-tray__chip${clickable ? " rq-auto-tray__chip--clickable" : ""}`}
                      onClick={() => clickable && navigate(`/tests/${a.testId}`)}
                      disabled={!clickable}
                      title={a.testName ? `${a.testName} — ${a.detail}` : a.detail}
                    >
                      <span className="rq-auto-tray__chip-name">
                        {a.testName ? cleanTestName(a.testName) : a.testId || "test"}
                      </span>
                      {score100 != null && (
                        // Tier-driven colour via modifier class — see
                        // `.quality-bar-fill--<tier>` precedent in components.css.
                        // A11Y-001 inline-style sweep replaced the previous
                        // `style={{ color: qualityColor(...) }}` with a
                        // `--<tier>` modifier that resolves to the same
                        // green/amber/red ramp through `quality-explainer--*`.
                        <span
                          className={`rq-auto-tray__chip-score quality-explainer--${qualityTierKey(score100)}`}
                          aria-label={`Quality score ${score100} out of 100`}
                        >
                          {score100}<span className="rq-auto-tray__chip-score-denom">/100</span>
                        </span>
                      )}
                    </button>
                  );
                })}
                {trayItems.length > 20 && (
                  <span className="rq-auto-tray__overflow">+{trayItems.length - 20} more</span>
                )}
              </div>
            )}

            {/* Test rows */}
            <div className="rq-list">
              {visibleTests.length === 0 ? (
                // Three empty-state branches:
                //   1. search/filter active → "No matches" (don't coach; the
                //      user is looking for something specific).
                //   2. draft tab + nothing pending → inbox-zero coaching:
                //      surface what to do next (generate more / audit
                //      approvals) instead of just celebrating.
                //   3. other tabs (rejected/approved) when empty → minimal
                //      message, no coaching needed.
                listSearch || catFilter !== "all" ? (
                  <div className="rq-empty rq-empty--list">
                    <div className="rq-empty__icon">✓</div>
                    <div className="rq-empty__title">No matches</div>
                    <div className="rq-empty__desc">
                      {listSearch
                        ? `No tests match "${listSearch}"`
                        : "No tests in this category."}
                    </div>
                  </div>
                ) : tab === "draft" ? (
                  <div className="rq-empty rq-empty--list rq-empty--coach" role="status">
                    <CheckCircle2 size={32} color="var(--green)" aria-hidden="true" />
                    <div className="rq-empty__title">Inbox zero</div>
                    <div className="rq-empty__desc">
                      All drafts have been reviewed — nice work.
                    </div>
                    {/* Approved-this-week stat is not yet a backend endpoint
                        (`GET /api/v1/review-queue/stats`); we derive the count
                        from the approved-tab total query that's already in
                        flight, which is "all-time" rather than 7-day. The
                        copy avoids the "this week" framing until we ship the
                        time-windowed endpoint. */}
                    {approvedCount > 0 && (
                      <div className="rq-empty__stats">
                        {approvedCount} test{approvedCount !== 1 ? "s" : ""} approved in this workspace
                      </div>
                    )}
                    <div className="rq-empty__actions">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => navigate(projectId !== "all" ? `/projects/${projectId}/test-lab` : "/test-lab")}
                      >
                        Generate more tests →
                      </button>
                      {approvedCount > 0 && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setTab("approved")}
                        >
                          Audit recent approvals
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="rq-empty rq-empty--list">
                    <div className="rq-empty__icon">✓</div>
                    <div className="rq-empty__title">
                      {TABS.find(t2 => t2.id === tab)?.emptyLabel}
                    </div>
                    <div className="rq-empty__desc">No tests in this category.</div>
                  </div>
                )
              ) : (
                visibleTests.map(t => {
                  const isActive   = t.id === activeTestId;
                  const isSelected = selected.has(t.id);
                  const isNew      = newTestIds.has(t.id);
                  const proj       = projMap[t.projectId];
                  const score      = t.qualityScore;
                  const isApi      = t.generatedFrom === "api_har_capture" || t.generatedFrom === "api_user_described";

                  // Quality warn: gate on a *specific* heavy penalty (e.g.
                  // "No assertions" at -30) rather than overall score < 50.
                  // This ties the red-border affordance to an actionable
                  // cause instead of a vague low number.
                  const factors    = Array.isArray(t.qualityScoreFactors) ? t.qualityScoreFactors : [];
                  const qualityWarn = factors.some(f => f.kind === "penalty" && f.delta <= -25);
                  // Worst-penalty label only (no delta — keeps the row tight)
                  // and only when score < 80, so healthy tests stay quiet.
                  const sortedFactors = [...factors].sort((a, b) => a.delta - b.delta);
                  const worstLabel  = (score != null && score < 80 && sortedFactors[0]?.delta < 0)
                    ? sortedFactors[0].label
                    : null;

                  return (
                    <div
                      key={t.id}
                      className={`rq-item ${isActive ? "rq-item--active" : ""} ${isNew ? "rq-item--new" : ""} ${qualityWarn ? "rq-item--quality-warn" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isActive}
                      aria-label={`${cleanTestName(t.name)}${isActive ? ", currently selected" : ""}`}
                      onClick={() => setActiveTestId(t.id)}
                      onKeyDown={e => {
                        // Enter / Space activate the row, matching the native
                        // <button> contract that `role="button"` inherits.
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setActiveTestId(t.id);
                        }
                      }}
                    >
                      {/* Real checkbox — in the tab order so keyboard users
                          can multi-select independently of row activation.
                          `onClick` with stopPropagation prevents a click on
                          the checkbox from also triggering the row-level
                          `setActiveTestId`. */}
                      <input
                        type="checkbox"
                        className="rq-item__check"
                        checked={isSelected}
                        onChange={() => toggleItem(t.id)}
                        onClick={e => e.stopPropagation()}
                        aria-label={`Select ${cleanTestName(t.name)}`}
                      />

                      <div className="rq-item__body">
                        <div className="rq-item__name">
                          {cleanTestName(t.name)}
                          {isNew && <span className="rq-new-badge">NEW</span>}
                        </div>
                        <div className="rq-item__meta">
                          {isApi
                            ? <span className="badge badge-blue badge--xs">API</span>
                            : t.isJourneyTest
                              ? <span className="badge badge-amber badge--xs">Journey</span>
                              : <span className="badge badge-gray badge--xs">Web</span>}
                          {proj && (
                            <span className="rq-item__meta-text">
                              {proj.name}
                            </span>
                          )}
                          <span className="rq-item__meta-text">
                            · {(t.steps ?? []).length} steps
                          </span>
                          {score != null && (
                            <span
                              className="rq-item__score"
                              onClick={e => e.stopPropagation()}
                            >
                              <QualityScoreChip score={score} factors={t.qualityScoreFactors} />
                            </span>
                          )}
                          {worstLabel && (
                            <span
                              className="rq-item__quality-summary"
                              title={`Top penalty: ${worstLabel}`}
                            >
                              · {worstLabel}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Per-row delete (qa_lead+). Soft-deletes — the test
                          lands in the recycle bin and can be restored from
                          Settings. Stops propagation so it doesn't also
                          select the row. */}
                      {canEdit && (
                        <button
                          className="rq-item__delete"
                          onClick={e => { e.stopPropagation(); handleDelete(t); }}
                          disabled={actionLoading === `delete-${t.id}`}
                          title="Delete (move to recycle bin)"
                          aria-label={`Delete ${cleanTestName(t.name)}`}
                        >
                          {actionLoading === `delete-${t.id}`
                            ? <Loader2 size={11} className="spin" />
                            : <Trash2 size={11} />}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Pager — only visible when more than one page exists. */}
            {totalPages > 1 && (
              <div className="rq-pager">
                <button
                  className="rq-pager__btn"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1 || reviewQuery.isFetching}
                >
                  ← Prev
                </button>
                <span className="rq-pager__pos">
                  Page {page} / {totalPages}
                </span>
                <button
                  className="rq-pager__btn"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || reviewQuery.isFetching}
                >
                  Next →
                </button>
              </div>
            )}

            {/* Bulk action bar — tab-gated to mirror the single-test decision
                contract (see DetailSidebar's Quick-decision group):
                  - draft     → Approve + Reject
                  - approved  → Reject only (re-approving is a no-op)
                  - rejected  → neither (approving rejected tests directly would
                                bypass the "restore to draft → re-review" trust
                                contract the queue exists to enforce; bulk
                                restore-to-draft isn't wired up, so the bulk
                                bar on the rejected tab offers only Clear). */}
            {selected.size > 0 && (
              <div className="rq-bulk-bar">
                <span className="rq-bulk-bar__label">
                  {selected.size} selected
                </span>
                {tab === "draft" && (
                  <button
                    className="btn-approve"
                    disabled={!!actionLoading}
                    onClick={() => handleBulkAction("approve")}
                  >
                    {actionLoading === "bulk-approve"
                      ? <Loader2 size={11} className="spin" />
                      : <ThumbsUp size={11} />}
                    Approve {selected.size}
                  </button>
                )}
                {tab !== "rejected" && (
                  <button
                    className="btn-reject"
                    disabled={!!actionLoading}
                    onClick={() => handleBulkAction("reject")}
                  >
                    {actionLoading === "bulk-reject"
                      ? <Loader2 size={11} className="spin" />
                      : <ThumbsDown size={11} />}
                    Reject {selected.size}
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
                <span className="rq-bulk-bar__progress">
                  {activeIdx + 1} / {visibleTests.length}
                </span>
              </div>
            )}

            {/* Bulk error feedback */}
            {bulkError && (
              <div className="rq-bulk-error" role="alert">
                <AlertCircle size={12} />
                <span className="rq-bulk-error__msg">{bulkError}</span>
                <button
                  className="rq-bulk-error__close"
                  onClick={() => setBulkError(null)}
                  aria-label="Dismiss error"
                >
                  <X size={11} />
                </button>
              </div>
            )}
          </div>

          {/* ── Right: detail pane ── */}
          <div className="rq-detail-pane">
            {!activeTest ? (
              <div className="rq-empty">
                <div className="rq-empty__icon">☑</div>
                <div className="rq-empty__title">Select a test to review</div>
                <div className="rq-empty__desc">
                  Click any test in the list to preview its steps and generated code.
                </div>
              </div>
            ) : (
              <>
                {/* Detail header */}
                <div className="rq-detail-pane__header">
                  {/* Mobile-only back-to-list button. The `.rq-back-to-list`
                      class is `display: none` above 640px and `display: flex`
                      below, so it never shows on desktop where the list is
                      always visible. */}
                  <button
                    className="rq-back-to-list"
                    onClick={() => setMobileView("list")}
                    aria-label="Back to test list"
                    title="Back to test list"
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <div className="rq-detail-pane__title">
                    {cleanTestName(activeTest.name)}
                  </div>
                  <div className="rq-detail-pane__actions">
                    {/* Header decision buttons — same tab contract as the
                        sidebar's Quick-decision group: draft shows
                        Approve+Reject, rejected shows Restore-to-Draft only,
                        approved shows Reject only. The earlier `tab !== "approved"`
                        guard let a rejected test be re-approved without
                        re-review (skipping the trust contract the queue
                        exists to enforce); now `tab === "draft"` matches
                        the sidebar's tightened predicate. */}
                    {tab === "draft" && (
                      <button
                        className="btn-approve"
                        onClick={() => handleApprove(activeTest)}
                        disabled={!!actionLoading}
                      >
                        {actionLoading === `approve-${activeTest.id}`
                          ? <Loader2 size={12} className="spin" />
                          : <CheckCircle2 size={12} />}
                        Approve
                      </button>
                    )}
                    {tab !== "rejected" && (
                      <button
                        className="btn-reject"
                        onClick={() => handleReject(activeTest)}
                        disabled={!!actionLoading}
                      >
                        {actionLoading === `reject-${activeTest.id}`
                          ? <Loader2 size={12} className="spin" />
                          : <XCircle size={12} />}
                        Reject
                      </button>
                    )}
                    {tab === "rejected" && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleRestore(activeTest)}
                        disabled={!!actionLoading}
                      >
                        {actionLoading === `restore-${activeTest.id}`
                          ? <Loader2 size={12} className="spin" />
                          : <RotateCcw size={12} />}
                        Restore to Draft
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => navigate(`/tests/${activeTest.id}`)}
                      title="Open in Test Detail"
                    >
                      <ExternalLink size={13} />
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => navigate(`/tests/${activeTest.id}`, { state: { editOnOpen: true } })}
                      title="Edit test"
                    >
                      Edit
                    </button>
                  </div>
                </div>

                {/* Inner split: main + sidebar */}
                <div className="rq-detail-inner">
                  {/* Main: description + steps + code */}
                  <div className="rq-detail-main">

                    {/* Description */}
                    {activeTest.description && (
                      <div>
                        <div className="rq-section-label">Description</div>
                        <p className="rq-description">
                          {activeTest.description}
                        </p>
                      </div>
                    )}

                    {/* Steps */}
                    {(activeTest.steps ?? []).length > 0 && (
                      <div>
                        <div className="rq-section-label">
                          Steps ({(activeTest.steps ?? []).length})
                        </div>
                        <div className="rq-steps">
                          {(activeTest.steps ?? []).map((step, i) => (
                            <div key={i} className="rq-step-row">
                              <div className="rq-step-num">{i + 1}</div>
                              <div className="rq-step-text">{step}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Generated code */}
                    {activeTest.playwrightCode && (
                      <div>
                        <div className="rq-section-label">Generated code</div>
                        <CodeView code={activeTest.playwrightCode} />
                      </div>
                    )}

                    {/* Empty steps state */}
                    {!activeTest.playwrightCode && (activeTest.steps ?? []).length === 0 && (
                      <div className="rq-empty-inline">
                        No steps or code available for this test.
                      </div>
                    )}
                  </div>

                  {/* Sidebar */}
                  <DetailSidebar
                    test={activeTest}
                    project={activeProject}
                    tab={tab}
                    listIdx={activeIdx}
                    listLen={visibleTests.length}
                    actionLoading={actionLoading}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    onRestore={handleRestore}
                    onPrev={() => activeIdx > 0 && setActiveTestId(visibleTests[activeIdx - 1].id)}
                    onNext={() => activeIdx < visibleTests.length - 1 && setActiveTestId(visibleTests[activeIdx + 1].id)}
                    navigate={navigate}
                  />
                </div>

                {/* Keyboard hint */}
                <div className="rq-kbd-hints">
                  {[
                    ["a", "approve"],
                    ["r", "reject"],
                    ["j / ↓", "next"],
                    ["k / ↑", "prev"],
                  ].map(([key, label]) => (
                    <span key={key} className="rq-kbd-hints__group">
                      <kbd>{key}</kbd>
                      {" "}{label}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Confirmation modal for the three destructive paths (single
          reject, single delete, bulk approve, bulk reject). Replaces the
          previous `window.confirm` to match the styled pattern Tests.jsx
          and the old ProjectDetail review tab used. The `kind` switch
          carries the per-action copy and styling (danger vs primary). */}
      {confirmDialog && (() => {
        const { kind, payload } = confirmDialog;
        // Per-kind copy + execute handler. Centralised here so the
        // closing-the-modal-then-firing-the-action dance only happens
        // in one place — every branch dismisses the modal before kicking
        // off the async work, so a network failure can't leave the
        // modal stuck open.
        const config =
          kind === "reject" ? {
            title: "Reject test?",
            body: <>Reject <strong>{cleanTestName(payload.name)}</strong>? You can restore it to Draft from the Rejected tab.</>,
            confirmLabel: "Reject test",
            confirmClass: "btn btn-danger btn-sm",
            showComment: true,
            commentPlaceholder: "Reason for rejection (optional — visible on Test Detail)",
            run: () => executeReject(payload, modalComment),
          } :
          kind === "delete" ? {
            title: "Delete test?",
            body: <>Delete <strong>{cleanTestName(payload.name)}</strong>? It will move to the recycle bin and can be restored from Settings.</>,
            confirmLabel: "Delete test",
            confirmClass: "btn btn-danger btn-sm",
            run: () => executeDelete(payload),
          } :
          kind === "bulkApprove" ? {
            title: `Approve ${payload.length} test${payload.length !== 1 ? "s" : ""}?`,
            body: <>You're about to approve <strong>{payload.length} test{payload.length !== 1 ? "s" : ""}</strong> across all selected projects. They'll move to the regression suite.</>,
            confirmLabel: `Approve ${payload.length}`,
            confirmClass: "btn btn-primary btn-sm",
            run: () => executeBulkAction("approve", payload),
          } :
          kind === "bulkReject" ? {
            title: `Reject ${payload.length} test${payload.length !== 1 ? "s" : ""}?`,
            body: <>You're about to reject <strong>{payload.length} test{payload.length !== 1 ? "s" : ""}</strong>. You can restore them to Draft from the Rejected tab.</>,
            confirmLabel: `Reject ${payload.length}`,
            confirmClass: "btn btn-danger btn-sm",
            run: () => executeBulkAction("reject", payload),
          } : null;
        if (!config) return null;
        return (
          <ModalShell onClose={() => { setConfirmDialog(null); setModalComment(""); }} width="min(420px, 95vw)" ariaLabelledBy="rq-confirm-title" style={{ padding: "28px 32px" }}>
            <div id="rq-confirm-title" className="rq-confirm__title">{config.title}</div>
            <div className="rq-confirm__body">{config.body}</div>
            {/* ENT-004: optional review comment textarea. Shown on reject
                (and future approve-with-comment if wired). The comment is
                persisted to `tests.reviewComment` and rendered on TestDetail
                so the next reviewer sees "why was this rejected?" inline. */}
            {config.showComment && (
              <textarea
                className="input rq-confirm__comment"
                placeholder={config.commentPlaceholder || "Add a comment (optional)"}
                value={modalComment}
                onChange={(e) => setModalComment(e.target.value)}
                rows={3}
                maxLength={2000}
                autoFocus
              />
            )}
            <div className="rq-confirm__actions">
              <button className="btn btn-ghost btn-sm" onClick={() => { setConfirmDialog(null); setModalComment(""); }}>
                Cancel
              </button>
              <button
                className={config.confirmClass}
                onClick={() => { setConfirmDialog(null); config.run(); setModalComment(""); }}
              >
                {config.confirmLabel}
              </button>
            </div>
          </ModalShell>
        );
      })()}
    </div>
  );
}

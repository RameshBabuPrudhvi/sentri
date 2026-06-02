import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Clock,
  Download,
  StopCircle,
  Ban,
  Settings,
  Globe,
  Key,
  AlertTriangle,
  Wifi,
  Server,
  RotateCcw,
} from "lucide-react";
import { api } from "../api.js";
import { queryClient, runQueryKeys, invalidateRunCache } from "../queryClient.js";
import { useRunDetailQuery } from "../hooks/queries/useRunDetailQuery.js";
import { useRunSSE } from "../hooks/useRunSSE.js";
import { useNotifications } from "../context/NotificationContext.jsx";
import { useToast } from "../context/ToastContext.jsx";

import CrawlView from "../components/crawl/CrawlView";
import GenerateView from "../components/generate/GenerateView";
import TestRunView from "../components/run/TestRunView";
import RunCompareView from "../components/run/RunCompareView.jsx";
import AgentTag from "../components/shared/AgentTag.jsx";
import BrowserBadge from "../components/shared/BrowserBadge.jsx";
import GateBadge from "../components/shared/GateBadge.jsx";
import Breadcrumb from "../components/shared/Breadcrumb.jsx";
import AgentCallTimeline from "../components/run/AgentCallTimeline.jsx";
import usePageTitle from "../hooks/usePageTitle.js";
import { countNonExecutedSkips } from "../utils/skipReasons.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Map run.errorCategory → banner styling, icon, title, and optional action.
 * Categories are set by backend/src/utils/errorClassifier.js.
 */
function getErrorBannerProps(category, navigate) {
  const settingsAction = { label: "Go to Settings", onClick: () => navigate("/settings") };

  const map = {
    rate_limit: {
      icon: <AlertTriangle size={16} />,
      title: "AI Rate Limit Reached",
      bg: "var(--amber-bg)", border: "#fcd34d", color: "#92400e",
      action: settingsAction,
    },
    auth: {
      icon: <Key size={16} />,
      title: "API Key Invalid or Expired",
      bg: "var(--amber-bg)", border: "#fcd34d", color: "#92400e",
      action: settingsAction,
    },
    ollama_offline: {
      icon: <Wifi size={16} />,
      title: "Ollama Not Reachable",
      bg: "var(--amber-bg)", border: "#fcd34d", color: "#92400e",
      action: settingsAction,
    },
    ollama_model: {
      icon: <Server size={16} />,
      title: "Ollama Model Not Found",
      bg: "var(--amber-bg)", border: "#fcd34d", color: "#92400e",
      action: settingsAction,
    },
    no_provider: {
      icon: <Settings size={16} />,
      title: "No AI Provider Configured",
      bg: "var(--amber-bg)", border: "#fcd34d", color: "#92400e",
      action: settingsAction,
    },
    timeout: {
      icon: <Clock size={16} />,
      title: "Operation Timed Out",
      bg: "var(--red-bg)", border: "#fca5a5", color: "var(--red)",
      action: null,
    },
    context_length: {
      icon: <AlertTriangle size={16} />,
      title: "Content Too Large",
      bg: "var(--amber-bg)", border: "#fcd34d", color: "#92400e",
      action: null,
    },
    provider_overload: {
      icon: <Server size={16} />,
      title: "AI Provider Overloaded",
      bg: "var(--amber-bg)", border: "#fcd34d", color: "#92400e",
      action: null,
    },
    browser_launch: {
      icon: <Globe size={16} />,
      title: "Browser Launch Failed",
      bg: "var(--red-bg)", border: "#fca5a5", color: "var(--red)",
      action: null,
    },
    navigation: {
      icon: <Globe size={16} />,
      title: "Page Navigation Failed",
      bg: "var(--red-bg)", border: "#fca5a5", color: "var(--red)",
      action: null,
    },
  };

  return map[category] || {
    icon: <XCircle size={16} />,
    title: "Run Failed",
    bg: "var(--red-bg)", border: "#fca5a5", color: "var(--red)",
    action: null,
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RunDetail() {
  const { runId } = useParams();
  const navigate = useNavigate();

  const [initialStatus, setInitialStatus] = useState(undefined);
  const [frames, setFrames] = useState([]);
  const [llmTokens, setLlmTokens] = useState("");
  const [aborting, setAborting] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  // B1 (AUDIT-ROADMAP) — `Resume` button state for crash-recovered runs
  // (`status='interrupted'` + `failureReason='process_crash'`).
  const [resuming, setResuming] = useState(false);
  const [compareData, setCompareData] = useState(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState(null);
  const [priorRuns, setPriorRuns] = useState([]);
  const [rootCauseExpanded, setRootCauseExpanded] = useState(false);
  const { addNotification } = useNotifications();
  const { showToast } = useToast();

  // Cap the streamed token buffer so long-running generation jobs don't
  // accumulate hundreds of thousands of characters and cause layout/memory issues.
  const LLM_TOKEN_LIMIT = 50_000;

  // ── TanStack Query: run detail ────────────────────────────────────────
  // SSE updates apply optimistic patches directly into the query cache via
  // queryClient.setQueryData(), so `run` from useRunDetailQuery is always
  // the latest merged state of (server fetch ∪ live SSE events).
  const runQuery = useRunDetailQuery(runId);

  const run = runQuery.data || null;
  const loading = runQuery.isLoading;
  usePageTitle(run ? `Run ${runId.slice(0, 6).toUpperCase()}` : "Run Detail");

  // Capture the run's status at first successful load so useRunSSE can skip
  // SSE entirely for already-finished runs (prevents spurious notifications).
  useEffect(() => {
    if (initialStatus === undefined && run?.status) {
      setInitialStatus(run.status);
    }
  }, [run?.status, initialStatus]);

  const updateRun = useCallback(
    (updater) => queryClient.setQueryData(runQueryKeys.detail(runId), updater),
    [runId],
  );

  const fetchRun = useCallback(() => invalidateRunCache(runId), [runId]);

  const runCompareAgainst = useCallback(async (otherRunId) => {
    if (!run?.id || !otherRunId) return;
    setCompareLoading(true);
    setCompareError(null);
    try {
      const diff = await api.getRunCompare(run.id, otherRunId);
      setCompareData(diff);
    } catch (err) {
      setCompareError(err);
    } finally {
      setCompareLoading(false);
    }
  }, [run]);

  const handleCompare = useCallback(async () => {
    if (!run?.projectId) return;
    setCompareLoading(true);
    setCompareError(null);
    try {
      const runs = await api.getRuns(run.projectId);
      // AUTO-019: populate picker with all other test runs for this project
      // so the user can choose any prior run, not just the most recent one.
      // `runRepo.getByProjectId` returns runs sorted newest-first
      // (`ORDER BY startedAt DESC` — see backend/src/database/repositories/runRepo.js:179),
      // so the chronological predecessor of the current run is the next entry
      // in the list AFTER the current run's index. Default to that rather than
      // `others[0]` (which is just the newest other run, and is only the
      // chronological predecessor when the current run is itself the newest).
      const sortedRuns = (runs || []).filter((r) => r.type === "test_run");
      const others = sortedRuns.filter((r) => r.id !== run.id);
      setPriorRuns(others);
      const idx = sortedRuns.findIndex((r) => r.id === run.id);
      const predecessor = idx >= 0 && idx + 1 < sortedRuns.length ? sortedRuns[idx + 1] : null;
      const previous = predecessor || others[0] || null;
      if (!previous) {
        setCompareData({ summary: { flipped: 0, added: 0, removed: 0, unchanged: 0 }, diffs: [] });
        return;
      }
      const diff = await api.getRunCompare(run.id, previous.id);
      setCompareData(diff);
    } catch (err) {
      setCompareError(err);
    } finally {
      setCompareLoading(false);
    }
  }, [run]);

  const handleAbort = useCallback(async () => {
    if (aborting) return;
    setAborting(true);
    try {
      await api.abortRun(runId);
      updateRun((prev) => prev ? { ...prev, status: "aborted" } : prev);
      setFrames([]);
    } catch (err) {
      console.error("Abort failed:", err);
    } finally {
      setAborting(false);
    }
  }, [runId, aborting, updateRun]);

  // ── Re-run handler (MNT-010) ─────────────────────────────────────────────
  // For crawl and generate runs in terminal states, re-trigger the same operation.
  const handleRerun = useCallback(async () => {
    if (rerunning || !run) return;
    setRerunning(true);
    try {
      let result;
      const input = run.generateInput || {};
      if (run.type === "crawl") {
        result = await api.crawl(run.projectId, input.dialsConfig ? { dialsConfig: input.dialsConfig } : undefined);
      } else if (run.type === "generate") {
        // Guard against missing/corrupted generateInput — the backend requires
        // `name` for generate runs, so sending undefined would 400.
        if (!input.name) {
          showToast("Original generation input not found — please create a new generation instead.", "error");
          return;
        }
        result = await api.generateTest(run.projectId, {
          name: input.name,
          description: input.description,
          dialsConfig: input.dialsConfig,
        });
      }
      if (result?.runId) {
        // UX-001: user-initiated "Re-run" click — surface as a visible toast
        // before navigation (the bell stays for SSE "Run complete" events).
        showToast(`Re-run started — new run ${result.runId} created`, "success");
        navigate(`/runs/${result.runId}`);
      }
    } catch (err) {
      showToast(err.message || "Re-run failed.", "error");
    } finally {
      setRerunning(false);
    }
  }, [run, rerunning, navigate, showToast]);

  // B1 (AUDIT-ROADMAP) — Resume a crash-recovered run.
  // Backend gate: `status='interrupted'` AND `failureReason='process_crash'`.
  // The new run runs only the tests missing from `run_test_results`, so the
  // operator picks up where the SIGKILL / OOM kill left off instead of
  // restarting from scratch.
  const handleResume = useCallback(async () => {
    if (resuming || !run) return;
    setResuming(true);
    try {
      const result = await api.resumeRun(runId);
      if (result?.runId) {
        showToast(
          `Resumed — ${result.remaining} of ${result.total} test${result.total !== 1 ? "s" : ""} re-dispatched (run ${result.runId.slice(0, 8)})`,
          "success",
        );
        navigate(`/runs/${result.runId}`);
      }
    } catch (err) {
      showToast(err?.body?.error || err?.message || "Resume failed.", "error");
    } finally {
      setResuming(false);
    }
  }, [run, runId, resuming, navigate, showToast]);

  // AUTO-010 — Track whether the initial auto-expand decision has been made
  // for the current run. Reset on `runId` change so navigating to a different
  // run re-arms the decision; once flipped to `true` for a given run, later
  // SSE updates that mutate `rootCauses.length` won't override the user's
  // manual collapse/expand toggle.
  const hasSetInitialExpand = useRef(false);

  // Reset live-stream state when navigating to a different run
  useEffect(() => {
    setFrames([]);
    setLlmTokens("");
    setInitialStatus(undefined);
    // AUTO-019: also clear comparison state so a stale diff from the
    // previously-viewed run doesn't render on the new run's page.
    setCompareData(null);
    setCompareLoading(false);
    setCompareError(null);
    setPriorRuns([]);
    // AUTO-010 — re-arm the initial-expand decision for the new run.
    hasSetInitialExpand.current = false;
    setRootCauseExpanded(false);
  }, [runId]);

  // AUTO-010 — Auto-expand the Root Cause Summary panel the first time
  // `rootCauses` actually loads with ≥2 clusters (multiple clusters is the
  // high-signal case worth surfacing immediately). At mount the TanStack
  // Query data is still loading so `run` is `null` and `rootCausesCount === 0`
  // — gating on `hasSetInitialExpand.current` ensures the effect fires once
  // when the data arrives and never again, so subsequent SSE snapshots can
  // mutate `rootCauses` without clobbering a user-toggled collapse/expand.
  // The mount-time reset (in the runId-keyed effect above) re-arms the ref
  // when navigating to a different run.
  //
  // `runId` is included in the dep array so navigating between two cached
  // runs that happen to have the same `rootCausesCount` still re-fires the
  // effect — without it, the `runId`-keyed reset would flip the ref back to
  // `false` but `rootCausesCount` (unchanged) wouldn't trigger the effect,
  // leaving the new run's panel collapsed.
  const rootCausesCount = Array.isArray(run?.rootCauses) ? run.rootCauses.length : 0;
  useEffect(() => {
    if (hasSetInitialExpand.current) return;
    if (rootCausesCount === 0) return;
    hasSetInitialExpand.current = true;
    setRootCauseExpanded(rootCausesCount >= 2);
  }, [rootCausesCount, runId]);

  // SSE — receives live updates while the run is active.
  // Pass run?.status as initialStatus so the hook can skip SSE entirely
  // for already-completed/failed runs (avoids spurious "Run complete" notifications).
  const { sseDown, retryIn } = useRunSSE(runId, useCallback((event) => {
    if (event.type === "snapshot") {
      updateRun(() => event.run);
    } else if (event.type === "result") {
      updateRun((prev) => {
        if (!prev) return prev;
        const results = [...(prev.results || [])];
        const idx = results.findIndex((r) => r.testId === event.result.testId);
        if (idx >= 0) results[idx] = { ...results[idx], ...event.result };
        else results.push(event.result);
        return { ...prev, results };
      });
    } else if (event.type === "log") {
      updateRun((prev) => {
        if (!prev) return prev;
        return { ...prev, logs: [...(prev.logs || []), event.message] };
      });
    } else if (event.type === "frame") {
      // Keep only the latest frame — canvas paints it on rAF
      setFrames([event.data]);
    } else if (event.type === "llm_token") {
      setLlmTokens((prev) => {
        const next = prev + event.token;
        if (next.length > LLM_TOKEN_LIMIT) {
          return "⚠ Older output truncated (>" + Math.round(LLM_TOKEN_LIMIT / 1000) + "k chars) — showing most recent output\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" + next.slice(next.length - LLM_TOKEN_LIMIT);
        }
        return next;
      });
    } else if (event.type === "done") {
      // Immediately mark as completed so the UI stops showing "running"
      // (isRunning = run.status === "running" flips to false right away,
      //  so CrawlView/GenerateView render their completed state instantly)
      updateRun((prev) => prev ? { ...prev, status: event.status ?? "completed" } : prev);
      setFrames([]); // clear live stream on completion
      // Then re-fetch to get the full completed run object (stats, results, etc.)
      fetchRun();

      // ── In-app notification ──────────────────────────────────────────
      const isTestRun = event.passed != null || event.failed != null;
      const status = event.status ?? "completed";
      const notifType = status === "completed"       ? "success"
                      : status === "completed_empty" ? "warning"
                      : status === "aborted"         ? "warning"
                      : "error";
      addNotification({
        type: notifType,
        title: status === "completed_empty" ? "No tests generated"
             : status === "aborted" ? "Run aborted"
             : status === "failed"  ? "Run failed"
             : "Run complete",
        body: isTestRun
          ? `${event.passed ?? 0} passed · ${event.failed ?? 0} failed`
          : status === "completed_empty"
            ? "Crawl completed but generated 0 tests — check project settings"
            : `${event.testsGenerated ?? 0} test(s) generated`,
        link: `/runs/${runId}`,
      });
    }
  }, [fetchRun, addNotification, runId]), initialStatus);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="rd-skeleton-shell">
        <div className="skeleton rd-skeleton-row1" />
        <div className="skeleton rd-skeleton-row2" />
        <div className="rd-skeleton-grid">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      </div>
    );
  }

  if (!run) {
    return <div className="rd-not-found">Run not found</div>;
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const isRunning = run.status === "running";
  const isCrawl    = run.type === "crawl";
  const isGenerate = run.type === "generate";

  // For test runs: results = test cases
  const results = run.results || [];
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  // AUTO-001: tests dropped by the risk-based budget truncation surface as
  // `status: "skipped"` + `skipReason: "over_budget"` so they're attributable
  // (never silently dropped).
  const skippedOverBudget = results.filter((r) => r.status === "skipped" && r.skipReason === "over_budget").length;
  const skippedNoImpact = results.filter((r) => r.status === "skipped" && r.skipReason === "skipped_no_impact").length;
  const skippedUpstreamFailed = results.filter((r) => r.status === "skipped" && r.skipReason === "upstream_failed").length;
  const skippedMissingUpstream = results.filter((r) => r.status === "skipped" && r.skipReason === "missing_upstream").length;
  const changedFiles = Array.isArray(run.changedFiles) ? run.changedFiles : [];
  const impactAnalysis = run.impactAnalysis && typeof run.impactAnalysis === "object" ? run.impactAnalysis : null;
  const impactedCount = Array.isArray(impactAnalysis?.impactedTestIds) ? impactAnalysis.impactedTestIds.length : null;
  // Use run.total (set upfront by the backend) so the count is correct from
  // the first SSE snapshot — results.length grows as tests complete and would
  // show "0 test cases" until the first result arrives.
  const total = run.total ?? results.length;
  // AUTO-001 / AUTO-004: non-executed skips (`over_budget`, `skipped_no_impact`)
  // never ran and shouldn't dilute the pass-rate denominator — they're each
  // surfaced via their own badge above. Routes through `countNonExecutedSkips`
  // (frontend/src/utils/skipReasons.js) so the list of excluded skip reasons
  // stays byte-aligned with `evaluateQualityGates()` in `backend/src/testRunner.js`
  // (via `backend/src/utils/skipReasons.js`). If the two ever drift the gate
  // verdict and the rendered pass rate will disagree on the same run.
  const passRateDenominator = Math.max(0, total - countNonExecutedSkips(results));
  const passRate = passRateDenominator > 0 ? Math.round((passed / passRateDenominator) * 100) : null;

  // AUTO-010 — `useEffect` for the initial-expand decision lives at the top
  // of the component (before the early returns) so the React hooks-rules
  // contract holds. This local is just the array reference for rendering.
  const rootCauses = Array.isArray(run.rootCauses) ? run.rootCauses : [];

  const traceUrl = run.tracePath ?? null;
  const traceViewerUrl = traceUrl ? `/trace-viewer/?trace=${encodeURIComponent(traceUrl)}` : null;
  // CAP-002 Phase 2 (Prerequisite #2) — shard-mode runs produce one trace
  // zip per shard at `/artifacts/traces/${runId}/shard-${i}.zip`. The
  // backend populates `run.tracePaths[]` (JSON array, migration 026)
  // alongside the single-link `run.tracePath` for backwards compat.
  // Render a dropdown when there are ≥2 shard traces; otherwise the
  // existing single-link UI below covers both `shardCount === 1` and
  // legacy pre-Phase-2 runs.
  //
  // `tracePaths` is intentionally a *sparse* array indexed by shardIndex —
  // a shard that crashed before writing its trace leaves a `null` slot
  // (see `backend/src/middleware/appSetup.js` `signRunArtifacts` which
  // preserves sparse entries as `null` so the index → shard mapping is
  // not lost). We must therefore retain the original index when filtering
  // out the empty slots; using the filtered array's index for the label
  // would mislabel "Shard 3" as "Shard 2" when shard 1 is missing.
  const shardTracePaths = Array.isArray(run.tracePaths)
    ? run.tracePaths
        .map((p, i) => (typeof p === "string" && p.length > 0 ? { path: p, shardIndex: i } : null))
        .filter(Boolean)
    : [];
  // CAP-002 Phase 2 — denominator for the per-shard option label MUST match
  // the header badge (`Shards M/N` at line 524, which uses `run.shardCount`).
  // `tracePaths` is populated incrementally as each shard flushes its zip
  // (`runRepo.setShardTracePath`), so `tracePaths.length` can be less than
  // `shardCount` either:
  //   - mid-run (sibling shards haven't flushed yet), or
  //   - on a completed run where a shard crashed before writing its trace
  //     (sparse `null` slot survives but the array length still trails).
  // Using `tracePaths.length` would show "Shard 1/2" alongside a "Shards 2/4"
  // header — a confusing inconsistency. Anchor to `run.shardCount` and only
  // fall back to the array length for legacy / pre-migration-025 runs that
  // never persisted `shardCount`.
  const totalShardCount = Number(run.shardCount) > 0
    ? Number(run.shardCount)
    : (Array.isArray(run.tracePaths) ? run.tracePaths.length : 0);
  const hasShardTraces = shardTracePaths.length > 1;

  // MNT-010: Show re-run button for crawl/generate runs in terminal states
  const TERMINAL_STATUSES = new Set(["completed", "completed_empty", "failed", "interrupted", "aborted"]);
  const canRerun = (isCrawl || isGenerate) && TERMINAL_STATUSES.has(run.status);
  // B1 (AUDIT-ROADMAP) — Show "Resume" only for crash-recovered test runs.
  // Mirrors the backend gate exactly: status='interrupted' AND
  // failureReason='process_crash'. User aborts and ordinary failures are
  // NOT resumable — the operator must re-trigger via POST /run instead.
  const canResume = !isCrawl && !isGenerate
    && run.status === "interrupted"
    && run.failureReason === "process_crash";

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fade-in rd-page">
      {/* ── Breadcrumb (NAV-002, audit) ─────────────────────────────────
          Semantic trail using `<Breadcrumb>`: each segment is a real
          `<Link>` so middle-click opens in a new tab and screen readers
          announce the chain. Replaces the prior `navigate(-1)` back arrow
          which was unreliable for users arriving via notification link,
          bookmark, or direct URL (it landed on the previous browser-history
          page, not the logical parent).
          Project segment falls back to `null` when `projectName` isn't
          hydrated yet (older cached run rows from before the backend
          NAV-002 hydration shipped); `<Breadcrumb>` skips items with
          neither label nor `to` cleanly. */}
      <Breadcrumb
        items={[
          { label: "Dashboard", to: "/dashboard" },
          { label: "Projects",  to: "/projects" },
          run.projectName
            ? { label: run.projectName, to: `/projects/${run.projectId}` }
            : { label: "Project",       to: `/projects/${run.projectId}` },
          { label: "Runs",      to: "/runs" },
          { label: `Run #${runId.length > 6 ? runId.slice(0, 6).toUpperCase() : runId.toUpperCase()}` },
        ]}
      />
      {/* Note: the `useNavigate`-based back arrow is intentionally gone.
          Browser-history back is still one keystroke away (⌫ or browser
          chrome); the breadcrumb above gives the *logical* path. */}

      {/* ── Task header ────────────────────────────────────────────────── */}
      <div className="rd-header-wrap">
        <div className="rd-header">
          <h1 className="rd-title">
            Task #{runId.length > 6 ? runId.slice(0, 6).toUpperCase() + "…" : runId.toUpperCase()}:{" "}
            {isCrawl ? "Crawl & Generate" : isGenerate ? "AI Generate" : "Test Run"}
          </h1>

          {run.status === "completed" && !run.rateLimitError && (
            <span className="badge badge-green">
              <CheckCircle2 size={10} /> Completed
            </span>
          )}
          {run.status === "completed" && run.rateLimitError && (
            <span className="badge badge-amber rd-badge-amber-inline">
              ⚠ Rate Limited
            </span>
          )}
          {run.status === "completed_empty" && (
            <span className="badge badge-amber rd-badge-amber-inline">
              <AlertTriangle size={10} /> No Tests Generated
            </span>
          )}
          {isRunning && (
            <span className="badge badge-blue">● Running</span>
          )}
          {run.status === "failed" && (
            <span className="badge badge-red">
              <XCircle size={10} /> Failed
            </span>
          )}
          {run.status === "aborted" && (
            <span className="badge badge-gray">
              <Ban size={10} /> Aborted
            </span>
          )}
          {run.status === "interrupted" && (
            <span
              className="badge badge-amber rd-badge-amber-inline"
              title={run.failureReason === "process_crash"
                ? "The server crashed mid-run — click Resume to re-run only the tests that didn't finish."
                : "Run was interrupted before completion."}
            >
              <AlertTriangle size={10} /> Interrupted
            </span>
          )}

          {/* B3 (AUDIT-ROADMAP) — reviewer-collapse chip. The pre-run
              gate in `crawler.js` flags the run when the workspace's
              author + reviewer agent_configs resolve to the same
              provider route id; this chip surfaces that policy decision
              inline with the run header so operators auditing "did this
              run get an independent review?" don't have to dig into
              the agent_event timeline. Boolean-coerced because the
              column ships INTEGER NOT NULL DEFAULT 0. */}
          {(run.reviewerCollapsed === 1 || run.reviewerCollapsed === true) && (
            <span
              className="badge badge-amber rd-badge-amber-inline"
              title="Author and reviewer share the same provider route — this run used heuristic-only review. Configure a distinct reviewer route in Settings → Agent Roles to enable independent review."
            >
              <AlertTriangle size={10} /> Reviewer collapsed — heuristic-only review
            </span>
          )}

          {/* Browser engine (DIF-002b) — only meaningful for test runs.
              Crawl and generate runs are pinned to chromium. */}

          {!isCrawl && !isGenerate && Number(run.shardCount || 1) > 1 && (
            <span className="badge badge-blue">
              Shards {Math.max(0, Number(run.shardsCompleted || 0))}/{Number(run.shardCount)}
            </span>
          )}
          {!isCrawl && !isGenerate && run.browser && (
            <BrowserBadge browser={run.browser} />
          )}

          {/* Quality gate result (AUTO-012) — test runs only.
              Renders nothing when gateResult is null (no gates configured). */}
          {!isCrawl && !isGenerate && (
            <GateBadge gateResult={run.gateResult} />
          )}

          <div className="rd-header-actions">
            {isRunning && (
              <button
                className="btn btn-sm rd-stop-btn"
                onClick={handleAbort}
                disabled={aborting}
              >
                {aborting
                  ? <RefreshCw size={12} className="spin" />
                  : <StopCircle size={12} />}
                {aborting ? "Stopping…" : "Stop Task"}
              </button>
            )}
            {canRerun && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleRerun}
                disabled={rerunning}
                title={isCrawl ? "Re-run crawl & generate" : "Re-run AI generate"}
              >
                {rerunning
                  ? <RefreshCw size={12} className="spin" />
                  : <RotateCcw size={12} />}
                {rerunning ? "Starting…" : "Re-run"}
              </button>
            )}
            {canResume && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleResume}
                disabled={resuming}
                title="Resume — re-run only the tests that didn't finish before the server crash"
              >
                {resuming
                  ? <RefreshCw size={12} className="spin" />
                  : <RotateCcw size={12} />}
                {resuming ? "Resuming…" : "Resume"}
              </button>
            )}
            {/* CAP-002 Phase 2 — per-shard trace dropdown when shardCount > 1
                and the run actually emitted per-shard zips. Falls back to the
                single-link UI for `shardCount === 1` and legacy runs. */}
            {hasShardTraces ? (
              <select
                className="input btn-sm rd-trace-select"
                aria-label="Open trace for shard"
                defaultValue=""
                onChange={(e) => {
                  const path = e.target.value;
                  if (!path) return;
                  window.open(`/trace-viewer/?trace=${encodeURIComponent(path)}`, "_blank", "noreferrer");
                  e.target.value = ""; // reset so re-selecting the same shard re-opens
                }}
              >
                <option value="" disabled>🔍 Open Trace…</option>
                {shardTracePaths.map(({ path, shardIndex }) => (
                  <option key={shardIndex} value={path}>
                    Shard {shardIndex + 1}/{totalShardCount || shardTracePaths.length}
                  </option>
                ))}
              </select>
            ) : traceUrl && (
              <>
                <a href={traceViewerUrl} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                  🔍 Open Trace
                </a>
                <a href={traceUrl} download className="btn btn-ghost btn-sm">
                  <Download size={12} /> Trace ZIP
                </a>
              </>
            )}
            {!isCrawl && !isGenerate && (
              <button className="btn btn-ghost btn-sm" onClick={handleCompare}>Compare</button>
            )}
            {/* ENT-004 (audit) — deep-link to the workspace Audit Log
                pre-filtered to this run. Server-side `runId = ?` filter
                lands admins on the tight per-run slice (trigger / abort /
                complete / regenerate / healing rows) instead of the
                whole project's feed. Backed by `activities.runId` (column
                + index added in migration 055); writers populate the
                column from a first-class `logActivity({ runId, … })`
                arg OR from legacy `meta.runId` so historical rows that
                stashed it in JSON are also reachable. Mirrors the same
                affordance on TestDetail.jsx. */}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate(`/audit-log?runId=${encodeURIComponent(runId)}`)}
              title="See trigger, abort, completion, and regenerate events for this run"
            >
              View activity →
            </button>
            <button className="btn btn-ghost btn-sm" onClick={fetchRun}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>

        <div className="rd-meta">
          <span className="rd-meta-mono">
            #{runId.length > 8 ? runId.slice(0, 8) + "…" : runId}
          </span>
          <span className="rd-meta-item">
            <AgentTag type="TA" /> Sentri Agent
          </span>
          <span className="rd-meta-item">
            <Clock size={12} />
            {run.startedAt
              ? new Date(run.startedAt).toLocaleString()
              : "—"}
          </span>
          {run.duration && <span>⏱ {fmtMs(run.duration)}</span>}
          {!isCrawl && total > 0 && (
            <span>
              {passed} passed · {failed} failed · {total} test cases
            </span>
          )}
          {!isCrawl && skippedOverBudget > 0 && (
            <span
              className="badge badge-amber rd-meta-badge-xs"
              title="Tests skipped to fit the requested budget — risk-based ordering kept the most likely-to-fail tests in scope."
            >
              ⏱ {skippedOverBudget} skipped (over budget)
            </span>
          )}
          {!isCrawl && skippedNoImpact > 0 && (
            <span
              className="badge badge-gray rd-meta-badge-xs"
              title="Tests skipped because the git diff did not map to their captured routes."
            >
              {skippedNoImpact} skipped (no impact)
            </span>
          )}
          {!isCrawl && skippedUpstreamFailed > 0 && (
            <span
              className="badge badge-blue rd-meta-badge-xs"
              title="Tests skipped because a prerequisite test failed."
            >
              🔗 {skippedUpstreamFailed} skipped (upstream failed)
            </span>
          )}
          {!isCrawl && skippedMissingUpstream > 0 && (
            <span
              className="badge badge-gray rd-meta-badge-xs"
              title="Tests skipped because a declared dependency was outside this dispatch set."
            >
              🔗 {skippedMissingUpstream} skipped (missing upstream)
            </span>
          )}
          {!isCrawl && run.budgetMinutes != null && (
            <span className="rd-meta-budget">
              budget: {run.budgetMinutes}m
            </span>
          )}
        </div>
      </div>

      {!isCrawl && !isGenerate && (compareData || compareLoading || compareError) && (
        <>
          {priorRuns.length > 1 && (
            <div className="card rd-compare-bar">
              <label htmlFor="compare-prior-run" className="rd-compare-label">
                Compare against:
              </label>
              <select
                id="compare-prior-run"
                className="input rd-compare-select"
                value={compareData?.otherRun?.id || priorRuns[0]?.id || ""}
                onChange={(e) => runCompareAgainst(e.target.value)}
              >
                {priorRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id.slice(0, 8)} — {r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"}
                  </option>
                ))}
              </select>
            </div>
          )}
          <RunCompareView data={compareData} loading={compareLoading} error={compareError} />
        </>
      )}


      {!isCrawl && !isGenerate && (changedFiles.length > 0 || impactAnalysis) && (
        <div className="card rd-impact-card">
          <div className="rd-impact-head">
            <div className="rd-impact-title">Impact scope</div>
            {impactedCount !== null && (
              <span className="badge badge-blue rd-impact-badge-xs">
                {impactedCount} impacted / {total} approved
              </span>
            )}
          </div>
          {impactAnalysis?.fallbackReason && (
            <div className="rd-impact-fallback">
              Fallback: {impactAnalysis.fallbackReason.replace(/_/g, " ")}
            </div>
          )}
          {changedFiles.length > 0 ? (
            <div className="rd-impact-files">
              {changedFiles.slice(0, 12).map((file) => (
                <code key={file} className="rd-impact-file-code">
                  {file}
                </code>
              ))}
              {changedFiles.length > 12 && (
                <span className="rd-impact-overflow">+{changedFiles.length - 12} more</span>
              )}
            </div>
          ) : (
            <div className="rd-impact-empty">No changed files were supplied; Sentri used the full approved suite.</div>
          )}
        </div>
      )}

      {/* ── Pass rate bar (test runs only) ─────────────────────────────── */}
      {!isCrawl && total > 0 && (
        <div className="rd-passrate-wrap">
          <div className="rd-passrate-header">
            <span>
              {passed + failed} / {total} test cases executed
            </span>
            {passRate !== null && (
              <span
                className={`rd-passrate-value ${
                  passRate >= 80 ? "rd-passrate-value--good"
                  : passRate >= 50 ? "rd-passrate-value--warn"
                  : "rd-passrate-value--bad"
                }`}
              >
                {passRate}% pass rate
              </span>
            )}
          </div>
          <div className="progress-bar progress-bar-green">
            {/* Width is data-driven from `passRate` (0–100). AGENTS.md §127
                carves out runtime-numeric style values — keep this inline. */}
            <div
              className="progress-bar-fill rd-passrate-fill"
              style={{ width: `${passRate || 0}%` }}
            />
          </div>
        </div>
      )}

      {/* ── SSE reconnection / fallback banner ── */}
      {isRunning && retryIn != null && !sseDown && (
        <div className="rd-sse-banner rd-sse-banner--info">
          <RefreshCw size={12} className="rd-sse-icon" />
          Connection lost — reconnecting in {retryIn}s…
        </div>
      )}
      {sseDown && isRunning && (
        <div className="rd-sse-banner rd-sse-banner--warn">
          <RefreshCw size={12} className="rd-sse-icon rd-sse-icon--spinning" />
          Live updates unavailable — refreshing every 5s.{" "}
          <button onClick={fetchRun} className="rd-sse-refresh-link">Refresh now</button>
        </div>
      )}

      {/* ── Run-level error / warning banners ─────────────────────────── */}
      {/* ── ENH-034: Empty crawl guidance banner ─────────────────────── */}
      {!isRunning && run.status === "completed_empty" && (
        <div className="rd-alert rd-alert--amber">
          <span className="rd-alert__icon-emoji">⚠️</span>
          <div>
            <div className="rd-alert__title">No Tests Generated</div>
            <div>The crawl completed successfully but did not produce any tests. This usually means the AI could not find testable interactions on the discovered pages.</div>
            <div className="rd-alert__list">
              <div className="rd-alert__list-head">Try these fixes:</div>
              <div>1. <strong>Check credentials</strong> — if the site requires login, add credentials in Project Settings</div>
              <div>2. <strong>Try a different start URL</strong> — point to a page with forms, buttons, or interactive elements</div>
              <div>3. <strong>Use State Exploration mode</strong> — it clicks and fills to discover dynamic content that link crawl misses</div>
              <div>4. <strong>Verify your AI provider</strong> — check that your API key is valid in Settings</div>
            </div>
          </div>
        </div>
      )}
      {!isRunning && run.rateLimitError && (
        <div className="rd-alert rd-alert--amber">
          <span className="rd-alert__icon-emoji">⚠️</span>
          <div>
            <div className="rd-alert__title">AI Rate Limit Reached</div>
            <div>{run.rateLimitError}</div>
            <div className="rd-alert__sub">
              Switch to a different AI provider in Settings, or wait for the rate limit to reset and retry.
            </div>
          </div>
        </div>
      )}
      {!isRunning && run.status === "failed" && run.error && !run.rateLimitError && (() => {
        const bp = getErrorBannerProps(run.errorCategory, navigate);
        // Per-category palette (bg / border / text colour) is data-driven from
        // `getErrorBannerProps()` — kept inline per AGENTS.md §127. Layout,
        // typography, and gap rules live on `.rd-alert` + `.rd-alert__cta`.
        return (
          <div
            className="rd-alert"
            style={{ background: bp.bg, border: `1px solid ${bp.border}`, color: bp.color }}
          >
            <span className="rd-alert__icon-wrap">{bp.icon}</span>
            <div className="rd-alert__body">
              <div className="rd-alert__title">{bp.title}</div>
              <div className="rd-alert__body--break">{run.error}</div>
              {bp.action && (
                <button
                  onClick={bp.action.onClick}
                  className="rd-alert__cta"
                  style={{ border: `1px solid ${bp.border}`, color: bp.color }}
                >
                  <Settings size={11} /> {bp.action.label}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Quality gate violations (AUTO-012) ─────────────────────────── */}
      {!isCrawl && !isGenerate && run.gateResult && run.gateResult.passed === false && Array.isArray(run.gateResult.violations) && run.gateResult.violations.length > 0 && (
        <div className="rd-alert rd-alert--red">
          <XCircle size={16} className="rd-alert__icon-wrap" />
          <div className="rd-alert__body">
            <div className="rd-alert__title">
              Quality Gate Failed ({run.gateResult.violations.length} violation{run.gateResult.violations.length !== 1 ? "s" : ""})
            </div>
            <div className="rd-gate-list">
              {run.gateResult.violations.map((v, i) => (
                <div key={i} className="rd-gate-violation">
                  <strong className="rd-gate-violation__rule">{v.rule}</strong>
                  : actual <strong>{v.actual}{v.rule.includes("Pct") ? "%" : ""}</strong> vs threshold <strong>{v.threshold}{v.rule.includes("Pct") ? "%" : ""}</strong>
                  {/* AUTO-009d — regression gate carries the baseline so operators
                      see "dropped from 80% to 68%" not just "12% > 5%". */}
                  {v.priorCoveragePct != null && (
                    <span className="rd-gate-violation__prior"> (prior run: {v.priorCoveragePct}%)</span>
                  )}
                </div>
              ))}
            </div>
            <div className="rd-gate-footer">
              CI pipelines polling the trigger endpoint receive <code>gateResult.passed: false</code> and should exit non-zero.
            </div>
          </div>
        </div>
      )}

      {/* ── Root cause summary (AUTO-010) ───────────────────────────────── */}
      {run.type === "test_run" && rootCauses.length >= 1 && (
        <div className="card rd-rootcause-card">
          <button className="btn btn-ghost btn-sm" onClick={() => setRootCauseExpanded((v) => !v)}>{rootCauseExpanded ? "▼" : "▶"} Root Cause Summary ({rootCauses.length})</button>
          {rootCauseExpanded && (
            <div className="rd-rootcause-grid">
              {rootCauses.map((cluster) => {
                // AUTO-010 — surface the deduplicated test-id count so data-
                // driven tests with N failing iterations don't inflate the
                // "N affected test(s)" copy. `cluster.size` still reflects
                // total failed-result rows for analytics consumers.
                const affectedCount = Array.isArray(cluster.affectedTestIds)
                  ? cluster.affectedTestIds.length
                  : cluster.size;
                return (
                  <div key={cluster.fingerprint} className="card rd-rootcause-item">
                    <div className="rd-rootcause-pattern">{cluster.errorPattern || "Likely root cause"}</div>
                    <div className="rd-rootcause-affected">{affectedCount} affected test(s)</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Main content ───────────────────────────────────────────────── */}
      {isCrawl ? (
        <CrawlView run={run} isRunning={isRunning} />
      ) : isGenerate ? (
        <GenerateView run={run} isRunning={isRunning} llmTokens={llmTokens} />
      ) : (
        <TestRunView run={run} frames={frames} />
      )}

      {/* ── GAP-005 (audit, Path B): Agent Call Timeline ─────────────────
          Per-run AI call drill-down. Renders a collapsible card that lazy-
          fetches `GET /runs/:runId/ai-requests` on click. Admin-gated on the
          backend; non-admin users see an empty state. Only shown for crawl
          and generate runs (test_run doesn't make AI calls). */}
      {(isCrawl || isGenerate) && !isRunning && (
        <AgentCallTimeline runId={runId} />
      )}

      {/* ── B3 (AUDIT-ROADMAP) — Tests discarded by review ─────────────── */}
      {Array.isArray(run.reviewRejectedTests) && run.reviewRejectedTests.length > 0 && (
        <div className="card rd-rootcause-card">
          <h2 className="rd-analytics-title">
            Tests discarded by review ({run.reviewRejectedTests.length})
          </h2>
          <p className="rd-analytics-section-label" style={{ marginBottom: 8 }}>
            The reviewer↔author loop terminated with <code>ReviewRejection</code> on
            {" "}{run.reviewRejectedTests.length === 1 ? "this test" : "these tests"};
            they were not promoted to draft. Inspect each test's agent conversation
            thread to see the reviewer's verdict.
          </p>
          <div className="rd-flaky-wrap">
            {run.reviewRejectedTests.map((rej) => (
              <div key={rej.testId || rej.testName} className="rd-flaky-row">
                <span className="rd-flaky-row__name">
                  {rej.testId ? (
                    <a href={`/projects/${run.projectId}/tests/${encodeURIComponent(rej.testId)}`}>
                      {rej.testName || rej.testId}
                    </a>
                  ) : (rej.testName || "Unknown test")}
                </span>
                <span className="rd-flaky-row__stats">
                  {rej.failureCategory || "UNKNOWN"} · {rej.roundsCompleted ?? 0} round
                  {rej.roundsCompleted === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Quality Analytics (shown when run has analytics data) ──────── */}
      {run.qualityAnalytics && run.qualityAnalytics.totalFailures > 0 && (
        <div className="card rd-analytics-card">
          <h2 className="rd-analytics-title">Quality Insights</h2>

          {/* Insights */}
          {run.qualityAnalytics.insights?.length > 0 && (
            <div className="rd-analytics-insights">
              {run.qualityAnalytics.insights.map((insight, i) => (
                <div key={i} className="rd-analytics-insight">
                  💡 {insight}
                </div>
              ))}
            </div>
          )}

          {/* Breakdown grids — `.rd-analytics-grid` keeps the responsive
              3→2→1 column rules in run-detail.css. */}
          <div className="rd-analytics-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            {/* By category */}
            {Object.keys(run.qualityAnalytics.byCategory || {}).length > 0 && (
              <div>
                <div className="rd-analytics-section-label">By failure category</div>
                {Object.entries(run.qualityAnalytics.byCategory).map(([cat, count]) => (
                  <div key={cat} className="rd-analytics-row">
                    <span className="rd-analytics-row__label">{cat.replace(/_/g, " ")}</span>
                    <span className="rd-analytics-row__val-red">{count}</span>
                  </div>
                ))}
              </div>
            )}

            {/* By test type */}
            {Object.keys(run.qualityAnalytics.byType || {}).length > 0 && (
              <div>
                <div className="rd-analytics-section-label">By test type</div>
                {Object.entries(run.qualityAnalytics.byType).map(([type, count]) => (
                  <div key={type} className="rd-analytics-row">
                    <span className="rd-analytics-row__label--cap">{type}</span>
                    <span className="rd-analytics-row__val-text">{count}</span>
                  </div>
                ))}
              </div>
            )}

            {/* By assertion method */}
            {Object.keys(run.qualityAnalytics.failedAssertionMethods || {}).length > 0 && (
              <div>
                <div className="rd-analytics-section-label">Failed assertion types</div>
                {Object.entries(run.qualityAnalytics.failedAssertionMethods).map(([method, count]) => (
                  <div key={method} className="rd-analytics-row">
                    <span className="rd-analytics-row__mono">{method}</span>
                    <span className="rd-analytics-row__val-red">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Flaky tests */}
          {run.qualityAnalytics.flakyTests?.length > 0 && (
            <div className="rd-flaky-wrap">
              <div className="rd-analytics-section-label">
                Flaky tests ({run.qualityAnalytics.flakyTests.length})
              </div>
              {run.qualityAnalytics.flakyTests.map(ft => (
                <div key={ft.testId} className="rd-flaky-row">
                  <span className="rd-flaky-row__name">{ft.name}</span>
                  <span className="rd-flaky-row__stats">
                    {ft.passCount}✓ / {ft.failCount}✗ ({ft.flakyRate}% flaky)
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────────────────
          The footer "Back" still uses `navigate(-1)` deliberately — it's a
          secondary convenience after long page content scroll, and the
          NAV-002 breadcrumb at the top covers the *logical-parent*
          navigation case. Removing this would force a scroll-to-top
          before the user can navigate, which is worse UX than the
          imprecise back-history step. */}
      <div className="rd-footer">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft size={14} /> Back
        </button>
        <button className="btn btn-ghost btn-sm" onClick={fetchRun}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
    </div>
  );
}
import React, { useEffect, useState, useCallback } from "react";
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

import CrawlView from "../components/crawl/CrawlView";
import GenerateView from "../components/generate/GenerateView";
import TestRunView from "../components/run/TestRunView";
import AgentTag from "../components/shared/AgentTag.jsx";
import usePageTitle from "../hooks/usePageTitle.js";

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
  const { addNotification } = useNotifications();

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
          addNotification({
            type: "error",
            title: "Re-run failed",
            body: "Original generation input not found — please create a new generation instead.",
          });
          return;
        }
        result = await api.generateTest(run.projectId, {
          name: input.name,
          description: input.description,
          dialsConfig: input.dialsConfig,
        });
      }
      if (result?.runId) {
        addNotification({ type: "success", title: "Re-run started", body: `New run ${result.runId} created` });
        navigate(`/runs/${result.runId}`);
      }
    } catch (err) {
      addNotification({ type: "error", title: "Re-run failed", body: err.message || "Unknown error" });
    } finally {
      setRerunning(false);
    }
  }, [run, rerunning, navigate, addNotification]);

  // Reset live-stream state when navigating to a different run
  useEffect(() => {
    setFrames([]);
    setLlmTokens("");
    setInitialStatus(undefined);
  }, [runId]);

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
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 16px" }}>
        <div
          className="skeleton"
          style={{ height: 90, borderRadius: 12, marginBottom: 16 }}
        />
        <div
          className="skeleton"
          style={{ height: 60, borderRadius: 8, marginBottom: 16 }}
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "320px 1fr",
            gap: 16,
            height: 560,
          }}
        >
          <div className="skeleton" style={{ borderRadius: 12 }} />
          <div className="skeleton" style={{ borderRadius: 12 }} />
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}>
        Run not found
      </div>
    );
  }

  // ── Derived values ───────────────────────────────────────────────────────
  const isRunning = run.status === "running";
  const isCrawl    = run.type === "crawl";
  const isGenerate = run.type === "generate";

  // For test runs: results = test cases
  const results = run.results || [];
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  // Use run.total (set upfront by the backend) so the count is correct from
  // the first SSE snapshot — results.length grows as tests complete and would
  // show "0 test cases" until the first result arrives.
  const total = run.total ?? results.length;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : null;

  const traceUrl = run.tracePath ?? null;

  // MNT-010: Show re-run button for crawl/generate runs in terminal states
  const TERMINAL_STATUSES = new Set(["completed", "completed_empty", "failed", "interrupted", "aborted"]);
  const canRerun = (isCrawl || isGenerate) && TERMINAL_STATUSES.has(run.status);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="fade-in"
      style={{ maxWidth: 1200, margin: "0 auto", padding: "0 16px 40px", overflowX: "hidden" }}
    >
      {/* ── Breadcrumb ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 20,
          fontSize: "0.82rem",
          color: "var(--text3)",
        }}
      >
        <button
          onClick={() => navigate(-1)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: "var(--text2)",
            fontWeight: 500,
          }}
        >
          <ArrowLeft size={14} /> Runs
        </button>
        <span>›</span>
        <span>Run Detail</span>
      </div>

      {/* ── Task header ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <div
          className="rd-header"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 6,
          }}
        >
          <h1 style={{ fontWeight: 700, fontSize: "1.3rem" }}>
            Task #{runId.length > 6 ? runId.slice(0, 6).toUpperCase() + "…" : runId.toUpperCase()}:{" "}
            {isCrawl ? "Crawl & Generate" : isGenerate ? "AI Generate" : "Test Run"}
          </h1>

          {run.status === "completed" && !run.rateLimitError && (
            <span className="badge badge-green">
              <CheckCircle2 size={10} /> Completed
            </span>
          )}
          {run.status === "completed" && run.rateLimitError && (
            <span className="badge badge-amber" style={{ background: "var(--amber-bg)", color: "#92400e", border: "1px solid #fcd34d" }}>
              ⚠ Rate Limited
            </span>
          )}
          {run.status === "completed_empty" && (
            <span className="badge badge-amber" style={{ background: "var(--amber-bg)", color: "#92400e", border: "1px solid #fcd34d" }}>
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

          <div className="rd-header-actions" style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {isRunning && (
              <button
                className="btn btn-sm"
                style={{
                  background: "var(--red-bg)", color: "var(--red)",
                  border: "1px solid #fca5a5", fontWeight: 600,
                }}
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
            {traceUrl && (
              <a href={traceUrl} download className="btn btn-ghost btn-sm">
                <Download size={12} /> Trace ZIP
              </a>
            )}
            <button className="btn btn-ghost btn-sm" onClick={fetchRun}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>

        <div
          className="rd-meta"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            color: "var(--text3)",
            fontSize: "0.78rem",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)" }}>
            #{runId.length > 8 ? runId.slice(0, 8) + "…" : runId}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <AgentTag type="TA" /> Sentri Agent
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
        </div>
      </div>

      {/* ── Pass rate bar (test runs only) ─────────────────────────────── */}
      {!isCrawl && total > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.78rem",
              color: "var(--text2)",
              marginBottom: 6,
            }}
          >
            <span>
              {passed + failed} / {total} test cases executed
            </span>
            {passRate !== null && (
              <span
                style={{
                  fontWeight: 600,
                  color:
                    passRate >= 80
                      ? "var(--green)"
                      : passRate >= 50
                      ? "var(--amber)"
                      : "var(--red)",
                }}
              >
                {passRate}% pass rate
              </span>
            )}
          </div>
          <div className="progress-bar progress-bar-green">
            <div
              className="progress-bar-fill"
              style={{
                width: `${passRate || 0}%`,
                transition: "width 0.8s ease",
              }}
            />
          </div>
        </div>
      )}

      {/* ── SSE reconnection / fallback banner ── */}
      {isRunning && retryIn != null && !sseDown && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 14px", marginBottom: 12,
          background: "var(--blue-bg)", border: "1px solid #bfdbfe",
          borderRadius: 8, fontSize: "0.76rem", color: "var(--blue)",
        }}>
          <RefreshCw size={12} style={{ flexShrink: 0 }} />
          Connection lost — reconnecting in {retryIn}s…
        </div>
      )}
      {sseDown && isRunning && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 14px", marginBottom: 12,
          background: "var(--amber-bg)", border: "1px solid #fcd34d",
          borderRadius: 8, fontSize: "0.76rem", color: "var(--amber)",
        }}>
          <RefreshCw size={12} style={{ animation: "spin 2s linear infinite", flexShrink: 0 }} />
          Live updates unavailable — refreshing every 5s. <button onClick={fetchRun} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--amber)", fontWeight: 600, textDecoration: "underline", padding: 0, fontSize: "0.76rem" }}>Refresh now</button>
        </div>
      )}

      {/* ── Run-level error / warning banners ─────────────────────────── */}
      {/* ── ENH-034: Empty crawl guidance banner ─────────────────────── */}
      {!isRunning && run.status === "completed_empty" && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          padding: "12px 16px", marginBottom: 16,
          background: "var(--amber-bg)", border: "1px solid #fcd34d",
          borderRadius: 10, fontSize: "0.82rem", color: "#92400e", lineHeight: 1.5,
        }}>
          <span style={{ fontSize: "1.1rem", flexShrink: 0 }}>⚠️</span>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>No Tests Generated</div>
            <div>The crawl completed successfully but did not produce any tests. This usually means the AI could not find testable interactions on the discovered pages.</div>
            <div style={{ marginTop: 8, fontSize: "0.78rem", color: "#78350f" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Try these fixes:</div>
              <div>1. <strong>Check credentials</strong> — if the site requires login, add credentials in Project Settings</div>
              <div>2. <strong>Try a different start URL</strong> — point to a page with forms, buttons, or interactive elements</div>
              <div>3. <strong>Use State Exploration mode</strong> — it clicks and fills to discover dynamic content that link crawl misses</div>
              <div>4. <strong>Verify your AI provider</strong> — check that your API key is valid in Settings</div>
            </div>
          </div>
        </div>
      )}
      {!isRunning && run.rateLimitError && (
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          padding: "12px 16px", marginBottom: 16,
          background: "var(--amber-bg)", border: "1px solid #fcd34d",
          borderRadius: 10, fontSize: "0.82rem", color: "#92400e", lineHeight: 1.5,
        }}>
          <span style={{ fontSize: "1.1rem", flexShrink: 0 }}>⚠️</span>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>AI Rate Limit Reached</div>
            <div>{run.rateLimitError}</div>
            <div style={{ marginTop: 4, fontSize: "0.78rem", color: "#78350f" }}>
              Switch to a different AI provider in Settings, or wait for the rate limit to reset and retry.
            </div>
          </div>
        </div>
      )}
      {!isRunning && run.status === "failed" && run.error && !run.rateLimitError && (() => {
        const bp = getErrorBannerProps(run.errorCategory, navigate);
        return (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            padding: "12px 16px", marginBottom: 16,
            background: bp.bg, border: `1px solid ${bp.border}`,
            borderRadius: 10, fontSize: "0.82rem", color: bp.color, lineHeight: 1.5,
          }}>
            <span style={{ flexShrink: 0, marginTop: 1 }}>{bp.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>{bp.title}</div>
              <div style={{ wordBreak: "break-word" }}>{run.error}</div>
              {bp.action && (
                <button
                  onClick={bp.action.onClick}
                  style={{
                    marginTop: 8, padding: "5px 12px", borderRadius: 6,
                    border: `1px solid ${bp.border}`, background: "rgba(255,255,255,0.5)",
                    color: bp.color, fontWeight: 600, fontSize: "0.78rem",
                    cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5,
                  }}
                >
                  <Settings size={11} /> {bp.action.label}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Main content ───────────────────────────────────────────────── */}
      {isCrawl ? (
        <CrawlView run={run} isRunning={isRunning} />
      ) : isGenerate ? (
        <GenerateView run={run} isRunning={isRunning} llmTokens={llmTokens} />
      ) : (
        <TestRunView run={run} frames={frames} />
      )}

      {/* ── Quality Analytics (shown when run has analytics data) ──────── */}
      {run.qualityAnalytics && run.qualityAnalytics.totalFailures > 0 && (
        <div className="card" style={{ padding: 24, marginTop: 20 }}>
          <h2 style={{ fontWeight: 700, fontSize: "1rem", marginTop: 0, marginBottom: 16 }}>
            Quality Insights
          </h2>

          {/* Insights */}
          {run.qualityAnalytics.insights?.length > 0 && (
            <div style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 8 }}>
              {run.qualityAnalytics.insights.map((insight, i) => (
                <div key={i} style={{
                  padding: "10px 14px", background: "var(--amber-bg)",
                  border: "1px solid #fcd34d", borderRadius: 8,
                  fontSize: "0.82rem", color: "#92400e", lineHeight: 1.5,
                }}>
                  💡 {insight}
                </div>
              ))}
            </div>
          )}

          {/* Breakdown grids */}
          <div className="rd-analytics-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            {/* By category */}
            {Object.keys(run.qualityAnalytics.byCategory || {}).length > 0 && (
              <div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", marginBottom: 8 }}>
                  By failure category
                </div>
                {Object.entries(run.qualityAnalytics.byCategory).map(([cat, count]) => (
                  <div key={cat} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", padding: "3px 0" }}>
                    <span style={{ color: "var(--text2)" }}>{cat.replace(/_/g, " ")}</span>
                    <span style={{ fontWeight: 600, color: "var(--red)" }}>{count}</span>
                  </div>
                ))}
              </div>
            )}

            {/* By test type */}
            {Object.keys(run.qualityAnalytics.byType || {}).length > 0 && (
              <div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", marginBottom: 8 }}>
                  By test type
                </div>
                {Object.entries(run.qualityAnalytics.byType).map(([type, count]) => (
                  <div key={type} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", padding: "3px 0" }}>
                    <span style={{ color: "var(--text2)", textTransform: "capitalize" }}>{type}</span>
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>{count}</span>
                  </div>
                ))}
              </div>
            )}

            {/* By assertion method */}
            {Object.keys(run.qualityAnalytics.failedAssertionMethods || {}).length > 0 && (
              <div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", marginBottom: 8 }}>
                  Failed assertion types
                </div>
                {Object.entries(run.qualityAnalytics.failedAssertionMethods).map(([method, count]) => (
                  <div key={method} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", padding: "3px 0" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text2)" }}>{method}</span>
                    <span style={{ fontWeight: 600, color: "var(--red)" }}>{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Flaky tests */}
          {run.qualityAnalytics.flakyTests?.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: "0.73rem", color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", marginBottom: 8 }}>
                Flaky tests ({run.qualityAnalytics.flakyTests.length})
              </div>
              {run.qualityAnalytics.flakyTests.map(ft => (
                <div key={ft.testId} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: "0.82rem",
                }}>
                  <span style={{ color: "var(--text)" }}>{ft.name}</span>
                  <span style={{ color: "var(--amber)", fontWeight: 600, fontSize: "0.78rem" }}>
                    {ft.passCount}✓ / {ft.failCount}✗ ({ft.flakyRate}% flaky)
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div
        style={{
          marginTop: 20,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
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
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
} from "lucide-react";
import { api } from "../api.js";
import { useRunSSE, requestNotifPermission } from "../hooks/useRunSSE.js";

import CrawlView from "../components/CrawlView";
import GenerateView from "../components/GenerateView";
import TestRunView from "../components/TestRunView";
import AgentTag from "../components/AgentTag.jsx";
import usePageTitle from "../hooks/usePageTitle.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RunDetail() {
  const { runId } = useParams();
  const navigate = useNavigate();

  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [initialStatus, setInitialStatus] = useState(undefined);
  const [frames, setFrames] = useState([]);
  const [llmTokens, setLlmTokens] = useState("");
  usePageTitle(run ? `Run ${runId.slice(0, 6).toUpperCase()}` : "Run Detail");
  const [aborting, setAborting] = useState(false);

  // Cap the streamed token buffer so long-running generation jobs don't
  // accumulate hundreds of thousands of characters and cause layout/memory issues.
  const LLM_TOKEN_LIMIT = 50_000;

  const fetchRun = useCallback(async () => {
    const r = await api.getRun(runId).catch(() => null);
    if (r) setRun(r);
    return r;
  }, [runId]);

  const handleAbort = useCallback(async () => {
    if (aborting) return;
    setAborting(true);
    try {
      await api.abortRun(runId);
      setRun((prev) => prev ? { ...prev, status: "aborted" } : prev);
      setFrames([]);
    } catch (err) {
      console.error("Abort failed:", err);
    } finally {
      setAborting(false);
    }
  }, [runId, aborting]);

  // Initial fetch — capture the run's status at load time so useRunSSE can
  // skip SSE entirely for already-finished runs (prevents spurious notifications).
  useEffect(() => {
    fetchRun().then((r) => {
      if (r) setInitialStatus(r.status);
    }).finally(() => setLoading(false));
  }, [fetchRun]);

  // Request notification permission once when this page is viewed
  useEffect(() => { requestNotifPermission(); }, []);

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
      setRun(event.run);
    } else if (event.type === "result") {
      setRun((prev) => {
        if (!prev) return prev;
        const results = [...(prev.results || [])];
        const idx = results.findIndex((r) => r.testId === event.result.testId);
        if (idx >= 0) results[idx] = { ...results[idx], ...event.result };
        else results.push(event.result);
        return { ...prev, results };
      });
    } else if (event.type === "log") {
      setRun((prev) => {
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
      setRun((prev) => prev ? { ...prev, status: event.status ?? "completed" } : prev);
      setFrames([]); // clear live stream on completion
      // Then re-fetch to get the full completed run object (stats, results, etc.)
      fetchRun();
    }
  }, [fetchRun]), initialStatus);

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

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="fade-in"
      style={{ maxWidth: 1200, margin: "0 auto", padding: "0 16px 40px" }}
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

          {run.status === "completed" && (
            <span className="badge badge-green">
              <CheckCircle2 size={10} /> Completed
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

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
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
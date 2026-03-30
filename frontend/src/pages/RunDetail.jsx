import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Clock,
  Download,
} from "lucide-react";
import { api } from "../api.js";

import CrawlView from "../components/CrawlView";
import GenerateView from "../components/GenerateView";
import TestRunView from "../components/TestRunView";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function AgentTag({ type = "TA" }) {
  const s = { QA: "avatar-qa", TA: "avatar-ta", EX: "avatar-ex" };
  return <div className={`avatar ${s[type] || "avatar-ta"}`}>{type}</div>;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RunDetail() {
  const { runId } = useParams();
  const navigate = useNavigate();

  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);

  const pollRef = useRef(null);

  const fetchRun = useCallback(async () => {
    const r = await api.getRun(runId).catch(() => null);
    if (r) setRun(r);
    return r;
  }, [runId]);

  useEffect(() => {
    fetchRun().finally(() => setLoading(false));
  }, [fetchRun]);

  // Poll while running
  useEffect(() => {
    if (!run) return;
    if (run.status === "running") {
      pollRef.current = setInterval(async () => {
        const r = await fetchRun();
        if (r?.status !== "running") clearInterval(pollRef.current);
      }, 1500);
    }
    return () => clearInterval(pollRef.current);
  }, [run?.status]);

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
  const total = results.length;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : null;

  const BASE_URL = window.location.origin.replace(":3000", ":3001");
  const traceUrl = run.tracePath ? `${BASE_URL}${run.tracePath}` : null;

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
          <ArrowLeft size={14} /> Work
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
            Task #{runId.slice(0, 6).toUpperCase()}:{" "}
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

          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
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
            #{runId.slice(0, 8)}
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

      {/* ── Main content ───────────────────────────────────────────────── */}
      {isCrawl ? (
        <CrawlView run={run} isRunning={isRunning} />
      ) : isGenerate ? (
        <GenerateView run={run} isRunning={isRunning} />
      ) : (
        <TestRunView run={run} />
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

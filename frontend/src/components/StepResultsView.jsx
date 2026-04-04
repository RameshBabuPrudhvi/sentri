import React, { useState, useEffect, useRef } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Globe,
  Lock,
  MoreHorizontal,
} from "lucide-react";
import OverlayCanvas from "./OverlayCanvas.jsx";
import HealingTimeline from "./HealingTimeline.jsx";
import { cleanTestName } from "../utils/formatTestName.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (!ms && ms !== 0) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtBytes(b) {
  if (!b && b !== 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Infer per-step status from the overall test result ──────────────────────
//
// The backend runs the whole test and records one pass/fail + error string.
// The `steps[]` are human-readable strings (e.g. "Login to application").
// We infer which step failed by matching keywords in the error message.
//
function inferStepStatuses(steps = [], result = {}) {
  if (!steps.length) return [];

  const status = result.status || "pending";
  const error = (result.error || "").toLowerCase();

  if (status === "passed") {
    return steps.map(() => "passed");
  }

  if (status === "running") {
    // Find the first step that looks like it's the current one
    // (simple heuristic: mark first N as passed, last as running)
    return steps.map((_, i) =>
      i < steps.length - 1 ? "passed" : "running"
    );
  }

  if (status === "failed") {
    // Try to match the error to a specific step.
    //
    // Strategy: score every step by how many of its meaningful words appear in
    // the error message, then pick the highest-scoring step. Ties are broken by
    // preferring the *later* step (failures are more likely to surface in later
    // steps than early ones). A minimum score of 2 is required so that a single
    // incidental word match (e.g. "navigate" appearing in a URL fragment) does
    // not falsely blame Step 1.
    //
    // URL-encoded noise is stripped from the error first so that words like
    // "navigation" embedded in a percent-encoded query string don't pollute the
    // match.
    const cleanError = error
      .replace(/%[0-9a-f]{2}/gi, " ")   // strip URL-encoded chars
      .replace(/https?:\/\/\S+/g, " ")  // strip full URLs
      .replace(/[^a-z0-9 ]/g, " ");     // keep only alphanum + spaces

    let failedIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < steps.length; i++) {
      // Only consider words longer than 4 characters to skip stop-words
      const stepWords = steps[i]
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .split(" ")
        .filter((w) => w.length > 4);

      if (stepWords.length === 0) continue;

      const matchCount = stepWords.filter((w) => cleanError.includes(w)).length;
      // Require at least 2 matching words, or a majority of the step's words
      const threshold = Math.max(2, Math.ceil(stepWords.length * 0.4));
      if (matchCount >= threshold && matchCount >= bestScore) {
        bestScore = matchCount;
        failedIdx = i;
        // Don't break — keep scanning so a later, better-matching step wins
      }
    }

    // If no keyword match, assume last step failed
    if (failedIdx === -1) failedIdx = steps.length - 1;

    return steps.map((_, i) => {
      if (i < failedIdx) return "passed";
      if (i === failedIdx) return "failed";
      return "pending";
    });
  }

  // Default: all pending
  return steps.map(() => "pending");
}

// ─── Step status visual config ────────────────────────────────────────────────

function StepStatusBadge({ status }) {
  const cfg = {
    passed:  { bg: "var(--green-bg)",  color: "var(--green)",  label: "Passed",  icon: <CheckCircle2 size={10} /> },
    failed:  { bg: "var(--red-bg)",    color: "var(--red)",    label: "Failed",  icon: <XCircle size={10} /> },
    running: { bg: "var(--blue-bg)",   color: "var(--blue)",   label: "Running", icon: <RefreshCw size={10} style={{ animation: "spin 0.9s linear infinite" }} /> },
    warning: { bg: "var(--amber-bg)",  color: "var(--amber)",  label: "Warning", icon: <AlertTriangle size={10} /> },
    pending: { bg: "var(--bg3)",       color: "var(--text3)",  label: "Pending", icon: <Clock size={10} /> },
  };
  const c = cfg[status] || cfg.pending;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 99,
        fontSize: "0.68rem",
        fontWeight: 700,
        background: c.bg,
        color: c.color,
        whiteSpace: "nowrap",
        letterSpacing: "0.01em",
      }}
    >
      {c.icon}
      {c.label}
    </span>
  );
}

function stepLeftColor(status) {
  if (status === "passed") return "var(--green)";
  if (status === "failed") return "var(--red)";
  if (status === "running") return "var(--blue)";
  return "var(--border)";
}

// ─── Browser Chrome Wrapper ───────────────────────────────────────────────────
// Renders a screenshot/content inside a realistic browser UI shell

function BrowserChrome({ url, children, isLoading = false }) {
  // Extract a short domain for the tab title
  let domain = "";
  try {
    domain = url ? new URL(url.startsWith("http") ? url : `https://${url}`).hostname : "Browser";
  } catch {
    domain = url || "Browser";
  }

  return (
    <div
      style={{
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid var(--border)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.10)",
        background: "#f0f0f0",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Title bar ── */}
      <div
        style={{
          background: "linear-gradient(180deg, #e8e8e8 0%, #d8d8d8 100%)",
          padding: "8px 12px 0",
          borderBottom: "1px solid #c0c0c0",
        }}
      >
        {/* Traffic lights + tab */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 0,
            marginBottom: 6,
          }}
        >
          {/* Traffic lights */}
          <div style={{ display: "flex", gap: 6, marginRight: 12 }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <div
                key={c}
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: "50%",
                  background: c,
                  border: "0.5px solid rgba(0,0,0,0.15)",
                }}
              />
            ))}
          </div>

          {/* Tab */}
          <div
            style={{
              background: "#fff",
              borderRadius: "6px 6px 0 0",
              padding: "4px 14px 5px",
              fontSize: "0.72rem",
              color: "#333",
              fontWeight: 500,
              maxWidth: 200,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              borderTop: "1px solid #c0c0c0",
              borderLeft: "1px solid #c0c0c0",
              borderRight: "1px solid #c0c0c0",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Globe size={11} color="#666" />
            {domain}
          </div>
        </div>

        {/* ── Address bar row ── */}
        <div
          style={{
            background: "#fff",
            padding: "2px 4px 6px",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {/* Nav buttons */}
          <button
            style={{
              width: 24,
              height: 24,
              border: "none",
              background: "none",
              cursor: "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              color: "#666",
              opacity: 0.5,
            }}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            style={{
              width: 24,
              height: 24,
              border: "none",
              background: "none",
              cursor: "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              color: "#666",
              opacity: 0.5,
            }}
          >
            <ChevronRight size={14} />
          </button>
          <button
            style={{
              width: 24,
              height: 24,
              border: "none",
              background: "none",
              cursor: "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              color: "#666",
            }}
          >
            {isLoading ? (
              <XCircle size={13} />
            ) : (
              <RotateCcw size={12} />
            )}
          </button>

          {/* URL bar */}
          <div
            style={{
              flex: 1,
              height: 28,
              background: "#f5f5f5",
              borderRadius: 14,
              border: "1px solid #d0d0d0",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 12px",
            }}
          >
            <Lock size={11} color="#888" />
            <span
              style={{
                fontSize: "0.75rem",
                color: "#333",
                fontFamily: "var(--font-sans)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {url || "about:blank"}
            </span>
          </div>

          <button
            style={{
              width: 24,
              height: 24,
              border: "none",
              background: "none",
              cursor: "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              color: "#666",
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      {/* ── Page content ── */}
      <div style={{ background: "#fff", position: "relative" }}>
        {isLoading && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 2,
              background: "var(--accent)",
              animation: "pulse 1.2s ease-in-out infinite",
              zIndex: 10,
            }}
          />
        )}
        {children}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function StepResultsView({ result, run, onBack }) {
  const steps = result?.steps || [];
  const stepStatuses = inferStepStatuses(steps, result);

  const [activeStepIdx, setActiveStepIdx] = useState(() => {
    // Start on the first failed/running step, else 0
    const failIdx = stepStatuses.findIndex((s) => s === "failed" || s === "running");
    return failIdx >= 0 ? failIdx : 0;
  });

  const [activeTab, setActiveTab] = useState(() => result?.videoPath ? "video" : "screenshot");
  const listRef = useRef(null);

  // Extract URL from screenshot or from test source
  const currentUrl = result?.url || result?.sourceUrl || run?.targetUrl || "";

  // Scroll active step into view
  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.querySelector(`[data-step="${activeStepIdx}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeStepIdx]);

  const isRunning = run?.status === "running";
  const hasVideo = !!(result?.videoPath);

  const tabs = [
    ...(hasVideo ? [{ id: "video", label: "🎬 Recording" }] : []),
    { id: "screenshot", label: "📸 Screenshot" },
    { id: "network",    label: "🌐 Network" },
    { id: "console",    label: "📜 Console" },
    { id: "dom",        label: "🧩 DOM" },
  ];

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

      {/* ── Back breadcrumb ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 14,
          fontSize: "0.8rem",
          color: "var(--text3)",
        }}
      >
        <button
          onClick={onBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text2)",
            fontWeight: 500,
            fontSize: "0.8rem",
            padding: "4px 0",
            fontFamily: "var(--font-sans)",
          }}
        >
          <ArrowLeft size={13} />
          Test Suite
        </button>
        <span style={{ color: "var(--border2)" }}>›</span>
        <span
          style={{
            color: "var(--text)",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 400,
          }}
        >
          {cleanTestName(result?.testName || result?.name) || "Test Case"}
        </span>
      </div>

      {/* ── Main split ──────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "300px 1fr",
          gap: 16,
          minHeight: 580,
        }}
      >
        {/* ── LEFT: Activity Log ──────────────────────────────────────── */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "var(--shadow-sm)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontWeight: 700, fontSize: "0.82rem" }}>
              Activity Log
            </span>
            <span style={{ fontSize: "0.68rem", color: "var(--text3)" }}>
              {steps.length > 0
                ? `${steps.length} of ${steps.length} items`
                : "0 items"}
            </span>
          </div>

          {/* Scrollable body */}
          <div ref={listRef} style={{ overflowY: "auto", flex: 1 }}>

            {/* Test case prompt card */}
            <div
              style={{
                margin: "10px 10px 6px",
                padding: "10px 12px",
                background: "var(--accent-bg)",
                border: "1px solid var(--accent)",
                borderRadius: 8,
                fontSize: "0.76rem",
                color: "var(--text)",
                lineHeight: 1.5,
                position: "relative",
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  fontSize: "0.68rem",
                  color: "var(--accent)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginBottom: 4,
                }}
              >
                Test Case
              </div>
              {cleanTestName(result?.testName || result?.name) || "Test"}
              {/* Avatar icon */}
              <div
                style={{
                  position: "absolute",
                  top: 10,
                  right: 10,
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: "0.6rem",
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                AI
              </div>
            </div>

            {/* Step rows */}
            {steps.length === 0 ? (
              <div
                style={{
                  padding: "20px 14px",
                  textAlign: "center",
                  color: "var(--text3)",
                  fontSize: "0.8rem",
                }}
              >
                No step breakdown available.
                <br />
                <span style={{ fontSize: "0.72rem" }}>
                  View debug artifacts on the right.
                </span>
              </div>
            ) : (
              steps.map((step, i) => {
                const stepStatus = stepStatuses[i];
                const isActive = i === activeStepIdx;

                return (
                  <div
                    key={i}
                    data-step={i}
                    onClick={() => setActiveStepIdx(i)}
                    style={{
                      padding: "12px 14px",
                      cursor: "pointer",
                      borderBottom: "1px solid var(--border)",
                      borderLeft: `3px solid ${
                        isActive ? stepLeftColor(stepStatus) : "transparent"
                      }`,
                      background: isActive ? "var(--bg2)" : "transparent",
                      transition: "all 0.12s",
                    }}
                  >
                    {/* Row top: step label + badge */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 5,
                      }}
                    >
                      {/* Step number circle */}
                      <div
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: "50%",
                          border: `2px solid ${stepLeftColor(stepStatus)}`,
                          background:
                            stepStatus === "passed"
                              ? "var(--green-bg)"
                              : stepStatus === "failed"
                              ? "var(--red-bg)"
                              : stepStatus === "running"
                              ? "var(--blue-bg)"
                              : "var(--bg3)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {stepStatus === "running" ? (
                          <RefreshCw
                            size={9}
                            color="var(--blue)"
                            style={{ animation: "spin 0.9s linear infinite" }}
                          />
                        ) : stepStatus === "passed" ? (
                          <CheckCircle2 size={10} color="var(--green)" />
                        ) : stepStatus === "failed" ? (
                          <XCircle size={10} color="var(--red)" />
                        ) : (
                          <span
                            style={{
                              fontSize: "0.6rem",
                              fontWeight: 700,
                              color: "var(--text3)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {i + 1}
                          </span>
                        )}
                      </div>

                      <span
                        style={{
                          fontSize: "0.78rem",
                          fontWeight: 600,
                          color: "var(--text)",
                        }}
                      >
                        Step {i + 1}
                      </span>

                      <div style={{ marginLeft: "auto" }}>
                        <StepStatusBadge status={stepStatus} />
                      </div>
                    </div>

                    {/* Step description */}
                    <div
                      style={{
                        fontSize: "0.76rem",
                        color: "var(--text2)",
                        lineHeight: 1.45,
                        paddingLeft: 30,
                        overflow: "hidden",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {step}
                    </div>

                    {/* Timestamp (derived from durationMs / runTimestamp) */}
                    {result?.durationMs && stepStatus !== "pending" && (
                      <div
                        style={{
                          fontSize: "0.65rem",
                          color: "var(--text3)",
                          paddingLeft: 30,
                          marginTop: 4,
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {/* Show approximate time per step */}
                        ~{fmtMs(
                          Math.round(
                            (result.durationMs / steps.length) * (i + 1)
                          )
                        )}
                      </div>
                    )}

                    {/* Error inline for the failed step */}
                    {stepStatus === "failed" && result?.error && (
                      <div
                        style={{
                          marginTop: 8,
                          marginLeft: 30,
                          padding: "7px 10px",
                          background: "var(--red-bg)",
                          borderRadius: 6,
                          fontSize: "0.71rem",
                          color: "var(--red)",
                          fontFamily: "var(--font-mono)",
                          lineHeight: 1.5,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          borderLeft: "2px solid var(--red)",
                        }}
                      >
                        {result.error.length > 300
                          ? result.error.slice(0, 300) + "…"
                          : result.error}
                      </div>
                    )}

                    {/* Self-healing trace — shown when the active step has healing events */}
                    {isActive && result?.healingEvents?.length > 0 && (
                      <div style={{ marginLeft: 30, marginTop: 8 }}>
                        <HealingTimeline events={result.healingEvents} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── RIGHT: Browser View ──────────────────────────────────────── */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "var(--shadow-sm)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Panel header */}
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
            {/* "Browser View" title */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  background: "var(--bg3)",
                  border: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Globe size={11} color="var(--text3)" />
              </div>
              <span style={{ fontWeight: 700, fontSize: "0.82rem" }}>
                Browser View
              </span>
            </div>

            {/* Tab pills */}
            <div
              style={{
                display: "flex",
                gap: 2,
                background: "var(--bg2)",
                padding: 3,
                borderRadius: 8,
                border: "1px solid var(--border)",
              }}
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  style={{
                    padding: "3px 10px",
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: "0.72rem",
                    fontWeight: 500,
                    fontFamily: "var(--font-sans)",
                    background:
                      activeTab === t.id ? "var(--surface)" : "transparent",
                    color:
                      activeTab === t.id ? "var(--accent)" : "var(--text3)",
                    boxShadow:
                      activeTab === t.id
                        ? "0 1px 3px rgba(0,0,0,0.08)"
                        : "none",
                    transition: "all 0.12s",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Content area */}
          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>

            {/* 🎬 VIDEO RECORDING */}
            {activeTab === "video" && (
              <BrowserChrome url={currentUrl} isLoading={false}>
                {result?.videoPath ? (
                  <video
                    key={result.videoPath}
                    src={result.videoPath}
                    controls
                    autoPlay
                    style={{ width: "100%", display: "block", background: "#000", minHeight: 200 }}
                  >
                    Your browser does not support video playback.
                  </video>
                ) : (
                  <div style={{ padding: "60px 40px", textAlign: "center", background: "#fafafa", color: "#94a3b8" }}>
                    <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }}>🎬</div>
                    <div style={{ fontWeight: 600, marginBottom: 6, color: "#64748b" }}>No recording available</div>
                    <div style={{ fontSize: "0.76rem", lineHeight: 1.6 }}>Video was not recorded for this test case.</div>
                  </div>
                )}
              </BrowserChrome>
            )}

            {/* 📸 SCREENSHOT — shown in browser chrome */}
            {activeTab === "screenshot" && (
              <BrowserChrome
                url={currentUrl}
                isLoading={
                  stepStatuses[activeStepIdx] === "running"
                }
              >
                {result?.screenshot ? (
                  <OverlayCanvas
                    base64={result.screenshot}
                    boxes={result.boundingBoxes || []}
                    status={result.status}
                  />
                ) : (
                  <div
                    style={{
                      padding: "60px 40px",
                      textAlign: "center",
                      background: "#fafafa",
                      color: "#94a3b8",
                    }}
                  >
                    <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }}>
                      📸
                    </div>
                    <div style={{ fontWeight: 600, marginBottom: 6, color: "#64748b" }}>
                      No screenshot captured
                    </div>
                    <div style={{ fontSize: "0.76rem", lineHeight: 1.6 }}>
                      {isRunning
                        ? "Screenshot will appear when this step completes."
                        : "Screenshot was not recorded for this test case."}
                    </div>
                  </div>
                )}
              </BrowserChrome>
            )}

            {/* 🌐 NETWORK */}
            {activeTab === "network" && (
              <div>
                {result?.network?.length > 0 ? (
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: "0.73rem",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <thead>
                      <tr>
                        {["Method", "URL", "Status", "Duration", "Size"].map(
                          (h) => (
                            <th
                              key={h}
                              style={{
                                textAlign: "left",
                                padding: "7px 10px",
                                color: "var(--text3)",
                                borderBottom: "1px solid var(--border)",
                                fontSize: "0.65rem",
                                textTransform: "uppercase",
                                letterSpacing: "0.05em",
                                background: "var(--bg2)",
                                position: "sticky",
                                top: 0,
                              }}
                            >
                              {h}
                            </th>
                          )
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {result.network.map((n, i) => (
                        <tr
                          key={i}
                          style={{ borderBottom: "1px solid var(--border)" }}
                        >
                          <td style={{ padding: "7px 10px" }}>
                            <span
                              style={{
                                padding: "2px 6px",
                                borderRadius: 4,
                                fontSize: "0.65rem",
                                fontWeight: 700,
                                color:
                                  n.method === "GET"
                                    ? "var(--green)"
                                    : "var(--blue)",
                                background:
                                  n.method === "GET"
                                    ? "var(--green-bg)"
                                    : "var(--blue-bg)",
                              }}
                            >
                              {n.method}
                            </span>
                          </td>
                          <td
                            style={{
                              padding: "7px 10px",
                              color: "var(--text2)",
                              maxWidth: 240,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={n.url}
                          >
                            {n.url}
                          </td>
                          <td
                            style={{
                              padding: "7px 10px",
                              fontWeight: 600,
                              color:
                                n.status < 300
                                  ? "var(--green)"
                                  : n.status < 400
                                  ? "var(--amber)"
                                  : "var(--red)",
                            }}
                          >
                            {n.status ?? "—"}
                          </td>
                          <td
                            style={{
                              padding: "7px 10px",
                              color: "var(--text3)",
                            }}
                          >
                            {fmtMs(n.duration)}
                          </td>
                          <td
                            style={{
                              padding: "7px 10px",
                              color: "var(--text3)",
                            }}
                          >
                            {fmtBytes(n.size)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div
                    style={{
                      textAlign: "center",
                      padding: 60,
                      color: "var(--text3)",
                    }}
                  >
                    <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}>
                      🌐
                    </div>
                    No network data recorded for this test case.
                  </div>
                )}
              </div>
            )}

            {/* 📜 CONSOLE */}
            {activeTab === "console" && (
              <div
                style={{
                  background: "#0d1117",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "8px 14px",
                    borderBottom: "1px solid rgba(255,255,255,0.06)",
                    background: "rgba(255,255,255,0.03)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>
                    Console output
                  </span>
                  <span
                    style={{
                      fontSize: "0.65rem",
                      color: "#475569",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {result?.consoleLogs?.length || 0} entries
                  </span>
                </div>
                <div
                  style={{ padding: 12, maxHeight: 460, overflowY: "auto" }}
                >
                  {result?.consoleLogs?.length > 0 ? (
                    result.consoleLogs.map((l, i) => {
                      const colors = {
                        error: "#f87171",
                        warn: "#fbbf24",
                        info: "#60a5fa",
                        log: "#94a3b8",
                      };
                      const c = colors[l.level] || "#94a3b8";
                      return (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            gap: 12,
                            padding: "2px 0",
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.73rem",
                            lineHeight: 1.7,
                            borderBottom: "1px solid rgba(255,255,255,0.03)",
                          }}
                        >
                          <span style={{ color: "#475569", flexShrink: 0 }}>
                            {new Date(l.time).toLocaleTimeString()}
                          </span>
                          <span
                            style={{
                              color: c,
                              fontWeight: 600,
                              width: 40,
                              flexShrink: 0,
                            }}
                          >
                            {l.level?.toUpperCase()}
                          </span>
                          <span
                            style={{
                              color:
                                l.level === "error" ? "#fca5a5" : "#94a3b8",
                              wordBreak: "break-all",
                            }}
                          >
                            {l.text}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div
                      style={{
                        padding: 20,
                        textAlign: "center",
                        color: "#475569",
                        fontSize: "0.76rem",
                      }}
                    >
                      No console output captured.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 🧩 DOM */}
            {activeTab === "dom" && (
              <div>
                {result?.domSnapshot ? (
                  <DomNode node={result.domSnapshot} />
                ) : (
                  <div
                    style={{
                      textAlign: "center",
                      padding: 60,
                      color: "var(--text3)",
                    }}
                  >
                    <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}>
                      🧩
                    </div>
                    No DOM snapshot available.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DOM Renderer (local copy) ────────────────────────────────────────────────

function DomNode({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  if (!node) return null;

  if (node.type === "text") {
    return (
      <span
        style={{
          color: "#94a3b8",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
        }}
      >
        "{node.text}"
      </span>
    );
  }

  const attrs = Object.entries(node.attrs || {})
    .map(
      ([k, v]) =>
        ` <span style="color:#f59e0b">${k}</span>=<span style="color:#34d399">"${v}"</span>`
    )
    .join("");

  const hasChildren = node.children?.length > 0;

  return (
    <div
      style={{
        background: "#0d1117",
        borderRadius: depth === 0 ? 10 : 0,
        border: depth === 0 ? "1px solid var(--border)" : "none",
        padding: depth === 0 ? "14px 16px" : 0,
        marginLeft: depth * 14,
        lineHeight: 1.8,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          cursor: hasChildren ? "pointer" : "default",
          color: "#93c5fd",
        }}
        onClick={() => hasChildren && setOpen((o) => !o)}
      >
        {hasChildren ? (open ? "▾ " : "▸ ") : "  "}
        <span style={{ color: "#60a5fa" }}>&lt;{node.tag}</span>
        <span dangerouslySetInnerHTML={{ __html: attrs }} />
        {!hasChildren && <span style={{ color: "#60a5fa" }}> /&gt;</span>}
        {hasChildren && <span style={{ color: "#60a5fa" }}>&gt;</span>}
      </span>
      {hasChildren && open && (
        <div>
          {node.children.map((c, i) => (
            <DomNode key={i} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
      {hasChildren && open && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "#60a5fa",
            marginLeft: depth * 14,
          }}
        >
          &lt;/{node.tag}&gt;
        </span>
      )}
    </div>
  );
}
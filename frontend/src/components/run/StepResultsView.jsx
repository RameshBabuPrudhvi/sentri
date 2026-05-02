import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, CheckCircle2, XCircle, Clock, AlertTriangle,
  RefreshCw, RotateCcw, ChevronLeft, ChevronRight,
  Globe, Lock, MoreHorizontal, ExternalLink,
} from "lucide-react";
import OverlayCanvas from "./OverlayCanvas.jsx";
import HealingTimeline from "./HealingTimeline.jsx";
import { cleanTestName } from "../../utils/formatTestName.js";
import { fmtMs, fmtBytes } from "../../utils/formatters.js";
import { escapeHtml } from "../../utils/markdown.js";
import { api } from "../../api.js";

// ─── Infer per-step status ────────────────────────────────────────────────────
function inferStepStatuses(steps = [], result = {}) {
  if (!steps.length) return [];
  const status = result.status || "pending";
  const error  = (result.error || "").toLowerCase();

  if (status === "passed")  return steps.map(() => "passed");
  if (status === "running") return steps.map((_, i) => i < steps.length - 1 ? "passed" : "running");

  if (status === "failed") {
    const cleanError = error
      .replace(/%[0-9a-f]{2}/gi, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9 ]/g, " ");

    const assertionKeywords = [];
    const assertionPatterns = [
      { re: /tohave(?:title|url|text|value|count)/i, words: ["title","verif","assert","check","redirect"] },
      { re: /tobevisible|tobeenabled|tobedisabled|tobechecked/i, words: ["verif","visible","assert","check"] },
      { re: /tocontaintext/i, words: ["verif","contain","assert","check","text"] },
    ];
    for (const { re, words } of assertionPatterns) {
      if (re.test(error)) assertionKeywords.push(...words);
    }

    let failedIdx = -1, bestScore = 0;
    for (let i = 0; i < steps.length; i++) {
      const stepWords = steps[i].toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter(w => w.length > 3);
      if (!stepWords.length) continue;
      let matchCount = stepWords.filter(w => cleanError.includes(w)).length;
      if (assertionKeywords.length > 0) {
        const stepLower = steps[i].toLowerCase();
        matchCount += assertionKeywords.filter(kw => stepLower.includes(kw)).length;
      }
      const threshold = Math.max(2, Math.ceil(stepWords.length * 0.4));
      if (matchCount >= threshold && matchCount >= bestScore) {
        bestScore = matchCount;
        failedIdx = i;
      }
    }
    if (failedIdx === -1) failedIdx = steps.length - 1;
    return steps.map((_, i) => i < failedIdx ? "passed" : i === failedIdx ? "failed" : "pending");
  }

  return steps.map(() => "pending");
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StepStatusBadge({ status }) {
  const cfg = {
    passed:  { bg: "var(--green-bg)", color: "var(--green)",  label: "Passed",  icon: <CheckCircle2 size={10} /> },
    failed:  { bg: "var(--red-bg)",   color: "var(--red)",    label: "Failed",  icon: <XCircle size={10} /> },
    running: { bg: "var(--blue-bg)",  color: "var(--blue)",   label: "Running", icon: <RefreshCw size={10} style={{ animation: "spin 0.9s linear infinite" }} /> },
    warning: { bg: "var(--amber-bg)", color: "var(--amber)",  label: "Warning", icon: <AlertTriangle size={10} /> },
    pending: { bg: "var(--bg3)",      color: "var(--text3)",  label: "Pending", icon: <Clock size={10} /> },
  };
  const c = cfg[status] || cfg.pending;
  return (
    <span className="srv-status-badge" style={{ background: c.bg, color: c.color }}>
      {c.icon}{c.label}
    </span>
  );
}

function stepLeftColor(status) {
  if (status === "passed")  return "var(--green)";
  if (status === "failed")  return "var(--red)";
  if (status === "running") return "var(--blue)";
  return "var(--border)";
}

// ─── Browser Chrome ───────────────────────────────────────────────────────────
function BrowserChrome({ url, children, isLoading = false }) {
  let domain = "";
  try {
    domain = url ? new URL(url.startsWith("http") ? url : `https://${url}`).hostname : "Browser";
  } catch {
    domain = url || "Browser";
  }

  return (
    <div className="srv-chrome">
      <div className="srv-chrome-titlebar">
        <div className="srv-chrome-toptray">
          <div className="srv-chrome-lights">
            {["#ff5f57","#febc2e","#28c840"].map(c => (
              <div key={c} className="srv-chrome-light" style={{ background: c }} />
            ))}
          </div>
          <div className="srv-chrome-tab">
            <Globe size={11} color="#666" />
            {domain}
          </div>
        </div>

        <div className="srv-chrome-addressbar">
          <button className="srv-chrome-nav-btn faded"><ChevronLeft size={14} /></button>
          <button className="srv-chrome-nav-btn faded"><ChevronRight size={14} /></button>
          <button className="srv-chrome-nav-btn">
            {isLoading ? <XCircle size={13} /> : <RotateCcw size={12} />}
          </button>
          <div className="srv-chrome-url-bar">
            <Lock size={11} color="#888" />
            <span className="srv-chrome-url-text">{url || "about:blank"}</span>
          </div>
          <button className="srv-chrome-nav-btn"><MoreHorizontal size={14} /></button>
        </div>
      </div>

      <div className="srv-chrome-content">
        {isLoading && <div className="srv-chrome-loading-bar" />}
        {children}
      </div>
    </div>
  );
}

// ─── Visual Diff Panel ────────────────────────────────────────────────────────
function VisualDiffPanel({ visualDiff, currentScreenshot, testId, runId, stepNumber }) {
  const [mode, setMode]         = useState("diff");
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted]   = useState(false);
  const [error, setError]         = useState(null);

  if (!visualDiff) return null;

  const { status, diffPixels, totalPixels, diffRatio, threshold, baselinePath, diffPath, message } = visualDiff;
  const percent = diffRatio != null ? (diffRatio * 100).toFixed(2) : null;

  const statusLabel = {
    baseline_created: { text: "Baseline captured",          color: "var(--blue)",  bg: "var(--blue-bg)"  },
    match:            { text: "No visual regression",       color: "var(--green)", bg: "var(--green-bg)" },
    regression:       { text: "Visual regression detected", color: "var(--red)",   bg: "var(--red-bg)"   },
    error:            { text: "Visual diff unavailable",    color: "var(--amber)", bg: "var(--amber-bg)" },
  }[status] || { text: status, color: "var(--text2)", bg: "var(--bg2)" };

  const canToggle = status === "regression" || status === "match";

  async function handleAccept() {
    if (!testId || !runId) return;
    setAccepting(true); setError(null);
    try { await api.acceptBaseline(testId, stepNumber || 0, runId); setAccepted(true); }
    catch (e) { setError(e.message || "failed to accept baseline"); }
    finally { setAccepting(false); }
  }

  let shownSrc = null;
  if (mode === "before" && baselinePath) shownSrc = baselinePath;
  else if (mode === "diff" && diffPath) shownSrc = diffPath;
  else if (mode === "after" && currentScreenshot) {
    shownSrc = currentScreenshot.startsWith("data:") ? currentScreenshot : `data:image/png;base64,${currentScreenshot}`;
  }

  return (
    <div className="srv-vdiff">
      <div className="srv-vdiff-banner" style={{ background: statusLabel.bg }}>
        <span className="srv-vdiff-status" style={{ color: statusLabel.color }}>{statusLabel.text}</span>
        {percent != null && (
          <span className="srv-vdiff-stats">
            {percent}% of pixels differ ({diffPixels}/{totalPixels}) · threshold {(threshold * 100).toFixed(1)}%
          </span>
        )}
        {message && <span className="srv-vdiff-msg">{message}</span>}
      </div>

      {canToggle && (baselinePath || diffPath || currentScreenshot) && (
        <div className="srv-vdiff-toolbar">
          {[
            { id: "before", label: "Baseline", enabled: !!baselinePath },
            { id: "after",  label: "Current",  enabled: !!currentScreenshot },
            { id: "diff",   label: "Diff",     enabled: !!diffPath },
          ].map(t => (
            <button
              key={t.id}
              disabled={!t.enabled}
              onClick={() => setMode(t.id)}
              className={`srv-vdiff-mode-btn ${mode === t.id ? "active" : ""}`}
              style={{ opacity: t.enabled ? 1 : 0.4, cursor: t.enabled ? "pointer" : "not-allowed" }}
            >
              {t.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {status === "regression" && (
            <button
              onClick={handleAccept}
              disabled={accepting || accepted}
              className={`srv-vdiff-accept-btn ${accepted ? "accepted" : ""}`}
              title="Promote the current capture to the new baseline"
            >
              {accepted ? "Baseline updated" : accepting ? "Accepting…" : "Accept visual changes"}
            </button>
          )}
        </div>
      )}

      <div className="srv-vdiff-img-wrap">
        {shownSrc
          ? <img src={shownSrc} alt={`Visual ${mode}`} className="srv-vdiff-img" />
          : <div className="srv-vdiff-no-img">No image to display for "{mode}".</div>}
      </div>

      {error && <div className="srv-vdiff-error">{error}</div>}
    </div>
  );
}

// ─── Network status colour helper ─────────────────────────────────────────────
function netStatusColor(s) {
  if (!s || s === 0) return "var(--red)";
  if (s < 300) return "var(--green)";
  if (s < 400) return "var(--amber)";
  return "var(--red)";
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function StepResultsView({ result, run, onBack }) {
  const navigate = useNavigate();
  const steps = result?.steps || [];
  const stepStatuses = inferStepStatuses(steps, result);
  const testId = result?.testId;

  const [activeStepIdx, setActiveStepIdx] = useState(() => {
    const failIdx = stepStatuses.findIndex(s => s === "failed" || s === "running");
    return failIdx >= 0 ? failIdx : 0;
  });

  const [activeTab, setActiveTab] = useState(() => result?.videoPath ? "video" : "screenshot");
  const listRef = useRef(null);
  const currentUrl = result?.url || result?.sourceUrl || run?.targetUrl || "";

  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.querySelector(`[data-step="${activeStepIdx}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeStepIdx]);

  const isRunning = run?.status === "running";
  const hasVideo  = !!(result?.videoPath);
  const isApi     = !!result?.isApiTest;

  const activeStepCapture = result?.stepCaptures?.find(c => c.step === activeStepIdx + 1);
  const activeVisualDiff  = activeStepCapture?.visualDiff || result?.visualDiff;
  const hasVisualDiff     = !!activeVisualDiff;

  useEffect(() => {
    if (activeTab === "visual" && !hasVisualDiff) {
      setActiveTab(hasVideo ? "video" : "screenshot");
    }
  }, [activeTab, hasVisualDiff, hasVideo]);

  const tabs = isApi
    ? [
        { id: "screenshot", label: "🔌 Result"  },
        { id: "network",    label: "🌐 Network"  },
      ]
    : [
        ...(hasVideo        ? [{ id: "video",      label: "🎬 Recording" }] : []),
        { id: "screenshot",   label: "📸 Screenshot" },
        ...(hasVisualDiff   ? [{ id: "visual",     label: "🖼️ Visual"    }] : []),
        { id: "network",      label: "🌐 Network"   },
        { id: "console",      label: "📜 Console"   },
        { id: "dom",          label: "🧩 DOM"       },
      ];

  // AUTO-017: Filter run-level violations down to the test currently being viewed.
  // `run.webVitalsResult.violations` aggregates across every test in the run; the
  // detail view only shows one test at a time, so display only its own offenders.
  const webVitalsViolations = (Array.isArray(run?.webVitalsResult?.violations) ? run.webVitalsResult.violations : [])
    .filter((v) => !result?.testId || v.testId === result.testId);

  return (
    <div className="srv-root">

      {/* ── Breadcrumb ── */}
      <div className="srv-breadcrumb">
        <button className="srv-breadcrumb-btn" onClick={onBack}>
          <ArrowLeft size={13} /> Test Suite
        </button>
        <span className="srv-breadcrumb-sep">›</span>
        <span className="srv-breadcrumb-current">
          {cleanTestName(result?.testName || result?.name) || "Test Case"}
        </span>
        {testId && (
          <>
            <span className="srv-breadcrumb-sep">›</span>
            <button
              className="srv-breadcrumb-test-link"
              onClick={() => navigate(`/tests/${testId}`)}
              title="Go to test detail to edit steps"
            >
              {testId}<ExternalLink size={11} />
            </button>
          </>
        )}
      </div>

      {run?.webVitalsResult && webVitalsViolations.length > 0 && (
        <div className="card" style={{ marginBottom: 12, borderColor: "var(--red-200)" }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Web Vitals Budget Failed ({webVitalsViolations.length})</div>
          {webVitalsViolations.slice(0, 5).map((v, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--text2)" }}>
              <span className="badge badge-red" style={{ marginRight: 8 }}>{String(v.rule).toUpperCase()}</span>
              threshold {v.threshold} · actual {v.actual}
            </div>
          ))}
        </div>
      )}

      {/* ── Main split ── */}
      <div className="srv-grid">

        {/* ── LEFT: Activity Log ── */}
        <div className="srv-panel">
          <div className="srv-panel-header">
            <span className="srv-panel-title">Activity Log</span>
            <span className="srv-panel-count">
              {steps.length > 0 ? `${steps.length} of ${steps.length} items` : "0 items"}
            </span>
          </div>

          <div ref={listRef} className="srv-log-body">
            {/* Test case prompt card */}
            <div className="srv-prompt-card">
              <div className="srv-prompt-label-row">
                <span>Test Case</span>
                {testId && (
                  <button
                    className="srv-prompt-test-link"
                    onClick={() => navigate(`/tests/${testId}`)}
                    title="View & edit test steps"
                  >
                    {testId} <ExternalLink size={9} />
                  </button>
                )}
              </div>
              {cleanTestName(result?.testName || result?.name) || "Test"}
            </div>

            {/* Step rows */}
            {steps.length === 0 ? (
              <div className="srv-log-empty">
                No step breakdown available.<br />
                <span className="srv-log-empty-sub">View debug artifacts on the right.</span>
              </div>
            ) : (
              steps.map((step, i) => {
                const stepStatus = stepStatuses[i];
                const isActive   = i === activeStepIdx;
                return (
                  <div
                    key={i}
                    data-step={i}
                    onClick={() => setActiveStepIdx(i)}
                    className={`srv-step-row ${isActive ? "active" : ""}`}
                    style={{ borderLeftColor: isActive ? stepLeftColor(stepStatus) : "transparent" }}
                  >
                    <div className="srv-step-top">
                      {/* Step circle */}
                      <div
                        className={`srv-step-circle ${stepStatus}`}
                        style={{ borderColor: stepLeftColor(stepStatus) }}
                      >
                        {stepStatus === "running" ? (
                          <RefreshCw size={9} color="var(--blue)" style={{ animation: "spin 0.9s linear infinite" }} />
                        ) : stepStatus === "passed" ? (
                          <CheckCircle2 size={10} color="var(--green)" />
                        ) : stepStatus === "failed" ? (
                          <XCircle size={10} color="var(--red)" />
                        ) : (
                          <span className="srv-step-num-text">{i + 1}</span>
                        )}
                      </div>

                      <span className="srv-step-label">Step {i + 1}</span>
                      <div className="srv-step-badge"><StepStatusBadge status={stepStatus} /></div>
                    </div>

                    <div className="srv-step-desc">{step}</div>

                    {/* Timing */}
                    {stepStatus !== "pending" && (() => {
                      const realTiming = result?.stepTimings?.find(t => t.step === i + 1);
                      if (realTiming) return <div className="srv-step-timing">{fmtMs(realTiming.durationMs)}</div>;
                      if (result?.durationMs) return <div className="srv-step-timing">~{fmtMs(Math.round((result.durationMs / steps.length) * (i + 1)))}</div>;
                      return null;
                    })()}

                    {/* Error inline */}
                    {stepStatus === "failed" && result?.error && (
                      <div className="srv-step-error">
                        {result.error.length > 300 ? result.error.slice(0, 300) + "…" : result.error}
                      </div>
                    )}

                    {/* Self-healing trace */}
                    {isActive && result?.healingEvents?.length > 0 && (
                      <div className="srv-healing-wrap">
                        <HealingTimeline events={result.healingEvents} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── RIGHT: Browser View ── */}
        <div className="srv-panel">
          <div className="srv-browser-header">
            <div className="srv-browser-title-row">
              <div className="srv-browser-icon">
                {isApi ? <span style={{ fontSize: 11 }}>🔌</span> : <Globe size={11} color="var(--text3)" />}
              </div>
              <span className="srv-browser-title">{isApi ? "API Response" : "Browser View"}</span>
            </div>

            <div className="srv-tab-group">
              {tabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`srv-tab-pill ${activeTab === t.id ? "active" : ""}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="srv-content">

            {/* 🎬 VIDEO */}
            {activeTab === "video" && (
              <BrowserChrome url={currentUrl} isLoading={false}>
                {result?.videoPath ? (
                  <video key={result.videoPath} src={result.videoPath} controls autoPlay
                    style={{ width: "100%", display: "block", background: "#000", minHeight: 200 }}>
                    Your browser does not support video playback.
                  </video>
                ) : (
                  <div className="srv-screenshot-empty">
                    <div className="srv-screenshot-empty-icon">🎬</div>
                    <div className="srv-screenshot-empty-title">No recording available</div>
                    <div className="srv-screenshot-empty-desc">Video was not recorded for this test case.</div>
                  </div>
                )}
              </BrowserChrome>
            )}

            {/* 📸 SCREENSHOT / 🔌 API RESULT */}
            {activeTab === "screenshot" && (() => {
              const stepCapture    = result?.stepCaptures?.find(c => c.step === activeStepIdx + 1);
              const activeScreenshot = stepCapture?.screenshot || result?.screenshot;
              const activeBoxes    = stepCapture ? [] : (result?.boundingBoxes || []);

              return isApi ? (
                <div className="srv-api-panel">
                  <div className="srv-api-header">
                    <span style={{ fontSize: 14 }}>🔌</span>
                    <span className="srv-api-header-title">API Test Result</span>
                  </div>
                  <div className="srv-api-status-banner" style={{
                    background: result?.status === "passed" ? "var(--green-bg)" : result?.status === "failed" ? "var(--red-bg)" : "var(--bg2)",
                  }}>
                    <div className="srv-api-status-icon">
                      {result?.status === "passed" ? "✓" : result?.status === "failed" ? "✗" : "⏳"}
                    </div>
                    <div className="srv-api-status-label" style={{
                      color: result?.status === "passed" ? "var(--green)" : result?.status === "failed" ? "var(--red)" : "var(--text2)",
                    }}>
                      {result?.status === "passed" ? "API Test Passed" : result?.status === "failed" ? "API Test Failed" : "Pending"}
                    </div>
                    {result?.durationMs != null && <div className="srv-api-duration">{fmtMs(result.durationMs)}</div>}
                  </div>

                  {result?.network?.length > 0 && (
                    <div className="srv-api-calls-section">
                      <div className="srv-api-calls-label">API Calls ({result.network.length})</div>
                      {result.network.map((n, i) => (
                        <div key={i} className="srv-net-card">
                          <div className="srv-net-card-header">
                            <span className="srv-net-method" style={{
                              color: n.method === "GET" ? "var(--green)" : "var(--blue)",
                              background: n.method === "GET" ? "var(--green-bg)" : "var(--blue-bg)",
                            }}>{n.method}</span>
                            <span className="srv-net-url" title={n.url}>{n.url}</span>
                            <span className="srv-net-status" style={{ color: netStatusColor(n.status) }}>{n.status || "—"}</span>
                            <span className="srv-net-meta">{fmtMs(n.duration)}</span>
                            <span className="srv-net-meta">{fmtBytes(n.size)}</span>
                          </div>
                          {(n.requestHeaders || n.requestBody) && (
                            <div style={{ borderBottom: "1px solid var(--border)" }}>
                              <div className="srv-net-section-label">Request</div>
                              {n.requestHeaders && (
                                <div style={{ padding: "6px 12px", borderBottom: n.requestBody ? "1px solid var(--border)" : "none" }}>
                                  <div className="srv-net-sub-label">Headers</div>
                                  <pre className="srv-net-pre">{typeof n.requestHeaders === "string" ? n.requestHeaders : JSON.stringify(n.requestHeaders, null, 2)}</pre>
                                </div>
                              )}
                              {n.requestBody && (
                                <div style={{ padding: "6px 12px" }}>
                                  <div className="srv-net-sub-label">Body</div>
                                  <pre className="srv-net-pre">{n.requestBody}</pre>
                                </div>
                              )}
                            </div>
                          )}
                          <div>
                            <div className="srv-net-section-label">Response</div>
                            {n.responseHeaders && (
                              <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)" }}>
                                <div className="srv-net-sub-label">Headers</div>
                                <pre className="srv-net-pre">{typeof n.responseHeaders === "string" ? n.responseHeaders : JSON.stringify(n.responseHeaders, null, 2)}</pre>
                              </div>
                            )}
                            <div style={{ padding: "6px 12px" }}>
                              <div className="srv-net-sub-label">Body</div>
                              {n.responseBody ? (
                                <pre className="srv-net-body-pre">{(() => { try { return JSON.stringify(JSON.parse(n.responseBody), null, 2); } catch { return n.responseBody; } })()}</pre>
                              ) : (
                                <span className="srv-net-no-body">No body captured</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <BrowserChrome url={currentUrl} isLoading={stepStatuses[activeStepIdx] === "running"}>
                  {activeScreenshot ? (
                    <OverlayCanvas
                      base64={activeScreenshot}
                      boxes={activeBoxes}
                      status={stepCapture ? stepStatuses[activeStepIdx] : result.status}
                    />
                  ) : (
                    <div className="srv-screenshot-empty">
                      <div className="srv-screenshot-empty-icon">📸</div>
                      <div className="srv-screenshot-empty-title">No screenshot captured</div>
                      <div className="srv-screenshot-empty-desc">
                        {isRunning ? "Screenshot will appear when this step completes." : "Screenshot was not recorded for this test case."}
                      </div>
                    </div>
                  )}
                </BrowserChrome>
              );
            })()}

            {/* 🖼️ VISUAL DIFF */}
            {activeTab === "visual" && (() => {
              const stepCapture = result?.stepCaptures?.find(c => c.step === activeStepIdx + 1);
              const vd = stepCapture?.visualDiff || result?.visualDiff;
              const screenshotForAccept = stepCapture?.screenshot || result?.screenshot;
              const stepNumber = stepCapture ? stepCapture.step : 0;
              return (
                <VisualDiffPanel
                  visualDiff={vd}
                  currentScreenshot={screenshotForAccept}
                  testId={testId}
                  runId={run?.id}
                  stepNumber={stepNumber}
                />
              );
            })()}

            {/* 🌐 NETWORK */}
            {activeTab === "network" && (
              result?.network?.length > 0 ? (
                <table className="srv-net-table">
                  <thead>
                    <tr>{["Method","URL","Status","Duration","Size"].map(h => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {result.network.map((n, i) => (
                      <tr key={i}>
                        <td>
                          <span className="srv-net-method" style={{
                            color: n.method === "GET" ? "var(--green)" : "var(--blue)",
                            background: n.method === "GET" ? "var(--green-bg)" : "var(--blue-bg)",
                          }}>{n.method}</span>
                        </td>
                        <td className="url-cell" title={n.url}>{n.url}</td>
                        <td style={{ fontWeight: 600, color: netStatusColor(n.status) }}>{n.status || "—"}</td>
                        <td style={{ color: "var(--text3)" }}>{fmtMs(n.duration)}</td>
                        <td style={{ color: "var(--text3)" }}>{fmtBytes(n.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="srv-net-empty">
                  <div className="srv-net-empty-icon">🌐</div>
                  No network data recorded for this test case.
                </div>
              )
            )}

            {/* 📜 CONSOLE */}
            {activeTab === "console" && (
              <div className="srv-console">
                <div className="srv-console-header">
                  <span className="srv-console-header-label">Console output</span>
                  <span className="srv-console-count">{result?.consoleLogs?.length || 0} entries</span>
                </div>
                <div className="srv-console-body">
                  {result?.consoleLogs?.length > 0 ? (
                    result.consoleLogs.map((l, i) => {
                      const colors = { error: "#f87171", warn: "#fbbf24", info: "#60a5fa", log: "#94a3b8" };
                      const c = colors[l.level] || "#94a3b8";
                      return (
                        <div key={i} className="srv-console-row">
                          <span className="srv-console-time">{new Date(l.time).toLocaleTimeString()}</span>
                          <span className="srv-console-level" style={{ color: c }}>{l.level?.toUpperCase()}</span>
                          <span style={{ color: l.level === "error" ? "#fca5a5" : "#94a3b8", wordBreak: "break-all" }}>{l.text}</span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="srv-console-empty">No console output captured.</div>
                  )}
                </div>
              </div>
            )}

            {/* 🧩 DOM */}
            {activeTab === "dom" && (
              result?.domSnapshot ? (
                <DomNode node={result.domSnapshot} />
              ) : (
                <div className="srv-dom-empty">
                  <div className="srv-dom-empty-icon">🧩</div>
                  No DOM snapshot available.
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DOM Tree Renderer ────────────────────────────────────────────────────────
function DomNode({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  if (!node) return null;

  if (node.type === "text") {
    return (
      <span style={{ color: "#94a3b8", fontSize: 11, fontFamily: "var(--font-mono)" }}>
        "{node.text}"
      </span>
    );
  }

  // Escape AI-supplied attribute keys/values before interpolation — otherwise
  // a malicious site under test could inject markup via dangerouslySetInnerHTML
  // below (e.g. an attribute value of `"><script>…</script>`).
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) =>
      ` <span style="color:#f59e0b">${escapeHtml(String(k))}</span>=` +
      `<span style="color:#34d399">"${escapeHtml(String(v))}"</span>`
    )
    .join("");

  const hasChildren = node.children?.length > 0;

  return (
    <div style={{
      background: "#0d1117",
      borderRadius: depth === 0 ? 10 : 0,
      border: depth === 0 ? "1px solid var(--border)" : "none",
      padding: depth === 0 ? "14px 16px" : 0,
      marginLeft: depth * 14,
      lineHeight: 1.8,
    }}>
      <span
        style={{ fontFamily: "var(--font-mono)", fontSize: 11, cursor: hasChildren ? "pointer" : "default", color: "#93c5fd" }}
        onClick={() => hasChildren && setOpen(o => !o)}
      >
        {hasChildren ? (open ? "▾ " : "▸ ") : "  "}
        <span style={{ color: "#60a5fa" }}>&lt;{node.tag}</span>
        <span dangerouslySetInnerHTML={{ __html: attrs }} />
        {!hasChildren && <span style={{ color: "#60a5fa" }}> /&gt;</span>}
        {hasChildren  && <span style={{ color: "#60a5fa" }}>&gt;</span>}
      </span>
      {hasChildren && open && (
        <div>
          {node.children.map((c, i) => <DomNode key={i} node={c} depth={depth + 1} />)}
        </div>
      )}
      {hasChildren && open && (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "#60a5fa", marginLeft: depth * 14 }}>
          &lt;/{node.tag}&gt;
        </span>
      )}
    </div>
  );
}

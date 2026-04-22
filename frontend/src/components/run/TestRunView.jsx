import React, { useEffect, useRef, useState, Suspense, lazy } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  ArrowRight,
  Lock,
  Play,
  ExternalLink,
} from "lucide-react";
import { api } from "../../api.js";
// StepResultsView is 55KB — lazy-loaded since it only renders when a user
// drills into a specific test result, never on initial run view render.
const StepResultsView = lazy(() => import("./StepResultsView"));
import LiveBrowserView from "./LiveBrowserView";
import ExecutionTimeline from "./ExecutionTimeline";
import OutcomeBanner from "./OutcomeBanner.jsx";
import { cleanTestName } from "../../utils/formatTestName.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (!ms && ms !== 0) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status) {
  if (status === "passed")  return "var(--green)";
  if (status === "failed")  return "var(--red)";
  if (status === "warning") return "var(--amber)";
  if (status === "running") return "var(--blue)";
  return "var(--text3)";
}

function StatusIcon({ status, size = 14 }) {
  if (status === "passed")  return <CheckCircle2 size={size} color="var(--green)" />;
  if (status === "failed")  return <XCircle size={size} color="var(--red)" />;
  if (status === "warning") return <AlertTriangle size={size} color="var(--amber)" />;
  if (status === "running") return <RefreshCw size={size} color="var(--blue)" style={{ animation: "spin 0.9s linear infinite" }} />;
  return <Clock size={size} color="var(--text3)" />;
}

function statusBadgeClass(status) {
  if (status === "passed")  return "badge-green";
  if (status === "failed")  return "badge-red";
  if (status === "warning") return "badge-amber";
  if (status === "running") return "badge-blue";
  return "badge-gray";
}

// ─── Test Case Row ────────────────────────────────────────────────────────────

function TestCaseRow({ result, caseIndex, isSelected, onSelect, onDrillDown }) {
  const steps = result.steps || [];

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "11px 14px",
          cursor: "pointer",
          borderBottom: "1px solid var(--border)",
          background: isSelected ? "var(--bg2)" : "transparent",
          borderLeft: `3px solid ${isSelected ? statusColor(result.status) : "transparent"}`,
          transition: "all 0.12s",
        }}
        onClick={() => onSelect(caseIndex)}
      >
        <StatusIcon status={result.status} size={13} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {result.testId ? (
              <Link
                to={`/tests/${result.testId}`}
                onClick={(e) => e.stopPropagation()}
                title="Open test detail"
                style={{ color: "inherit", textDecoration: "none" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "inherit"; }}
              >
                {cleanTestName(result.testName || result.name) || `Test Case ${caseIndex + 1}`}
              </Link>
            ) : (
              cleanTestName(result.testName || result.name) || `Test Case ${caseIndex + 1}`
            )}
          </div>
          {steps.length > 0 && (
            <div style={{ fontSize: "0.67rem", color: "var(--text3)", marginTop: 1 }}>
              {steps.length} step{steps.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span className={`badge ${statusBadgeClass(result.status)}`} style={{ fontSize: "0.62rem" }}>
            {result.status}
          </span>
          <span style={{ fontSize: "0.67rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
            {fmtMs(result.durationMs)}
          </span>
          <button
            title="View step details"
            onClick={(e) => { e.stopPropagation(); onDrillDown(caseIndex); }}
            style={{
              width: 22, height: 22, borderRadius: 5,
              border: "1px solid var(--border)", background: "var(--bg2)",
              cursor: "pointer", display: "flex", alignItems: "center",
              justifyContent: "center", color: "var(--text3)",
              transition: "all 0.12s", flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--accent-bg)";
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.borderColor = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--bg2)";
              e.currentTarget.style.color = "var(--text3)";
              e.currentTarget.style.borderColor = "var(--border)";
            }}
          >
            <ArrowRight size={11} />
          </button>
        </div>
      </div>


    </div>
  );
}

// ─── Right-side preview of selected test case ─────────────────────────────────

function SelectedCasePreview({ result, caseIndex, run, onDrillDown }) {
  const steps = result.steps || [];
  const url = result.url || result.sourceUrl || run?.targetUrl || "";
  const isApi = !!result.isApiTest;

  let domain = "";
  try {
    domain = url ? new URL(url.startsWith("http") ? url : `https://${url}`).hostname : "Browser";
  } catch { domain = url || "Browser"; }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: "0.88rem", marginBottom: 4, lineHeight: 1.4 }}>
              {cleanTestName(result.testName || result.name) || `Test Case ${caseIndex + 1}`}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className={`badge ${statusBadgeClass(result.status)}`}>{result.status}</span>
              {isApi && (
                <span className="badge badge-blue" style={{ fontSize: "0.62rem" }}>API</span>
              )}
              {result.durationMs && (
                <span style={{ fontSize: "0.72rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                  {fmtMs(result.durationMs)}
                </span>
              )}
              {steps.length > 0 && (
                <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>{steps.length} steps</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {isApi ? (
          /* ── API test result — no browser chrome ── */
          <div style={{
            borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)",
            boxShadow: "0 4px 20px rgba(0,0,0,0.08)", marginBottom: 14,
          }}>
            <div style={{
              padding: "10px 14px", background: "var(--bg2)",
              borderBottom: "1px solid var(--border)",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <span style={{ fontSize: 14 }}>🔌</span>
              <span style={{ fontWeight: 700, fontSize: "0.78rem", color: "var(--text)" }}>API Test</span>
              {url && (
                <span style={{
                  fontSize: "0.72rem", color: "var(--text3)",
                  fontFamily: "var(--font-mono)", marginLeft: "auto",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240,
                }}>
                  {url}
                </span>
              )}
            </div>
            <div style={{
              padding: "40px 20px", textAlign: "center",
              background: result.status === "passed" ? "var(--green-bg)" : result.status === "failed" ? "var(--red-bg)" : "var(--bg2)",
              cursor: "pointer",
            }} onClick={onDrillDown}>
              <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.6 }}>
                {result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "⏳"}
              </div>
              <div style={{
                fontWeight: 700, fontSize: "0.88rem", marginBottom: 4,
                color: result.status === "passed" ? "var(--green)" : result.status === "failed" ? "var(--red)" : "var(--text2)",
              }}>
                {result.status === "passed" ? "API Test Passed" : result.status === "failed" ? "API Test Failed" : "Pending"}
              </div>
              <div style={{ fontSize: "0.76rem", color: "var(--text3)" }}>
                No browser artifacts — this test uses Playwright's API request context.
              </div>
            </div>
          </div>
        ) : (
          /* ── Browser test — original browser chrome + screenshot ── */
          <div style={{
            borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)",
            boxShadow: "0 4px 20px rgba(0,0,0,0.08)", marginBottom: 14,
          }}>
            {/* Title bar */}
            <div style={{ background: "linear-gradient(180deg, #e8e8e8 0%, #d8d8d8 100%)", padding: "7px 12px 0", borderBottom: "1px solid #c0c0c0" }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 6, marginRight: 12 }}>
                  {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
                    <div key={c} style={{ width: 11, height: 11, borderRadius: "50%", background: c, border: "0.5px solid rgba(0,0,0,0.15)" }} />
                  ))}
                </div>
                <div style={{
                  background: "#fff", borderRadius: "6px 6px 0 0",
                  padding: "4px 14px 5px", fontSize: "0.7rem", color: "#333",
                  fontWeight: 500, maxWidth: 220, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                  borderTop: "1px solid #c0c0c0", borderLeft: "1px solid #c0c0c0",
                  borderRight: "1px solid #c0c0c0",
                  display: "flex", alignItems: "center", gap: 5,
                }}>
                  <span style={{ fontSize: 9 }}>🌐</span>{domain}
                </div>
              </div>
              {/* URL bar */}
              <div style={{ background: "#fff", padding: "3px 4px 6px", display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa" }}>‹</div>
                <div style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa" }}>›</div>
                <div style={{ flex: 1, height: 26, background: "#f5f5f5", borderRadius: 13, border: "1px solid #d0d0d0", display: "flex", alignItems: "center", gap: 6, padding: "0 12px" }}>
                  <Lock size={10} color="#888" />
                  <span style={{ fontSize: "0.72rem", color: "#444", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {url || "about:blank"}
                  </span>
                </div>
              </div>
            </div>

            {result.videoPath ? (
              <video
                key={result.videoPath}
                src={result.videoPath}
                controls
                autoPlay
                muted
                style={{ width: "100%", display: "block", background: "#000", cursor: "pointer" }}
                onClick={onDrillDown}
              />
            ) : result.screenshot ? (
              <img
                src={`data:image/png;base64,${result.screenshot}`}
                alt="Test screenshot"
                style={{ width: "100%", display: "block", cursor: "pointer" }}
                onClick={onDrillDown}
              />
            ) : (
              <div style={{ padding: "40px 20px", textAlign: "center", background: "#fafafa", color: "#94a3b8" }}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>📸</div>
                <div style={{ fontSize: "0.76rem" }}>No screenshot captured</div>
              </div>
            )}
          </div>
        )}

        {/* Error — MNT-007: role="alert" announces failures to screen readers */}
        {result.status === "failed" && result.error && (
          <div
            role="alert"
            style={{
              padding: "10px 14px", background: "var(--red-bg)", borderRadius: 8,
              border: "1px solid #fca5a5", fontSize: "0.76rem", color: "var(--red)",
              fontFamily: "var(--font-mono)", lineHeight: 1.6,
              whiteSpace: "pre-wrap", wordBreak: "break-word", marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Error
            </div>
            {result.error}
          </div>
        )}

      </div>
    </div>
  );
}

// ─── Live step preview while a test is running ───────────────────────────────

function RunningStepsPreview({ queuedTest }) {
  const steps = queuedTest?.steps || [];

  // Animate which step appears "active" — cycle through steps over time.
  // The backend does not emit per-step SSE events, so we use a client-side
  // timer to give visual progress feedback while a test is running.
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    if (steps.length === 0) return;
    const interval = setInterval(() => {
      setActiveStep((s) => Math.min(s + 1, steps.length - 1));
    }, 3000);
    return () => clearInterval(interval);
  }, [steps.length]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ fontWeight: 700, fontSize: "0.88rem", marginBottom: 4 }}>
          {cleanTestName(queuedTest?.name) || "Running…"}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--blue)", animation: "pulse 1.4s ease-in-out infinite" }} />
          <span className="badge badge-blue" style={{ fontSize: "0.62rem" }}>running</span>
          {steps.length > 0 && (
            <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>{steps.length} steps</span>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {/* Steps list with animated progress */}
        {steps.length > 0 ? (
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid var(--blue)", borderTopColor: "transparent", animation: "spin 0.9s linear infinite" }} />
              <span style={{ fontWeight: 700, fontSize: "0.78rem", color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Activity Log
              </span>
              <span style={{ marginLeft: "auto", fontSize: "0.68rem", color: "var(--text3)" }}>
                {activeStep + 1} of {steps.length}
              </span>
            </div>
            {steps.map((step, i) => {
              const isPast    = i < activeStep;
              const isCurrent = i === activeStep;
              const isFuture  = i > activeStep;
              return (
                <div
                  key={i}
                  style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "10px 14px",
                    borderBottom: i < steps.length - 1 ? "1px solid var(--border)" : "none",
                    background: isCurrent ? "var(--blue-bg, rgba(37,99,235,0.04))" : "transparent",
                    borderLeft: isCurrent ? "3px solid var(--blue)" : "3px solid transparent",
                    opacity: isFuture ? 0.4 : 1,
                    transition: "all 0.3s",
                  }}
                >
                  {/* Step indicator */}
                  <div style={{ flexShrink: 0, marginTop: 1 }}>
                    {isPast ? (
                      <div style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--green-bg)", border: "1.5px solid var(--green)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <CheckCircle2 size={10} color="var(--green)" />
                      </div>
                    ) : isCurrent ? (
                      <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--blue)", borderTopColor: "transparent", animation: "spin 0.9s linear infinite" }} />
                    ) : (
                      <div style={{ width: 18, height: 18, borderRadius: "50%", border: "1.5px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.6rem", fontWeight: 700, color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                        {i + 1}
                      </div>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "0.78rem", fontWeight: isCurrent ? 600 : 400, color: isCurrent ? "var(--text)" : "var(--text2)", lineHeight: 1.4 }}>
                      {step}
                    </div>
                    {isCurrent && (
                      <div style={{ fontSize: "0.67rem", color: "var(--blue)", marginTop: 3 }}>Running…</div>
                    )}
                    {isPast && (
                      <div style={{ fontSize: "0.67rem", color: "var(--green)", marginTop: 3 }}>Passed</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 40, color: "var(--text3)" }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--blue)", animation: "spin 0.9s linear infinite" }} />
            <div style={{ fontSize: "0.82rem" }}>Test running…</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TestRunView({ run, frames = [] }) {
  const navigate = useNavigate();
  const results = run?.results || run?.steps || [];
  const testQueue = run?.testQueue || [];

  const [selectedCase, setSelectedCase] = useState(0);
  const [drilledCase, setDrilledCase]   = useState(null); // null = suite overview
  const [rerunning, setRerunning]       = useState(false);

  const listRef = useRef(null);
  const isRunning = run?.status === "running";

  // Auto-select the latest result as it arrives; while pending select first queued
  useEffect(() => {
    if (results.length > 0) {
      setSelectedCase(results.length - 1);
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [results.length]);

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const total  = run?.total ?? results.length; // use backend total so count shows immediately
  const pending = Math.max(0, total - results.length); // tests not yet completed

  // ── Drill-in: show StepResultsView ────────────────────────────────────
  if (drilledCase !== null && results[drilledCase]) {
    return (
      <Suspense fallback={<div style={{ padding: 32, textAlign: "center", color: "var(--text3)", fontSize: "0.85rem" }}>Loading details…</div>}>
        <StepResultsView
          result={results[drilledCase]}
          run={run}
          onBack={() => setDrilledCase(null)}
        />
      </Suspense>
    );
  }

  // ── Suite overview ─────────────────────────────────────────────────────
  const panelStyle = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "var(--shadow-sm)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  };

  return (
    <div className="run-grid" style={{
      display: "grid",
      gridTemplateColumns: "minmax(260px, 320px) 1fr",
      gap: 16,
      minHeight: 560,
    }}>

      {/* LEFT: Test case list */}
      <div style={panelStyle}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
            <span style={{ fontWeight: 700, fontSize: "0.82rem" }}>Test Suite</span>
            <span style={{ fontSize: "0.68rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
              {total} test{total !== 1 ? "s" : ""}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 4, background: "var(--bg3)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: total > 0 ? `${(passed / total) * 100}%` : "0%",
                background: "var(--green)", borderRadius: 99, transition: "width 0.6s ease",
              }} />
            </div>
            <span style={{ fontSize: "0.68rem", color: "var(--green)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>{passed}✓</span>
            {failed > 0 && (
              <span style={{ fontSize: "0.68rem", color: "var(--red)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>{failed}✗</span>
            )}
          </div>
        </div>

        {/* MNT-007: Visually-hidden live region announces only the latest
            result to screen readers, avoiding the excessive noise that
            aria-live on the full scrolling list would cause. */}
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap" }}
        >
          {results.length > 0 && (() => {
            const latest = results[results.length - 1];
            const name = cleanTestName(latest.testName || latest.name) || `Test ${results.length}`;
            return `${name}: ${latest.status}. ${results.length} of ${total} completed.`;
          })()}
        </div>
        <div ref={listRef} style={{ overflowY: "auto", flex: 1 }}>
          {results.map((result, ci) => (
            <TestCaseRow
              key={ci}
              result={result}
              caseIndex={ci}
              isSelected={selectedCase === ci}
              onSelect={setSelectedCase}
              onDrillDown={(idx) => setDrilledCase(idx)}
            />
          ))}
          {/* Skeleton rows for tests not yet completed */}
          {isRunning && Array.from({ length: pending }).map((_, i) => {
            const queuedTest = testQueue[results.length + i];
            const isActiveRow = results.length + i === selectedCase || (results.length === 0 && i === 0);
            return (
              <div
                key={`pending-${i}`}
                onClick={() => setSelectedCase(results.length + i)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "11px 14px", borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  background: isActiveRow ? "var(--bg2)" : "transparent",
                  borderLeft: `3px solid ${isActiveRow ? "var(--blue)" : "transparent"}`,
                  transition: "all 0.12s",
                }}
              >
                <div style={{
                  width: 13, height: 13, borderRadius: "50%",
                  border: "2px solid var(--blue)", borderTopColor: "transparent",
                  animation: "spin 0.9s linear infinite", flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {queuedTest?.name ? (
                    <>
                      <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {cleanTestName(queuedTest.name)}
                      </div>
                      <div style={{ fontSize: "0.67rem", color: "var(--blue)", marginTop: 1 }}>Running…</div>
                    </>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <div className="skeleton" style={{ height: 10, borderRadius: 4, width: "65%" }} />
                      <div className="skeleton" style={{ height: 8, borderRadius: 4, width: "30%" }} />
                    </div>
                  )}
                </div>
                <span className="badge badge-blue" style={{ fontSize: "0.62rem" }}>running</span>
              </div>
            );
          })}
          {isRunning && (
            <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, color: "var(--text3)", fontSize: "0.75rem" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--blue)", animation: "pulse 1.4s ease-in-out infinite" }} />
              Running…
            </div>
          )}
          {!isRunning && results.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontSize: "0.82rem" }}>
              No test cases yet
            </div>
          )}
        </div>
      </div>

      {/* RIGHT: Selected test case preview */}
      <div style={panelStyle}>
        {results[selectedCase] ? (
          <SelectedCasePreview
            result={results[selectedCase]}
            caseIndex={selectedCase}
            run={run}
            onDrillDown={() => setDrilledCase(selectedCase)}
          />
        ) : isRunning ? (
          frames.length > 0
            ? <LiveBrowserView
                frames={frames}
                label={cleanTestName(testQueue[selectedCase]?.name)}
                fallback={<RunningStepsPreview queuedTest={testQueue[selectedCase]} />}
              />
            : <RunningStepsPreview queuedTest={testQueue[selectedCase]} />
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontSize: "0.82rem" }}>
            Select a test case to preview
          </div>
        )}
      </div>

      {/* Execution timeline — only shown once there are completed results */}
      {results.length > 0 && (
        <div style={{ gridColumn: "1 / -1" }}>
                  <ExecutionTimeline
                    results={results}
                    onSelect={(r) => {
                      const idx = results.findIndex(res => res.testId === r.testId);
                      if (idx >= 0) setSelectedCase(idx);
                    }}
                  />
                </div>
      )}

      {/* ── Post-run footer — next steps after completion ── */}
      {!isRunning && results.length > 0 && (
        <OutcomeBanner
          variant={failed > 0 ? "error" : "success"}
          title={failed > 0
            ? `${failed} test${failed !== 1 ? "s" : ""} failed — ${passed} of ${total} passed`
            : `All ${passed} test${passed !== 1 ? "s" : ""} passed`}
          subtitle={failed > 0
            ? "Review failing tests, fix the issues, then re-run to verify."
            : "Your regression suite is green. No action needed."}
          style={{ gridColumn: "1 / -1" }}
        >
          {failed > 0 && run?.projectId && (
            <button
              className="btn btn-sm"
              style={{
                background: "var(--surface)", color: "var(--text)",
                border: "1px solid var(--border)", fontWeight: 600, gap: 6,
              }}
              onClick={() => navigate(`/projects/${run.projectId}`)}
            >
              <ExternalLink size={12} /> Review Tests
            </button>
          )}
          {run?.projectId && (
            <button
              className="btn btn-sm"
              style={{
                background: failed > 0 ? "var(--red)" : "var(--green)",
                color: "#fff", border: "none", fontWeight: 700, gap: 6,
              }}
              disabled={rerunning}
              onClick={async () => {
                setRerunning(true);
                try {
                  const { runId } = await api.runTests(run.projectId);
                  navigate(`/runs/${runId}`);
                } catch (err) {
                  console.error("Re-run failed:", err);
                  setRerunning(false);
                }
              }}
            >
              {rerunning
                ? <><RefreshCw size={12} className="spin" /> Starting…</>
                : <><Play size={12} /> {failed > 0 ? "Re-run Tests" : "Run Again"}</>}
            </button>
          )}
        </OutcomeBanner>
      )}
    </div>
  );
}

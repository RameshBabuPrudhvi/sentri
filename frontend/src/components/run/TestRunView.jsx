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
import { useToast } from "../../context/ToastContext.jsx";
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
  if (status === "running") return <RefreshCw size={size} color="var(--blue)" className="spin" />;
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

function TestCaseRow({ result, caseIndex, isSelected, onSelect, onDrillDown, coverageDelta }) {
  // AUTO-009c — coverageDelta may be a number (legacy, lines only) OR an
  // object `{ lines, statements, branches, functions }`. The badge below
  // normalises both shapes so a v0 frontend on a v1 backend still works.
  const deltaShape = typeof coverageDelta === "object" && coverageDelta !== null
    ? coverageDelta
    : (typeof coverageDelta === "number" ? { lines: coverageDelta } : null);
  const steps = result.steps || [];

  // Data-driven border-left colour — the only legitimate inline style
  // (status-to-colour is continuous across 5 values; a class per status
  // would be cleaner but matches no other pattern in this codebase).
  const borderLeft = isSelected ? `3px solid ${statusColor(result.status)}` : undefined;

  return (
    <div>
      <div
        className={`trv-row${isSelected ? " trv-row--selected" : ""}`}
        style={borderLeft ? { borderLeftColor: statusColor(result.status), borderLeftWidth: 3, borderLeftStyle: "solid" } : undefined}
        onClick={() => onSelect(caseIndex)}
      >
        <StatusIcon status={result.status} size={13} />

        <div className="trv-row__body">
          <div className="trv-row__name">
            {result.testId ? (
              <Link
                to={`/tests/${result.testId}`}
                onClick={(e) => e.stopPropagation()}
                title="Open test detail"
                className="trv-row__name-link"
              >
                {cleanTestName(result.testName || result.name) || `Test Case ${caseIndex + 1}`}
              </Link>
            ) : (
              cleanTestName(result.testName || result.name) || `Test Case ${caseIndex + 1}`
            )}
          </div>
          {steps.length > 0 && (
            <div className="trv-row__steps">
              {steps.length} step{steps.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>

        <div className="trv-row__right">
          <span className={`badge ${statusBadgeClass(result.status)} trv-row__badge`}>
            {result.status}
          </span>
          {deltaShape && (deltaShape.lines > 0 || deltaShape.statements > 0 || deltaShape.branches > 0 || deltaShape.functions > 0) && (
            <span
              className="badge badge-blue badge-sm-inline"
              title={[
                deltaShape.lines      > 0 ? `${deltaShape.lines} new line${deltaShape.lines !== 1 ? "s" : ""}` : null,
                deltaShape.statements > 0 ? `${deltaShape.statements} new statement${deltaShape.statements !== 1 ? "s" : ""}` : null,
                deltaShape.branches   > 0 ? `${deltaShape.branches} new branch${deltaShape.branches !== 1 ? "es" : ""}` : null,
                deltaShape.functions  > 0 ? `${deltaShape.functions} new function${deltaShape.functions !== 1 ? "s" : ""}` : null,
              ].filter(Boolean).join(" · ")
                + " first exercised by this test in this run"}
            >
              {deltaShape.lines      > 0 && <span>+{deltaShape.lines}L</span>}
              {deltaShape.branches   > 0 && <span>·+{deltaShape.branches}B</span>}
              {deltaShape.functions  > 0 && <span>·+{deltaShape.functions}F</span>}
            </span>
          )}
          <span className="trv-row__duration">
            {fmtMs(result.durationMs)}
          </span>
          <button
            title="View step details"
            onClick={(e) => { e.stopPropagation(); onDrillDown(caseIndex); }}
            className="trv-row__drill"
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

  const apiStatusKey = result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : "pending";

  return (
    <div className="trv-preview">
      {/* Header */}
      <div className="trv-preview__header">
        <div className="trv-preview__header-inner">
          <div className="trv-preview__header-body">
            <div className="trv-preview__title">
              {cleanTestName(result.testName || result.name) || `Test Case ${caseIndex + 1}`}
            </div>
            <div className="trv-preview__meta">
              <span className={`badge ${statusBadgeClass(result.status)}`}>{result.status}</span>
              {isApi && <span className="badge badge-blue trv-row__badge">API</span>}
              {result.durationMs && <span className="trv-preview__meta-mono">{fmtMs(result.durationMs)}</span>}
              {steps.length > 0 && <span className="trv-preview__meta-text">{steps.length} steps</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="trv-preview__content">
        {isApi ? (
          /* ── API test result — no browser chrome ── */
          <div className="trv-api">
            <div className="trv-api__header">
              <span className="trv-api__header-icon">🔌</span>
              <span className="trv-api__header-title">API Test</span>
              {url && <span className="trv-api__header-url">{url}</span>}
            </div>
            <div className={`trv-api__body trv-api__body--${apiStatusKey}`} onClick={onDrillDown}>
              <div className="trv-api__status-icon">
                {result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "⏳"}
              </div>
              <div className={`trv-api__status-label trv-api__status-label--${apiStatusKey}`}>
                {result.status === "passed" ? "API Test Passed" : result.status === "failed" ? "API Test Failed" : "Pending"}
              </div>
              <div className="trv-api__status-sub">
                No browser artifacts — this test uses Playwright's API request context.
              </div>
            </div>
          </div>
        ) : (
          /* ── Browser test — browser chrome + screenshot ── */
          <div className="trv-chrome">
            {/* Title bar */}
            <div className="trv-chrome__titlebar">
              <div className="trv-chrome__top-row">
                <div className="trv-chrome__lights">
                  {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
                    <div key={c} className="trv-chrome__light" style={{ background: c }} />
                  ))}
                </div>
                <div className="trv-chrome__tab">
                  <span className="trv-chrome__tab-icon">🌐</span>{domain}
                </div>
              </div>
              {/* URL bar */}
              <div className="trv-chrome__urlbar">
                <div className="trv-chrome__nav-btn">‹</div>
                <div className="trv-chrome__nav-btn">›</div>
                <div className="trv-chrome__url-pill">
                  <Lock size={10} color="#888" />
                  <span className="trv-chrome__url-text">{url || "about:blank"}</span>
                </div>
              </div>
            </div>

            {result.videoPath ? (
              <video
                key={result.videoPath}
                src={result.videoPath}
                controls autoPlay muted
                className="trv-chrome__video"
                onClick={onDrillDown}
              />
            ) : result.screenshot ? (
              <img
                src={`data:image/png;base64,${result.screenshot}`}
                alt={`Screenshot of test "${cleanTestName(result.testName || result.name) || `case ${caseIndex + 1}`}" — ${result.status || "result pending"}`}
                className="trv-chrome__screenshot"
                onClick={onDrillDown}
              />
            ) : (
              <div className="trv-chrome__empty">
                <div className="trv-chrome__empty-icon">📸</div>
                <div className="trv-chrome__empty-text">No screenshot captured</div>
              </div>
            )}
          </div>
        )}

        {/* Error — MNT-007: role="alert" announces failures to screen readers */}
        {result.status === "failed" && result.error && (
          <div role="alert" className="trv-error">
            <div className="trv-error__title">Error</div>
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
    <div className="trv-running">
      {/* Header */}
      <div className="trv-running__header">
        <div className="trv-running__title">
          {cleanTestName(queuedTest?.name) || "Running…"}
        </div>
        <div className="trv-running__meta">
          <div className="trv-running__dot" />
          <span className="badge badge-blue trv-row__badge">running</span>
          {steps.length > 0 && <span className="trv-preview__meta-text">{steps.length} steps</span>}
        </div>
      </div>

      <div className="trv-running__content">
        {steps.length > 0 ? (
          <div className="trv-running__steps-card">
            <div className="trv-running__steps-header">
              <div className="trv-running__steps-spinner" />
              <span className="trv-running__steps-label">Activity Log</span>
              <span className="trv-running__steps-count">{activeStep + 1} of {steps.length}</span>
            </div>
            {steps.map((step, i) => {
              const isPast    = i < activeStep;
              const isCurrent = i === activeStep;
              const isFuture  = i > activeStep;
              const stepMod = isCurrent ? " trv-running__step--current" : isFuture ? " trv-running__step--future" : "";
              return (
                <div key={i} className={`trv-running__step${stepMod}`}>
                  <div className="trv-running__step-indicator">
                    {isPast ? (
                      <div className="trv-running__step-circle trv-running__step-circle--passed">
                        <CheckCircle2 size={10} color="var(--green)" />
                      </div>
                    ) : isCurrent ? (
                      <div className="trv-running__step-circle trv-running__step-circle--current" />
                    ) : (
                      <div className="trv-running__step-circle trv-running__step-circle--pending">
                        {i + 1}
                      </div>
                    )}
                  </div>
                  <div className="trv-running__step-body">
                    <div className={`trv-running__step-text${isCurrent ? " trv-running__step-text--current" : ""}`}>
                      {step}
                    </div>
                    {isCurrent && <div className="trv-running__step-status trv-running__step-status--running">Running…</div>}
                    {isPast && <div className="trv-running__step-status trv-running__step-status--passed">Passed</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="trv-running__no-steps">
            <div className="trv-running__no-steps-spinner" />
            <div className="trv-running__no-steps-text">Test running…</div>
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
  const { showToast } = useToast();

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
      <Suspense fallback={<div className="trv-suspense-fallback">Loading details…</div>}>
        <StepResultsView
          result={results[drilledCase]}
          run={run}
          onBack={() => setDrilledCase(null)}
        />
      </Suspense>
    );
  }

  return (
    <div className="run-grid trv-grid">

      {/* LEFT: Test case list */}
      <div className="trv-panel">
        <div className="trv-suite-header">
          <div className="trv-suite-header__top">
            <span className="trv-suite-header__title">Test Suite</span>
            <span className="trv-suite-header__count">
              {total} test{total !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="trv-suite-header__bar-row">
            <div className="trv-suite-header__bar-track">
              <div
                className="trv-suite-header__bar-fill"
                style={{ width: total > 0 ? `${(passed / total) * 100}%` : "0%" }}
              />
            </div>
            <span className="trv-suite-header__passed">{passed}✓</span>
            {failed > 0 && (
              <span className="trv-suite-header__failed">{failed}✗</span>
            )}
          </div>
        </div>

        {/* MNT-007: Visually-hidden live region announces only the latest
            result to screen readers, avoiding the excessive noise that
            aria-live on the full scrolling list would cause. */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {results.length > 0 && (() => {
            const latest = results[results.length - 1];
            const name = cleanTestName(latest.testName || latest.name) || `Test ${results.length}`;
            return `${name}: ${latest.status}. ${results.length} of ${total} completed.`;
          })()}
        </div>
        <div ref={listRef} className="trv-list">
          {results.map((result, ci) => {
            // AUTO-009 — look up this test's per-test coverage delta from
            // the run's aggregated coverageSummary. AUTO-009c extends this
            // from a scalar (deltaLines) to an object so the badge can
            // render `+47L · +12B · +3F`. Older runs without granularity
            // surface only the `lines` field; everything else stays 0.
            const perTest = run?.coverageSummary?.perTest;
            const row = Array.isArray(perTest)
              ? perTest.find((p) => p.testId === result.testId)
              : null;
            const delta = row
              ? {
                  lines:      row.deltaLines      || 0,
                  statements: row.deltaStatements || 0,
                  branches:   row.deltaBranches   || 0,
                  functions:  row.deltaFunctions  || 0,
                }
              : null;
            return (
              <TestCaseRow
                key={ci}
                result={result}
                caseIndex={ci}
                isSelected={selectedCase === ci}
                onSelect={setSelectedCase}
                onDrillDown={(idx) => setDrilledCase(idx)}
                coverageDelta={delta}
              />
            );
          })}
          {/* Skeleton rows for tests not yet completed */}
          {isRunning && Array.from({ length: pending }).map((_, i) => {
            const queuedTest = testQueue[results.length + i];
            const isActiveRow = results.length + i === selectedCase || (results.length === 0 && i === 0);
            return (
              <div
                key={`pending-${i}`}
                onClick={() => setSelectedCase(results.length + i)}
                className={`trv-pending-row${isActiveRow ? " trv-pending-row--active" : ""}`}
              >
                <div className="trv-pending-spinner" />
                <div className="trv-pending-body">
                  {queuedTest?.name ? (
                    <>
                      <div className="trv-pending-name">{cleanTestName(queuedTest.name)}</div>
                      <div className="trv-pending-sub">Running…</div>
                    </>
                  ) : (
                    <div className="trv-pending-skeleton">
                      <div className="skeleton" style={{ height: 10, borderRadius: 4, width: "65%" }} />
                      <div className="skeleton" style={{ height: 8, borderRadius: 4, width: "30%" }} />
                    </div>
                  )}
                </div>
                <span className="badge badge-blue trv-row__badge">running</span>
              </div>
            );
          })}
          {isRunning && (
            <div className="trv-running-indicator">
              <span className="trv-running-dot" />
              Running…
            </div>
          )}
          {!isRunning && results.length === 0 && (
            <div className="trv-empty-list">No test cases yet</div>
          )}
        </div>
      </div>

      {/* RIGHT: Selected test case preview */}
      <div className="trv-panel">
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
          <div className="trv-preview__empty">
            Select a test case to preview
          </div>
        )}
      </div>

      {/* Execution timeline — only shown once there are completed results */}
      {results.length > 0 && (
        <div className="trv-timeline-wrap">
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
              className="btn btn-sm trv-footer-review"
              onClick={() => navigate(`/projects/${run.projectId}`)}
            >
              <ExternalLink size={12} /> Review Tests
            </button>
          )}
          {run?.projectId && (
            <button
              className={`btn btn-sm ${failed > 0 ? "trv-footer-rerun--fail" : "trv-footer-rerun--pass"}`}
              disabled={rerunning}
              onClick={async () => {
                setRerunning(true);
                try {
                  const { runId } = await api.runTests(run.projectId);
                  showToast("Re-run started", "success");
                  navigate(`/runs/${runId}`);
                } catch (err) {
                  console.error("Re-run failed:", err);
                  showToast(err.message || "Re-run failed.", "error");
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

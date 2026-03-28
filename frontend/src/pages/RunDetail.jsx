import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Clock, Copy, ExternalLink } from "lucide-react";
import { api } from "../api.js";

function StepDot({ status }) {
  if (status === "passed")  return <div className="step-dot step-dot-pass"><CheckCircle2 size={10} /></div>;
  if (status === "failed")  return <div className="step-dot step-dot-fail"><XCircle size={10} /></div>;
  if (status === "running") return <div className="step-dot step-dot-run"><RefreshCw size={8} className="spin" /></div>;
  return <div className="step-dot step-dot-wait">○</div>;
}

function AgentTag({ type = "TA" }) {
  const s = { QA: "avatar-qa", TA: "avatar-ta", EX: "avatar-ex" };
  return <div className={`avatar ${s[type]}`}>{type}</div>;
}

function colorLog(line) {
  if (/✅|PASSED|Done|complete|Generating|Generated/i.test(line)) return "log-ok";
  if (/❌|FAILED|failed|Error/i.test(line)) return "log-error";
  if (/⚠️|WARNING|warn/i.test(line)) return "log-warn";
  if (/🤖|🕷️|🧠|🗺️|🚫|✨|📊/u.test(line)) return "log-info";
  return "";
}

// Parse log lines into structured steps
function parseLogs(logs = []) {
  return logs.map((line, i) => {
    const time = line.match(/\[([^\]]+)\]/)?.[1];
    const msg = line.replace(/^\[[^\]]+\]\s*/, "");
    let status = "done";
    if (/⚠️|FAILED|Error/i.test(line)) status = "failed";
    else if (/✅|Done|complete/i.test(line)) status = "passed";
    else if (/🤖|🕷️|Visiting|Generating/i.test(line)) status = "running";
    return { id: i, time, msg, status, raw: line };
  });
}

export default function RunDetail() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeStep, setActiveStep] = useState(null);
  const logRef = useRef(null);
  const pollRef = useRef(null);

  const fetchRun = useCallback(async () => {
    const r = await api.getRun(runId).catch(() => null);
    if (r) setRun(r);
    return r;
  }, [runId]);

  useEffect(() => {
    fetchRun().finally(() => setLoading(false));
  }, [fetchRun]);

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

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.logs?.length]);

  if (loading) return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div className="skeleton" style={{ height: 100, borderRadius: 12, marginBottom: 16 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="skeleton" style={{ height: 480, borderRadius: 12 }} />
        <div className="skeleton" style={{ height: 480, borderRadius: 12 }} />
      </div>
    </div>
  );
  if (!run) return <div>Run not found</div>;

  const isRunning = run.status === "running";
  const isCrawl = run.type === "crawl";
  const steps = parseLogs(run.logs);
  const passRate = run.total ? Math.round((run.passed / run.total) * 100) : null;
  const activeResult = activeStep !== null ? run.results?.[activeStep] : null;

  return (
    <div className="fade-in" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Back + breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, fontSize: "0.82rem", color: "var(--text3)" }}>
        <button onClick={() => navigate(-1)} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, color: "var(--text2)", fontWeight: 500 }}>
          <ArrowLeft size={14} /> Work
        </button>
        <span>›</span>
        <span>Task Details</span>
      </div>

      {/* Task header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <h1 style={{ fontWeight: 700, fontSize: "1.3rem" }}>
            Task #{runId.slice(0, 6).toUpperCase()}: {isCrawl ? "Crawl & Generate" : "Test Run"}
          </h1>
          {run.status === "completed" && <span className="badge badge-green"><CheckCircle2 size={10} /> Passed</span>}
          {run.status === "running"   && <span className="badge badge-blue pulse">● Running</span>}
          {run.status === "failed"    && <span className="badge badge-red"><XCircle size={10} /> Failed</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, color: "var(--text3)", fontSize: "0.78rem" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span className="mono">#{runId.slice(0, 8)}</span></span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><AgentTag type="TA" /> Sentri Agent</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Clock size={12} /> {new Date(run.startedAt).toLocaleString()}</span>
          {run.finishedAt && (
            <span>
              {Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000)}s
            </span>
          )}
          {!isCrawl && run.total > 0 && (
            <span>{run.passed ?? 0} passed · {run.failed ?? 0} failed · {run.total} total</span>
          )}
          {isCrawl && <span>{run.pagesFound ?? 0} pages found · {run.testsGenerated ?? 0} tests generated</span>}
        </div>
      </div>

      {/* Progress bar for test runs */}
      {!isCrawl && run.total > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "var(--text2)", marginBottom: 6 }}>
            <span>{(run.passed || 0) + (run.failed || 0)} / {run.total} tests executed</span>
            {passRate !== null && <span style={{ fontWeight: 600, color: passRate >= 80 ? "var(--green)" : passRate >= 50 ? "var(--amber)" : "var(--red)" }}>{passRate}% pass rate</span>}
          </div>
          <div className="progress-bar progress-bar-green">
            <div className="progress-bar-fill" style={{ width: `${Math.round(((run.passed || 0) + (run.failed || 0)) / run.total * 100)}%` }} />
          </div>
        </div>
      )}

      {/* Main split layout: Activity Log | Browser View */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* LEFT: Activity Log */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 20, height: 20, borderRadius: 5, background: "var(--bg2)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 10 }}>≡</span>
              </div>
              <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>Activity Log</span>
            </div>
            <span style={{ fontSize: "0.75rem", color: "var(--text3)" }}>{steps.length} of {steps.length} items</span>
          </div>

          <div style={{ padding: 16, maxHeight: 520, overflowY: "auto" }} ref={logRef}>
            {/* Summary message at top */}
            {run.logs?.length > 0 && (
              <div style={{ padding: "12px 14px", background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--border)", marginBottom: 16, fontSize: "0.82rem", color: "var(--text2)", lineHeight: 1.6 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <AgentTag type="TA" />
                  <div>
                    <span style={{ fontWeight: 500, color: "var(--text)" }}>
                      {isCrawl ? `Crawl run for this project — ` : `Test execution — `}
                    </span>
                    {isCrawl
                      ? `Crawling up to 20 pages, filtering elements, classifying intents, and generating tests with AI.`
                      : `Running ${run.total} tests against the application, recording pass/fail results.`}
                    <div style={{ marginTop: 4, fontSize: "0.73rem", color: "var(--text3)" }}>
                      {new Date(run.startedAt).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Step-by-step log items */}
            {run.results?.length > 0 ? (
              // Test results as steps
              run.results.map((r, i) => (
                <div key={i} className="step-item" style={{ cursor: "pointer", background: activeStep === i ? "var(--bg2)" : "transparent", borderRadius: 8, margin: "0 -8px", padding: "10px 8px" }}
                  onClick={() => setActiveStep(activeStep === i ? null : i)}>
                  <StepDot status={r.status} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "0.82rem", fontWeight: 500, color: "var(--text)" }}>
                      Step {i + 1} <span className={`badge badge-${r.status === "passed" ? "green" : "red"}`} style={{ marginLeft: 6, fontSize: "0.68rem" }}>{r.status === "passed" ? "Passed" : "Failed"}</span>
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "var(--text2)", marginTop: 2 }} className="truncate">{r.testName}</div>
                    {r.error && activeStep === i && (
                      <div style={{ marginTop: 6, fontSize: "0.75rem", color: "var(--red)", fontFamily: "var(--font-mono)", background: "var(--red-bg)", padding: "6px 8px", borderRadius: 6 }}>
                        {r.error}
                      </div>
                    )}
                    <div style={{ fontSize: "0.7rem", color: "var(--text3)", marginTop: 3 }}>
                      {r.durationMs ? `${r.durationMs}ms` : ""}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              // Raw log lines
              <div>
                {steps.map((s, i) => (
                  <div key={i} className="step-item" style={{ cursor: "pointer", borderRadius: 8, margin: "0 -8px", padding: "8px 8px", background: activeStep === i ? "var(--bg2)" : "transparent" }}
                    onClick={() => setActiveStep(activeStep === i ? null : i)}>
                    <StepDot status={s.status} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "0.82rem", color: "var(--text)", lineHeight: 1.5 }}>{s.msg}</div>
                      {s.time && <div style={{ fontSize: "0.7rem", color: "var(--text3)", marginTop: 2 }}>{new Date(s.time).toLocaleTimeString()}</div>}
                    </div>
                  </div>
                ))}
                {isRunning && (
                  <div className="step-item">
                    <div className="step-dot step-dot-run"><RefreshCw size={8} className="spin" /></div>
                    <div style={{ fontSize: "0.82rem", color: "var(--text3)" }}>Running…</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Browser View / Details */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 20, height: 20, borderRadius: 5, background: "var(--bg2)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: 10 }}>⊡</span>
              </div>
              <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                {activeResult?.screenshot ? "Browser View" : isCrawl ? "Pipeline Report" : "Test Results"}
              </span>
            </div>
            {activeResult?.screenshot && (
              <button className="btn btn-ghost btn-xs"><ExternalLink size={12} /> Open</button>
            )}
          </div>

          <div style={{ padding: 16, maxHeight: 520, overflowY: "auto" }}>
            {/* Screenshot if available */}
            {activeResult?.screenshot ? (
              <div>
                <div style={{ marginBottom: 12, padding: "8px 12px", background: "var(--bg2)", borderRadius: 8, border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: "0.78rem", color: "var(--text2)", marginBottom: 4 }}>
                    <strong>{activeResult.testName}</strong>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.73rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#ef4444" }} />
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b" }} />
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e" }} />
                    <span style={{ marginLeft: 8 }}>screenshot</span>
                  </div>
                </div>
                <img src={`data:image/png;base64,${activeResult.screenshot}`} alt="Test screenshot" style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />
              </div>
            ) : isCrawl && run.pipelineStats ? (
              /* Pipeline report */
              <div>
                <div style={{ marginBottom: 16, fontSize: "0.82rem", color: "var(--text2)", lineHeight: 1.7 }}>
                  Sentri crawled your application, filtered elements, classified intents, detected user journeys, and generated high-quality tests.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { label: "Pages Found",           val: run.pipelineStats.pagesFound,           color: "var(--accent)"  },
                    { label: "Raw Tests Generated",   val: run.pipelineStats.rawTestsGenerated,    color: "var(--text)"    },
                    { label: "Duplicates Removed",    val: run.pipelineStats.duplicatesRemoved,    color: "var(--amber)"   },
                    { label: "Journeys Detected",     val: run.pipelineStats.journeysDetected,     color: "var(--purple)"  },
                    { label: "Assertions Enhanced",   val: run.pipelineStats.assertionsEnhanced,   color: "var(--green)"   },
                    { label: "Avg Quality Score",     val: run.pipelineStats.averageQuality != null ? `${run.pipelineStats.averageQuality}/100` : "—", color: (run.pipelineStats.averageQuality || 0) >= 60 ? "var(--green)" : "var(--amber)" },
                  ].map((s, i) => (
                    <div key={i} style={{ padding: "14px 16px", background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--border)" }}>
                      <div style={{ fontSize: "1.4rem", fontWeight: 700, color: s.color }}>{s.val ?? "—"}</div>
                      <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 3 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                {run.tests?.length > 0 && (
                  <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--green-bg)", border: "1px solid #bbf7d0", borderRadius: 8, fontSize: "0.82rem", color: "var(--green)", fontWeight: 500 }}>
                    ✓ {run.tests.length} tests ready to run
                  </div>
                )}
              </div>
            ) : run.results?.length > 0 && activeStep !== null && activeResult ? (
              /* Selected test result detail */
              <div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 4 }}>{activeResult.testName}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span className={`badge badge-${activeResult.status === "passed" ? "green" : "red"}`}>{activeResult.status}</span>
                    <span className="badge badge-gray">{activeResult.durationMs}ms</span>
                  </div>
                </div>
                {activeResult.error && (
                  <div style={{ padding: "10px 12px", background: "var(--red-bg)", border: "1px solid #fca5a5", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--red)", marginBottom: 12, lineHeight: 1.6 }}>
                    {activeResult.error}
                  </div>
                )}
                <div style={{ fontSize: "0.78rem", color: "var(--text3)" }}>Click a different step in the Activity Log to inspect it.</div>
              </div>
            ) : (
              /* Default: summary */
              <div>
                <div style={{ fontSize: "0.875rem", color: "var(--text2)", lineHeight: 1.7, marginBottom: 16 }}>
                  {isRunning
                    ? "Tests are executing. Results will appear here as they complete."
                    : run.results?.length > 0
                    ? "Click any step in the Activity Log to view its details and screenshot."
                    : run.status === "completed"
                    ? "Run completed successfully."
                    : "Waiting for results…"}
                </div>
                {run.results?.length > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                    {[
                      { label: "Passed", val: run.passed, color: "var(--green)", bg: "var(--green-bg)" },
                      { label: "Failed", val: run.failed, color: "var(--red)",   bg: "var(--red-bg)"   },
                      { label: "Total",  val: run.total,  color: "var(--text)",  bg: "var(--bg2)"      },
                    ].map((s, i) => (
                      <div key={i} style={{ padding: "16px", background: s.bg, borderRadius: 10, textAlign: "center", border: "1px solid var(--border)" }}>
                        <div style={{ fontSize: "1.8rem", fontWeight: 700, color: s.color }}>{s.val ?? 0}</div>
                        <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 3 }}>{s.label}</div>
                      </div>
                    ))}
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

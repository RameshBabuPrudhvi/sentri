import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, CheckCircle2, XCircle, RefreshCw, Clock,
  ExternalLink, Play, Pause, Download, Maximize2, Zap,
} from "lucide-react";
import { api } from "../api.js";

// ─── Small helpers ────────────────────────────────────────────────────────────
function AgentTag({ type = "TA" }) {
  const s = { QA: "avatar-qa", TA: "avatar-ta", EX: "avatar-ex" };
  return <div className={`avatar ${s[type] || "avatar-ta"}`}>{type}</div>;
}

function fmtMs(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtBytes(b) {
  if (!b && b !== 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusDot({ status }) {
  const colors = { passed: "#16a34a", failed: "#dc2626", warning: "#d97706", running: "#2563eb" };
  const bg = colors[status] || "#9ca3af";
  if (status === "running")
    return <div style={{ width: 8, height: 8, borderRadius: "50%", background: bg, animation: "spin 1s linear infinite" }} />;
  return <div style={{ width: 8, height: 8, borderRadius: "50%", background: bg, boxShadow: `0 0 6px ${bg}55` }} />;
}

// ─── DOM Renderer ─────────────────────────────────────────────────────────────
function DomNode({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  if (!node) return null;
  if (node.type === "text") {
    return <span style={{ color: "#94a3b8", fontSize: 11, fontFamily: "var(--font-mono)" }}>"{node.text}"</span>;
  }
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => ` <span style="color:#f59e0b">${k}</span>=<span style="color:#34d399">"${v}"</span>`)
    .join("");
  const hasChildren = node.children?.length > 0;
  return (
    <div style={{ marginLeft: depth * 14, lineHeight: 1.8 }}>
      <span
        style={{ fontFamily: "var(--font-mono)", fontSize: 11, cursor: hasChildren ? "pointer" : "default", color: "#93c5fd" }}
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

// ─── Main Component ───────────────────────────────────────────────────────────
export default function RunDetail() {
  const { runId } = useParams();
  const navigate  = useNavigate();

  const [run, setRun]             = useState(null);
  const [loading, setLoading]     = useState(true);
  const [activeStep, setActiveStep] = useState(0);
  const [activeTab, setActiveTab] = useState("video");

  const videoRef    = useRef(null);
  const pollRef     = useRef(null);

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

  if (loading) return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 16px" }}>
      <div className="skeleton" style={{ height: 90, borderRadius: 12, marginBottom: 16 }} />
      <div className="skeleton" style={{ height: 60, borderRadius: 8, marginBottom: 16 }} />
      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16, height: 600 }}>
        <div className="skeleton" style={{ borderRadius: 12 }} />
        <div className="skeleton" style={{ borderRadius: 12 }} />
      </div>
    </div>
  );

  if (!run) return <div style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}>Run not found</div>;

  const isRunning  = run.status === "running";
  const isCrawl    = run.type === "crawl";
  const results    = run.results || [];
  const passRate   = run.total ? Math.round((run.passed / run.total) * 100) : null;
  const activeResult = results[activeStep] || null;

  const BASE_URL   = window.location.origin.replace(":3000", ":3001");
  // Per-test video segments (new) or single run video (legacy fallback)
  const videoSegments = run.videoSegments || (run.videoPath ? [run.videoPath] : []);
  const activeResultVideoPath = results[activeStep]?.videoPath || videoSegments[activeStep] || videoSegments[0] || null;
  const videoUrl   = activeResultVideoPath ? `${BASE_URL}${activeResultVideoPath}` : null;
  const traceUrl   = run.tracePath ? `${BASE_URL}${run.tracePath}` : null;

  // Cells
  const tabs = [
    { id: "video",      label: "🎥 Video" },
    { id: "screenshot", label: "📸 Screenshot" },
    { id: "trace",      label: "📊 Trace" },
    { id: "network",    label: "🌐 Network" },
    { id: "console",    label: "📜 Console" },
    { id: "dom",        label: "🧩 DOM" },
  ];

  // ── Styles (inline, no extra CSS needed) ─────────────────────────────────
  const panel = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "var(--shadow-sm)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 16px 40px" }}>

      {/* ── Breadcrumb ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, fontSize: "0.82rem", color: "var(--text3)" }}>
        <button onClick={() => navigate(-1)} style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 5, color: "var(--text2)", fontWeight: 500 }}>
          <ArrowLeft size={14} /> Work
        </button>
        <span>›</span>
        <span>Task Details</span>
      </div>

      {/* ── Task header ── */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <h1 style={{ fontWeight: 700, fontSize: "1.3rem" }}>
            Task #{runId.slice(0, 6).toUpperCase()}: {isCrawl ? "Crawl & Generate" : "Test Run"}
          </h1>
          {run.status === "completed" && <span className="badge badge-green"><CheckCircle2 size={10} /> Passed</span>}
          {run.status === "running"   && <span className="badge badge-blue">● Running</span>}
          {run.status === "failed"    && <span className="badge badge-red"><XCircle size={10} /> Failed</span>}
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
        <div style={{ display: "flex", alignItems: "center", gap: 16, color: "var(--text3)", fontSize: "0.78rem", flexWrap: "wrap" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span className="mono">#{runId.slice(0, 8)}</span></span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><AgentTag type="TA" /> Sentri Agent</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Clock size={12} /> {new Date(run.startedAt).toLocaleString()}</span>
          {run.duration && <span>⏱ {fmtMs(run.duration)}</span>}
          {!isCrawl && run.total > 0 && (
            <span>{run.passed ?? 0} passed · {run.failed ?? 0} failed · {run.total} total</span>
          )}
        </div>
      </div>

      {/* ── Pass rate bar ── */}
      {!isCrawl && run.total > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "var(--text2)", marginBottom: 6 }}>
            <span>{(run.passed || 0) + (run.failed || 0)} / {run.total} tests executed</span>
            {passRate !== null && (
              <span style={{ fontWeight: 600, color: passRate >= 80 ? "var(--green)" : passRate >= 50 ? "var(--amber)" : "var(--red)" }}>
                {passRate}% pass rate
              </span>
            )}
          </div>
          <div className="progress-bar progress-bar-green">
            <div className="progress-bar-fill" style={{ width: `${passRate || 0}%`, transition: "width 0.8s ease" }} />
          </div>
        </div>
      )}



      {/* ── Main split view ── */}
      {!isCrawl && (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 16, minHeight: 560 }}>

          {/* LEFT: Step list */}
          <div style={{ ...panel }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>Activity Log</span>
              <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>{results.length} steps</span>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {results.length === 0 && (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontSize: "0.82rem" }}>
                  {isRunning ? "Running…" : "No results yet"}
                </div>
              )}
              {results.map((r, i) => (
                <div
                  key={i}
                  onClick={() => setActiveStep(i)}
                  style={{
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--border)",
                    cursor: "pointer",
                    background: activeStep === i ? "var(--bg2)" : "transparent",
                    borderLeft: activeStep === i
                      ? `3px solid ${r.status === "passed" ? "var(--green)" : "var(--red)"}`
                      : "3px solid transparent",
                    transition: "all 0.12s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <StatusDot status={r.status} />
                    <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text)", flex: 1 }}>
                      Step {i + 1}
                    </span>
                    <span className={`badge badge-${r.status === "passed" ? "green" : r.status === "warning" ? "amber" : "red"}`} style={{ fontSize: "0.65rem" }}>
                      {r.status}
                    </span>
                    <span style={{ fontSize: "0.7rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                      {fmtMs(r.durationMs)}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text2)", lineHeight: 1.4, paddingLeft: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.testName}
                  </div>
                  {r.error && activeStep === i && (
                    <div style={{ marginTop: 6, padding: "6px 8px", background: "var(--red-bg)", borderRadius: 6, fontSize: "0.72rem", color: "var(--red)", fontFamily: "var(--font-mono)", lineHeight: 1.5 }}>
                      {r.error}
                    </div>
                  )}
                </div>
              ))}
              {isRunning && (
                <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 8, color: "var(--text3)", fontSize: "0.78rem" }}>
                  <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> Running…
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: Debug viewer */}
          <div style={{ ...panel }}>
            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 16px", flexShrink: 0, overflowX: "auto" }}>
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  style={{
                    padding: "11px 14px",
                    fontSize: "0.78rem",
                    fontWeight: 500,
                    color: activeTab === t.id ? "var(--accent)" : "var(--text3)",
                    background: "none",
                    border: "none",
                    borderBottom: `2px solid ${activeTab === t.id ? "var(--accent)" : "transparent"}`,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-sans)",
                    transition: "all 0.12s",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>

              {/* 🎥 VIDEO */}
              {activeTab === "video" && (
                <div>
                  {videoUrl ? (
                    <div>
                      <div style={{ background: "#000", borderRadius: 10, overflow: "hidden", marginBottom: 10, border: "1px solid var(--border)" }}>
                        <video
                          key={videoUrl}
                          ref={videoRef}
                          width="100%"
                          controls
                          autoPlay={false}
                          style={{ display: "block", maxHeight: 400 }}
                        >
                          <source src={videoUrl} type="video/webm" />
                          Your browser does not support WebM video.
                        </video>
                      </div>
                      {videoSegments.length > 1 && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          <span style={{ fontSize: "0.72rem", color: "var(--text3)", alignSelf: "center" }}>Test video:</span>
                          {results.map((r, i) => (
                            <button
                              key={i}
                              onClick={() => {
                                setActiveStep(i);
                              }}
                              style={{
                                padding: "3px 10px",
                                borderRadius: 100,
                                fontSize: "0.72rem",
                                fontFamily: "var(--font-mono)",
                                cursor: "pointer",
                                border: `1px solid ${i === activeStep ? "var(--accent)" : "var(--border)"}`,
                                background: i === activeStep ? "var(--accent-bg)" : "transparent",
                                color: i === activeStep ? "var(--accent)" : "var(--text3)",
                                transition: "all 0.12s",
                              }}
                            >
                              S{i + 1} {r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "⚠️"}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ background: "var(--bg2)", borderRadius: 10, padding: 40, textAlign: "center", border: "2px dashed var(--border)" }}>
                      <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>▶</div>
                      <div style={{ fontWeight: 600, color: "var(--text2)", marginBottom: 8 }}>Video not yet available</div>
                      <div style={{ fontSize: "0.78rem", color: "var(--text3)", lineHeight: 1.6, maxWidth: 360, margin: "0 auto" }}>
                        Video is recorded when tests complete.<br />
                        {isRunning ? "Tests are still running…" : "Check that Playwright's recordVideo is enabled in testRunner.js."}
                      </div>
                      <div style={{ marginTop: 16, padding: "10px 14px", background: "var(--bg3)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text2)", textAlign: "left", display: "inline-block" }}>
                        recordVideo: {"{"} dir: videoDir, size: {"{"} width: 1280, height: 720 {"}"} {"}"}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 📸 SCREENSHOT */}
              {activeTab === "screenshot" && (
                <div>
                  {activeResult?.screenshotPath ? (
                    <div>
                      <div style={{ marginBottom: 10, padding: "8px 12px", background: "var(--bg2)", borderRadius: 8, border: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ display: "flex", gap: 5 }}>
                          {["#ef4444","#f59e0b","#22c55e"].map((c) => (
                            <div key={c} style={{ width: 10, height: 10, borderRadius: "50%", background: c }} />
                          ))}
                        </div>
                        <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--text3)" }}>
                          Step {activeStep + 1} · {fmtMs(activeResult.durationMs)}
                        </span>
                        <a
                          href={`${BASE_URL}${activeResult.screenshotPath}`}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-ghost btn-xs"
                          style={{ marginLeft: "auto" }}
                        >
                          <ExternalLink size={10} /> Open
                        </a>
                      </div>
                      <img
                        src={`data:image/png;base64,${activeResult.screenshot}`}
                        alt={`Step ${activeStep + 1} screenshot`}
                        style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }}
                      />
                    </div>
                  ) : activeResult?.screenshot ? (
                    <div>
                      <div style={{ marginBottom: 10, padding: "8px 12px", background: "var(--bg2)", borderRadius: 8, border: "1px solid var(--border)" }}>
                        <span style={{ fontSize: "0.72rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                          Step {activeStep + 1} screenshot
                        </span>
                      </div>
                      <img
                        src={`data:image/png;base64,${activeResult.screenshot}`}
                        alt={`Step ${activeStep + 1} screenshot`}
                        style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }}
                      />
                    </div>
                  ) : (
                    <div style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}>
                      <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.3 }}>📸</div>
                      No screenshot for this step.
                    </div>
                  )}
                </div>
              )}

              {/* 📊 TRACE */}
              {activeTab === "trace" && (
                <div>
                  <div style={{ padding: "16px", background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--border)", marginBottom: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Playwright Trace Report</div>
                    <div style={{ fontSize: "0.82rem", color: "var(--text2)", lineHeight: 1.6, marginBottom: 14 }}>
                      Full trace with network timeline, DOM snapshots, action logs, and screenshots.
                      Download the ZIP and open it with the Playwright Trace Viewer.
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {traceUrl ? (
                        <>
                          <a href={traceUrl} download className="btn btn-primary btn-sm">
                            <Download size={12} /> Download Trace ZIP
                          </a>
                          <a
                            href={`https://trace.playwright.dev/?trace=${encodeURIComponent(traceUrl)}`}
                            target="_blank" rel="noreferrer"
                            className="btn btn-ghost btn-sm"
                          >
                            <ExternalLink size={12} /> Open in trace.playwright.dev
                          </a>
                        </>
                      ) : (
                        <div style={{ fontSize: "0.82rem", color: "var(--text3)" }}>
                          {isRunning ? "Trace will be available when run completes…" : "No trace file generated yet. Ensure tracing is enabled in testRunner.js."}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                    {[
                      { label: "Steps", val: results.length },
                      { label: "Duration", val: fmtMs(run.duration) },
                      { label: "Network Req", val: results.reduce((s, r) => s + (r.network?.length || 0), 0) },
                    ].map((s) => (
                      <div key={s.label} style={{ padding: "14px", background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--border)", textAlign: "center" }}>
                        <div style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{s.val}</div>
                        <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                  {/* Playwright config reminder */}
                  <div style={{ marginTop: 14, padding: "12px 16px", background: "#0d1117", borderRadius: 8, border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Playwright config used</div>
                    <pre style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "#93c5fd", lineHeight: 1.7, margin: 0 }}>{`recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } }
tracing.start({ screenshots: true, snapshots: true })`}</pre>
                  </div>
                </div>
              )}

              {/* 🌐 NETWORK */}
              {activeTab === "network" && (
                <div>
                  {activeResult?.network?.length > 0 ? (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem", fontFamily: "var(--font-mono)" }}>
                      <thead>
                        <tr>
                          {["Method","URL","Status","Duration","Size"].map((h) => (
                            <th key={h} style={{ textAlign: "left", padding: "8px 10px", color: "var(--text3)", borderBottom: "1px solid var(--border)", fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.05em", background: "var(--bg2)", position: "sticky", top: 0 }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {activeResult.network.map((n, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: "8px 10px" }}>
                              <span style={{
                                padding: "2px 6px", borderRadius: 4, fontSize: "0.68rem", fontWeight: 700,
                                color: n.method === "GET" ? "var(--green)" : "var(--blue)",
                                background: n.method === "GET" ? "var(--green-bg)" : "var(--blue-bg)",
                              }}>{n.method}</span>
                            </td>
                            <td style={{ padding: "8px 10px", color: "var(--text2)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={n.url}>
                              {n.url}
                            </td>
                            <td style={{ padding: "8px 10px", fontWeight: 600, color: n.status < 300 ? "var(--green)" : n.status < 400 ? "var(--amber)" : "var(--red)" }}>
                              {n.status ?? "—"}
                            </td>
                            <td style={{ padding: "8px 10px", color: "var(--text3)" }}>{fmtMs(n.duration)}</td>
                            <td style={{ padding: "8px 10px", color: "var(--text3)" }}>{fmtBytes(n.size)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}>
                      <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}>🌐</div>
                      No network activity recorded for this step.
                    </div>
                  )}
                </div>
              )}

              {/* 📜 CONSOLE */}
              {activeTab === "console" && (
                <div style={{ background: "#0d1117", borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.03)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>Console output for Step {activeStep + 1}</span>
                    <span style={{ marginLeft: "auto", fontSize: "0.68rem", color: "#475569", fontFamily: "var(--font-mono)" }}>
                      {activeResult?.consoleLogs?.length || 0} entries
                    </span>
                  </div>
                  <div style={{ padding: 12, maxHeight: 420, overflowY: "auto" }}>
                    {activeResult?.consoleLogs?.length > 0 ? (
                      activeResult.consoleLogs.map((l, i) => {
                        const colors = { error: "#f87171", warn: "#fbbf24", info: "#60a5fa", log: "#94a3b8" };
                        const c = colors[l.level] || "#94a3b8";
                        return (
                          <div key={i} style={{ display: "flex", gap: 12, padding: "2px 0", fontFamily: "var(--font-mono)", fontSize: "0.75rem", lineHeight: 1.7, borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                            <span style={{ color: "#475569", flexShrink: 0 }}>{new Date(l.time).toLocaleTimeString()}</span>
                            <span style={{ color: c, fontWeight: 600, width: 40, flexShrink: 0 }}>{l.level.toUpperCase()}</span>
                            <span style={{ color: l.level === "error" ? "#fca5a5" : "#94a3b8", wordBreak: "break-all" }}>{l.text}</span>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ padding: 20, textAlign: "center", color: "#475569", fontSize: "0.78rem" }}>
                        No console output captured for this step.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 🧩 DOM */}
              {activeTab === "dom" && (
                <div>
                  <div style={{ marginBottom: 10, fontSize: "0.72rem", color: "var(--text3)" }}>
                    DOM snapshot captured at step completion · Step {activeStep + 1}
                  </div>
                  {activeResult?.domSnapshot ? (
                    <div style={{ background: "#0d1117", borderRadius: 10, border: "1px solid var(--border)", padding: "14px 16px", overflowX: "auto" }}>
                      <DomNode node={activeResult.domSnapshot} depth={0} />
                    </div>
                  ) : (
                    <div style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}>
                      <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}>🧩</div>
                      No DOM snapshot for this step.
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* ── Crawl pipeline report (unchanged for crawl runs) ── */}
      {isCrawl && run.pipelineStats && (
        <div className="card" style={{ padding: 20 }}>
          <div style={{ marginBottom: 16, fontSize: "0.82rem", color: "var(--text2)", lineHeight: 1.7 }}>
            Sentri crawled your application, filtered elements, classified intents, detected user journeys, and generated high-quality tests.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[
              { label: "Pages Found", val: run.pipelineStats.pagesFound, color: "var(--accent)" },
              { label: "Raw Tests Generated", val: run.pipelineStats.rawTestsGenerated, color: "var(--text)" },
              { label: "Duplicates Removed", val: run.pipelineStats.duplicatesRemoved, color: "var(--amber)" },
              { label: "Journeys Detected", val: run.pipelineStats.journeysDetected, color: "var(--purple)" },
              { label: "Assertions Enhanced", val: run.pipelineStats.assertionsEnhanced, color: "var(--green)" },
              { label: "Avg Quality Score", val: run.pipelineStats.averageQuality != null ? `${run.pipelineStats.averageQuality}/100` : "—", color: (run.pipelineStats.averageQuality || 0) >= 60 ? "var(--green)" : "var(--amber)" },
            ].map((s, i) => (
              <div key={i} style={{ padding: "14px 16px", background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, color: s.color }}>{s.val ?? "—"}</div>
                <div style={{ fontSize: "0.73rem", color: "var(--text3)", marginTop: 3 }}>{s.label}</div>
              </div>
            ))}
          </div>
          {run.logs?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Activity Log</div>
              <div style={{ background: "#0d1117", borderRadius: 8, padding: "10px 14px", maxHeight: 300, overflowY: "auto" }}>
                {run.logs.map((l, i) => (
                  <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "#94a3b8", lineHeight: 1.8 }}>{l}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

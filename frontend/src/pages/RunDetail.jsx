import React, { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, CheckCircle, XCircle, AlertTriangle, RefreshCw, Clock, Film, Image, Download } from "lucide-react";
import { api } from "../api.js";

function colorLog(line) {
  if (line.includes("✅") || line.includes("PASSED") || line.includes("Done") || line.includes("complete")) return "log-ok";
  if (line.includes("❌") || line.includes("FAILED") || line.includes("failed")) return "log-error";
  if (line.includes("⚠️") || line.includes("WARNING") || line.includes("warn")) return "log-warn";
  return "";
}

export default function RunDetail() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const logRef = useRef(null);
  const intervalRef = useRef(null);

  const [showVideo, setShowVideo] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const sseRef = useRef(null);

  const fetchRun = useCallback(async () => {
    const r = await api.getRun(runId).catch(() => null);
    if (r) setRun(r);
    return r;
  }, [runId]);

  useEffect(() => {
    fetchRun().finally(() => setLoading(false));
  }, [fetchRun]);

  // SSE real-time log streaming with polling fallback
  useEffect(() => {
    if (!run) return;
    if (run.status !== "running") return;

    // Try SSE first
    let useSSE = true;
    try {
      const evtSource = new EventSource(`/api/runs/${runId}/stream`);
      sseRef.current = evtSource;

      evtSource.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "log") {
            setRun((prev) => {
              if (!prev) return prev;
              if (prev.logs?.includes(msg.data)) return prev;
              return { ...prev, logs: [...(prev.logs || []), msg.data] };
            });
          } else if (msg.type === "complete") {
            setRun(msg.data);
            evtSource.close();
          }
        } catch {
          // Ignore parse errors
        }
      };

      evtSource.onerror = () => {
        useSSE = false;
        evtSource.close();
        // Fall back to polling
        intervalRef.current = setInterval(async () => {
          const r = await fetchRun();
          if (r?.status !== "running") clearInterval(intervalRef.current);
        }, 1500);
      };
    } catch {
      useSSE = false;
      // SSE not available, use polling
      intervalRef.current = setInterval(async () => {
        const r = await fetchRun();
        if (r?.status !== "running") clearInterval(intervalRef.current);
      }, 1500);
    }

    return () => {
      if (sseRef.current) sseRef.current.close();
      clearInterval(intervalRef.current);
    };
  }, [run?.status, fetchRun, runId]);

  // Auto-open video player when run completes and has videos
  useEffect(() => {
    if (run?.status === "completed" && run?.videos?.length > 0 && !showVideo) {
      setShowVideo(true);
      setSelectedVideo(run.videos[0]);
    }
  }, [run?.status, run?.videos]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.logs?.length]);

  if (loading) return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div className="skeleton" style={{ height: 100, borderRadius: 16, marginBottom: 16 }} />
      <div className="skeleton" style={{ height: 320, borderRadius: 16 }} />
    </div>
  );
  if (!run) return <div style={{ color: "var(--text2)" }}>Run not found</div>;

  const isRunning = run.status === "running";
  const isCrawl = run.type === "crawl";
  const passRate = run.total ? Math.round((run.passed / run.total) * 100) : null;

  return (
    <div className="fade-in" style={{ maxWidth: 960, margin: "0 auto" }}>
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }} onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>

      {/* Run header */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              {isRunning
                ? <RefreshCw size={18} color="var(--accent)" className="spin" />
                : run.status === "completed"
                ? <CheckCircle size={18} color="var(--green)" />
                : <XCircle size={18} color="var(--red)" />}
              <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.3rem" }}>
                {isCrawl ? "Crawl & Generate Run" : "Test Execution Run"}
              </h1>
              {isRunning && <span className="badge badge-blue pulse">● Live</span>}
              {run.status === "completed" && <span className="badge badge-green">Completed</span>}
              {run.status === "failed" && <span className="badge badge-red">Failed</span>}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text3)" }}>{run.id}</div>
          </div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            {isCrawl ? (
              <Stat icon={<CheckCircle size={14} color="var(--green)" />} label="Pages Found" value={run.pagesFound ?? 0} />
            ) : (
              <>
                <Stat icon={<CheckCircle size={14} color="var(--green)" />} label="Passed" value={run.passed ?? 0} color="var(--green)" />
                <Stat icon={<XCircle size={14} color="var(--red)" />} label="Failed" value={run.failed ?? 0} color="var(--red)" />
                <Stat icon={<AlertTriangle size={14} color="var(--text2)" />} label="Total" value={run.total ?? 0} />
              </>
            )}
            <Stat icon={<Clock size={14} color="var(--text3)" />} label="Started" value={new Date(run.startedAt).toLocaleTimeString()} />
          </div>
        </div>

        {/* Progress bar for test runs */}
        {!isCrawl && run.total > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: "0.78rem", color: "var(--text2)" }}>
              <span>{(run.passed || 0) + (run.failed || 0)} / {run.total} tests executed</span>
              {passRate !== null && <span style={{ color: passRate >= 80 ? "var(--green)" : passRate >= 50 ? "var(--amber)" : "var(--red)", fontWeight: 700 }}>{passRate}% pass rate</span>}
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${Math.round(((run.passed || 0) + (run.failed || 0)) / run.total * 100)}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Video Player - auto-opens after execution */}
      {showVideo && run.videos?.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Film size={16} color="var(--accent)" />
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.85rem", color: "var(--text2)", letterSpacing: "0.05em", textTransform: "uppercase" }}>
                Test Recording
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {run.videos.length > 1 && (
                <select
                  value={selectedVideo || ""}
                  onChange={(e) => setSelectedVideo(e.target.value)}
                  style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "4px 8px", color: "var(--text)", fontSize: "0.78rem", fontFamily: "var(--font-mono)" }}
                >
                  {run.videos.map((v, i) => (
                    <option key={v} value={v}>Video {i + 1}</option>
                  ))}
                </select>
              )}
              {selectedVideo && (
                <a href={selectedVideo} download style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--accent)", fontSize: "0.78rem", textDecoration: "none" }}>
                  <Download size={13} /> Download
                </a>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setShowVideo(false)} style={{ fontSize: "0.75rem" }}>
                Hide
              </button>
            </div>
          </div>
          {selectedVideo && (
            <video
              key={selectedVideo}
              controls
              autoPlay
              style={{ width: "100%", borderRadius: "var(--radius)", background: "#000" }}
            >
              <source src={selectedVideo} type="video/webm" />
              Your browser does not support the video tag.
            </video>
          )}
          {run.traceUrl && (
            <div style={{ marginTop: 10, fontSize: "0.78rem" }}>
              <a href={run.traceUrl} download style={{ color: "var(--accent)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
                <Download size={13} /> Download Playwright Trace
              </a>
            </div>
          )}
        </div>
      )}

      {/* Show video button when videos available but player hidden */}
      {!showVideo && run.videos?.length > 0 && (
        <button
          className="btn btn-ghost"
          style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}
          onClick={() => { setShowVideo(true); setSelectedVideo(run.videos[0]); }}
        >
          <Film size={15} /> Show Test Recordings ({run.videos.length})
        </button>
      )}

      <div style={{ display: "grid", gridTemplateColumns: run.results?.length ? "1fr 1fr" : "1fr", gap: 16 }}>
        {/* Logs */}
        <div className="card">
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.85rem", color: "var(--text2)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 12 }}>
            Agent Logs {isRunning && <span style={{ marginLeft: 8 }} className="pulse">Live</span>}
          </div>
          <div className="log-box" ref={logRef}>
            {run.logs?.length === 0 && <span style={{ color: "var(--text3)" }}>Waiting for logs…</span>}
            {run.logs?.map((line, i) => (
              <div key={i} className={colorLog(line)}>{line}</div>
            ))}
            {isRunning && <div style={{ color: "var(--accent)", opacity: 0.6 }}>▌</div>}
          </div>
        </div>

        {/* Test Results */}
        {run.results?.length > 0 && (
          <div className="card">
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.85rem", color: "var(--text2)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 12 }}>
              Test Results
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 460, overflowY: "auto" }}>
              {run.results.map((r, i) => (
                <div key={i} style={{
                  padding: "10px 14px", borderRadius: "var(--radius)",
                  background: r.status === "passed" ? "rgba(0,212,106,0.06)" : r.status === "warning" ? "rgba(255,165,2,0.06)" : "rgba(255,71,87,0.06)",
                  border: `1px solid ${r.status === "passed" ? "rgba(0,212,106,0.15)" : r.status === "warning" ? "rgba(255,165,2,0.15)" : "rgba(255,71,87,0.15)"}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {r.status === "passed"
                      ? <CheckCircle size={14} color="var(--green)" />
                      : r.status === "warning"
                      ? <AlertTriangle size={14} color="var(--amber)" />
                      : <XCircle size={14} color="var(--red)" />}
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "0.83rem", flex: 1 }}>{r.testName}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text3)" }}>{r.durationMs}ms</span>
                  </div>
                  {r.error && (
                    <div style={{ marginTop: 6, fontSize: "0.75rem", color: r.status === "warning" ? "var(--amber)" : "var(--red)", fontFamily: "var(--font-mono)", paddingLeft: 22 }}>
                      {r.error}
                    </div>
                  )}
                  {/* Action buttons: video & screenshot */}
                  <div style={{ display: "flex", gap: 10, marginTop: 8, paddingLeft: 22 }}>
                    {r.videoUrl && (
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: "0.72rem", padding: "2px 8px" }}
                        onClick={() => { setSelectedVideo(r.videoUrl); setShowVideo(true); }}
                      >
                        <Film size={11} /> Video
                      </button>
                    )}
                    {r.screenshot && (
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: "0.72rem", padding: "2px 8px" }}
                        onClick={() => {
                          const w = window.open();
                          if (w) {
                            w.document.write(`<img src="data:image/png;base64,${r.screenshot}" style="max-width:100%" />`);
                          }
                        }}
                      >
                        <Image size={11} /> Screenshot
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Generated Tests (crawl run) */}
      {isCrawl && run.tests?.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.85rem", color: "var(--text2)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 12 }}>
            Tests Generated ({run.tests.length})
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--green)" }}>
            ✓ {run.tests.length} test cases created and ready to run
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value, color = "var(--text)" }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center", marginBottom: 4 }}>
        {icon}
        <span style={{ fontSize: "0.72rem", color: "var(--text3)", fontFamily: "var(--font-display)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.4rem", color }}>{value}</div>
    </div>
  );
}

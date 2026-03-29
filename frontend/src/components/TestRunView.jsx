import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";

// ─── Helpers ─────────────────────────────────────────────
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

// ─── Status helpers ───────────────────────────────────────
function StatusIcon({ status, size = 14 }) {
  if (status === "passed")
    return <CheckCircle2 size={size} color="var(--green)" />;
  if (status === "failed")
    return <XCircle size={size} color="var(--red)" />;
  if (status === "warning")
    return <AlertTriangle size={size} color="var(--amber)" />;
  return <Clock size={size} color="var(--text3)" />;
}

function statusColor(status) {
  if (status === "passed") return "var(--green)";
  if (status === "failed") return "var(--red)";
  if (status === "warning") return "var(--amber)";
  return "var(--text3)";
}

function statusBadgeClass(status) {
  if (status === "passed") return "badge-green";
  if (status === "failed") return "badge-red";
  if (status === "warning") return "badge-amber";
  return "badge-gray";
}

// ─── DOM Renderer ────────────────────────────────────────
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

  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => ` <span style="color:#f59e0b">${k}</span>=<span style="color:#34d399">"${v}"</span>`)
    .join("");

  const hasChildren = node.children?.length > 0;

  return (
    <div style={{ marginLeft: depth * 14, lineHeight: 1.8 }}>
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

// ─── Test Step Row (inside a test case) ──────────────────
function TestStepRow({ step, index, isActive, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "7px 14px 7px 36px",
        cursor: "pointer",
        background: isActive ? "var(--accent-bg)" : "transparent",
        borderLeft: isActive
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        transition: "all 0.12s",
      }}
    >
      {/* Step connector line indicator */}
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: `1.5px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
          background: isActive ? "var(--accent-bg)" : "var(--bg2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: "0.62rem",
          fontWeight: 700,
          color: isActive ? "var(--accent)" : "var(--text3)",
          fontFamily: "var(--font-mono)",
          marginTop: 1,
        }}
      >
        {index + 1}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "0.75rem",
            color: isActive ? "var(--text)" : "var(--text2)",
            lineHeight: 1.45,
            fontWeight: isActive ? 500 : 400,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {step}
        </div>
      </div>
    </div>
  );
}

// ─── Test Case Row (expandable) ──────────────────────────
function TestCaseRow({ result, caseIndex, activeCase, activeStep, onSelectStep, isRunning }) {
  const isActive = activeCase === caseIndex;
  const [expanded, setExpanded] = useState(isActive);
  const steps = result.steps || [];

  // Auto-expand when this case becomes active
  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  return (
    <div>
      {/* Case header */}
      <div
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "11px 14px",
          cursor: "pointer",
          borderBottom: "1px solid var(--border)",
          background:
            isActive ? "var(--bg2)" : "transparent",
          borderLeft: isActive
            ? `3px solid ${statusColor(result.status)}`
            : "3px solid transparent",
          transition: "all 0.12s",
        }}
      >
        {/* Expand chevron */}
        <div style={{ color: "var(--text3)", flexShrink: 0 }}>
          {expanded ? (
            <ChevronDown size={13} />
          ) : (
            <ChevronRight size={13} />
          )}
        </div>

        {/* Status icon */}
        <StatusIcon status={result.status} size={13} />

        {/* Test case name */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "0.78rem",
              fontWeight: 600,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {result.testName || result.name || `Test Case ${caseIndex + 1}`}
          </div>
          {steps.length > 0 && (
            <div style={{ fontSize: "0.68rem", color: "var(--text3)", marginTop: 1 }}>
              {steps.length} step{steps.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>

        {/* Right side: badge + duration */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span
            className={`badge ${statusBadgeClass(result.status)}`}
            style={{ fontSize: "0.62rem" }}
          >
            {result.status}
          </span>
          <span
            style={{
              fontSize: "0.68rem",
              color: "var(--text3)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {fmtMs(result.durationMs)}
          </span>
        </div>
      </div>

      {/* Error (shown when expanded and failed) */}
      {expanded && result.status === "failed" && result.error && (
        <div
          style={{
            margin: "0 14px 8px 36px",
            padding: "8px 10px",
            background: "var(--red-bg)",
            borderRadius: 6,
            fontSize: "0.71rem",
            color: "var(--red)",
            fontFamily: "var(--font-mono)",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            borderLeft: "2px solid var(--red)",
          }}
        >
          {result.error}
        </div>
      )}

      {/* Step list */}
      {expanded && (
        <div
          style={{
            borderBottom: "1px solid var(--border)",
            background: "var(--bg2)",
          }}
        >
          {steps.length === 0 ? (
            /* No human-readable steps — show a single "view debug info" item */
            <div
              onClick={() => onSelectStep(caseIndex, 0)}
              style={{
                padding: "8px 14px 8px 36px",
                fontSize: "0.74rem",
                color: isActive && activeStep === 0 ? "var(--accent)" : "var(--text3)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  border: "1.5px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.62rem",
                  color: "var(--text3)",
                  fontFamily: "var(--font-mono)",
                  flexShrink: 0,
                }}
              >
                1
              </span>
              View debug artifacts (screenshot, network, console)
            </div>
          ) : (
            steps.map((step, si) => (
              <TestStepRow
                key={si}
                step={step}
                index={si}
                isActive={isActive && activeStep === si}
                onClick={() => onSelectStep(caseIndex, si)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────
export default function TestRunView({ run }) {
  // results = test cases (each with optional .steps[] array)
  const results = run?.steps || run?.results || [];

  const [activeCase, setActiveCase] = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const [activeTab, setActiveTab] = useState("video");

  const listRef = useRef(null);
  const current = results[activeCase];

  const BASE_URL = window.location.origin.replace(":3000", ":3001");

  // Video
  const videoSegments =
    run?.videoSegments || (run?.videoPath ? [run.videoPath] : []);
  const videoUrl = current?.videoPath
    ? `${BASE_URL}${current.videoPath}`
    : videoSegments[activeCase]
    ? `${BASE_URL}${videoSegments[activeCase]}`
    : null;

  const traceUrl = run?.tracePath ? `${BASE_URL}${run.tracePath}` : null;

  // Auto-follow latest case while running
  useEffect(() => {
    if (results.length > 0) {
      setActiveCase(results.length - 1);
      setActiveStep(0);
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
    }
  }, [results.length]);

  function handleSelectStep(caseIdx, stepIdx) {
    setActiveCase(caseIdx);
    setActiveStep(stepIdx);
  }

  // Suite-level summary
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const total = results.length;

  const tabs = [
    { id: "video",      label: "🎥 Video" },
    { id: "screenshot", label: "📸 Screenshot" },
    { id: "trace",      label: "📊 Trace" },
    { id: "network",    label: "🌐 Network" },
    { id: "console",    label: "📜 Console" },
    { id: "dom",        label: "🧩 DOM" },
  ];

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
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "320px 1fr",
        gap: 16,
        minHeight: 560,
      }}
    >
      {/* ───────── LEFT: Test Suite Tree ───────── */}
      <div style={panelStyle}>
        {/* Suite header */}
        <div
          style={{
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            <span style={{ fontWeight: 700, fontSize: "0.82rem" }}>
              Test Suite
            </span>
            <span
              style={{
                fontSize: "0.68rem",
                color: "var(--text3)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {total} test{total !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Mini pass/fail bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div
              style={{
                flex: 1,
                height: 4,
                background: "var(--bg3)",
                borderRadius: 99,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: total > 0 ? `${(passed / total) * 100}%` : "0%",
                  background:
                    failed > 0 ? "var(--green)" : "var(--green)",
                  borderRadius: 99,
                  transition: "width 0.6s ease",
                }}
              />
            </div>
            <span
              style={{
                fontSize: "0.68rem",
                color: "var(--green)",
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
              }}
            >
              {passed}✓
            </span>
            {failed > 0 && (
              <span
                style={{
                  fontSize: "0.68rem",
                  color: "var(--red)",
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                }}
              >
                {failed}✗
              </span>
            )}
          </div>
        </div>

        {/* Test case list (scrollable) */}
        <div ref={listRef} style={{ overflowY: "auto", flex: 1 }}>
          {results.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--text3)",
                fontSize: "0.82rem",
              }}
            >
              {run?.status === "running" ? "Running tests…" : "No test cases yet"}
            </div>
          ) : (
            results.map((result, ci) => (
              <TestCaseRow
                key={ci}
                result={result}
                caseIndex={ci}
                activeCase={activeCase}
                activeStep={activeStep}
                onSelectStep={handleSelectStep}
                isRunning={run?.status === "running"}
              />
            ))
          )}

          {run?.status === "running" && (
            <div
              style={{
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "var(--text3)",
                fontSize: "0.75rem",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--blue)",
                  animation: "pulse 1.4s ease-in-out infinite",
                }}
              />
              Running…
            </div>
          )}
        </div>
      </div>

      {/* ───────── RIGHT: Debug Panel ───────── */}
      <div style={panelStyle}>
        {/* Context bar — shows which test case is selected */}
        {current && (
          <div
            style={{
              padding: "8px 16px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg2)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <StatusIcon status={current.status} size={12} />
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                color: "var(--text)",
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {current.testName || current.name || `Test Case ${activeCase + 1}`}
            </span>
            {(current.steps || []).length > 0 && (
              <span
                style={{
                  fontSize: "0.68rem",
                  color: "var(--text3)",
                  fontFamily: "var(--font-mono)",
                  flexShrink: 0,
                }}
              >
                Step {activeStep + 1} / {(current.steps || []).length}
              </span>
            )}
          </div>
        )}

        {/* Tabs */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid var(--border)",
            padding: "0 16px",
            flexShrink: 0,
            overflowX: "auto",
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: "10px 12px",
                border: "none",
                background: "none",
                cursor: "pointer",
                fontSize: "0.76rem",
                fontWeight: 500,
                color: activeTab === t.id ? "var(--accent)" : "var(--text3)",
                borderBottom: `2px solid ${
                  activeTab === t.id ? "var(--accent)" : "transparent"
                }`,
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
        <div style={{ padding: 16, flex: 1, overflowY: "auto" }}>

          {/* 🎥 VIDEO */}
          {activeTab === "video" &&
            (videoUrl ? (
              <div>
                <div
                  style={{
                    background: "#000",
                    borderRadius: 10,
                    overflow: "hidden",
                    marginBottom: 10,
                    border: "1px solid var(--border)",
                  }}
                >
                  <video
                    key={videoUrl}
                    width="100%"
                    controls
                    style={{ display: "block", maxHeight: 400 }}
                  >
                    <source src={videoUrl} type="video/webm" />
                  </video>
                </div>
                {videoSegments.length > 1 && (
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.7rem",
                        color: "var(--text3)",
                      }}
                    >
                      Jump to test:
                    </span>
                    {results.map((r, i) => (
                      <button
                        key={i}
                        onClick={() => handleSelectStep(i, 0)}
                        style={{
                          padding: "2px 10px",
                          borderRadius: 100,
                          fontSize: "0.7rem",
                          fontFamily: "var(--font-mono)",
                          cursor: "pointer",
                          border: `1px solid ${
                            i === activeCase
                              ? "var(--accent)"
                              : "var(--border)"
                          }`,
                          background:
                            i === activeCase
                              ? "var(--accent-bg)"
                              : "transparent",
                          color:
                            i === activeCase
                              ? "var(--accent)"
                              : "var(--text3)",
                        }}
                      >
                        TC{i + 1}{" "}
                        {r.status === "passed"
                          ? "✅"
                          : r.status === "failed"
                          ? "❌"
                          : "⚠️"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  background: "var(--bg2)",
                  borderRadius: 10,
                  padding: 40,
                  textAlign: "center",
                  border: "2px dashed var(--border)",
                }}
              >
                <div
                  style={{
                    fontSize: 36,
                    marginBottom: 10,
                    opacity: 0.3,
                  }}
                >
                  ▶
                </div>
                <div
                  style={{
                    fontWeight: 600,
                    color: "var(--text2)",
                    marginBottom: 6,
                  }}
                >
                  No video available
                </div>
                <div
                  style={{
                    fontSize: "0.76rem",
                    color: "var(--text3)",
                    lineHeight: 1.6,
                  }}
                >
                  {run?.status === "running"
                    ? "Tests are still running…"
                    : "Video is recorded after tests complete."}
                </div>
              </div>
            ))}

          {/* 📸 SCREENSHOT */}
          {activeTab === "screenshot" &&
            (current?.screenshot ? (
              <img
                src={`data:image/png;base64,${current.screenshot}`}
                alt="Screenshot"
                style={{
                  width: "100%",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                }}
              />
            ) : (
              <div
                style={{
                  textAlign: "center",
                  padding: 40,
                  color: "var(--text3)",
                }}
              >
                <div
                  style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}
                >
                  📸
                </div>
                No screenshot for this test case.
              </div>
            ))}

          {/* 📊 TRACE */}
          {activeTab === "trace" && (
            <div>
              <div
                style={{
                  padding: 16,
                  background: "var(--bg2)",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  marginBottom: 12,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Playwright Trace Report
                </div>
                <div
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text2)",
                    lineHeight: 1.6,
                    marginBottom: 14,
                  }}
                >
                  Full trace with network timeline, DOM snapshots, action
                  logs, and screenshots.
                </div>
                {traceUrl ? (
                  <div style={{ display: "flex", gap: 10 }}>
                    <a
                      href={traceUrl}
                      download
                      className="btn btn-primary btn-sm"
                    >
                      ↓ Download ZIP
                    </a>
                    <a
                      href={`https://trace.playwright.dev/?trace=${encodeURIComponent(traceUrl)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-ghost btn-sm"
                    >
                      ↗ Open Viewer
                    </a>
                  </div>
                ) : (
                  <div
                    style={{ fontSize: "0.8rem", color: "var(--text3)" }}
                  >
                    {run?.status === "running"
                      ? "Trace available when run completes…"
                      : "No trace file generated."}
                  </div>
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 10,
                }}
              >
                {[
                  { label: "Test Cases", val: results.length },
                  {
                    label: "Duration",
                    val: fmtMs(run?.duration),
                  },
                  {
                    label: "Network Req",
                    val: results.reduce(
                      (s, r) => s + (r.network?.length || 0),
                      0
                    ),
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    style={{
                      padding: 14,
                      background: "var(--bg2)",
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "1.3rem",
                        fontWeight: 700,
                        color: "var(--text)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {s.val}
                    </div>
                    <div
                      style={{
                        fontSize: "0.68rem",
                        color: "var(--text3)",
                        marginTop: 3,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      {s.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 🌐 NETWORK */}
          {activeTab === "network" && (
            <div>
              {current?.network?.length > 0 ? (
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
                    {current.network.map((n, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
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
                          style={{ padding: "7px 10px", color: "var(--text3)" }}
                        >
                          {fmtMs(n.duration)}
                        </td>
                        <td
                          style={{ padding: "7px 10px", color: "var(--text3)" }}
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
                    padding: 40,
                    color: "var(--text3)",
                  }}
                >
                  <div
                    style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}
                  >
                    🌐
                  </div>
                  No network data for this test case.
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
                  gap: 6,
                }}
              >
                <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>
                  Console — {current?.testName || `TC ${activeCase + 1}`}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "0.65rem",
                    color: "#475569",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {current?.consoleLogs?.length || 0} entries
                </span>
              </div>
              <div style={{ padding: 12, maxHeight: 420, overflowY: "auto" }}>
                {current?.consoleLogs?.length > 0 ? (
                  current.consoleLogs.map((l, i) => {
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
                        <span
                          style={{ color: "#475569", flexShrink: 0 }}
                        >
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
          {activeTab === "dom" &&
            (current?.domSnapshot ? (
              <div
                style={{
                  background: "#0d1117",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  padding: "14px 16px",
                  overflowX: "auto",
                }}
              >
                <DomNode node={current.domSnapshot} depth={0} />
              </div>
            ) : (
              <div
                style={{
                  textAlign: "center",
                  padding: 40,
                  color: "var(--text3)",
                }}
              >
                <div
                  style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}
                >
                  🧩
                </div>
                No DOM snapshot for this test case.
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

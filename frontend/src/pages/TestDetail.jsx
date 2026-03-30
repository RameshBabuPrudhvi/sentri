import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Play, Edit2, RefreshCw, Download,
  CheckCircle2, XCircle, Clock, AlertCircle,
  ChevronRight, Calendar, User, GitCommit,
  RotateCcw, ExternalLink, X, Plus, Save,
} from "lucide-react";
import { api } from "../api.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "less than a minute ago";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatusBadge({ result }) {
  if (!result)              return <span className="badge badge-gray"><Clock size={10} /> Not Run</span>;
  if (result === "passed")  return <span className="badge badge-green"><CheckCircle2 size={10} /> Passing</span>;
  if (result === "failed")  return <span className="badge badge-red"><XCircle size={10} /> Failing</span>;
  if (result === "running") return <span className="badge badge-blue pulse">● Running</span>;
  return <span className="badge badge-amber">{result}</span>;
}

function ReviewBadge({ status }) {
  if (status === "approved") return <span className="badge badge-green"><CheckCircle2 size={10} /> Approved</span>;
  if (status === "rejected") return <span className="badge badge-red"><XCircle size={10} /> Rejected</span>;
  return <span className="badge badge-amber"><AlertCircle size={10} /> Draft Test</span>;
}

// ── Run status icon (used in Recent Test Runs table) ─────────────────────────
function RunIcon({ status }) {
  if (status === "passed" || status === "completed")
    return <span style={{ color: "var(--green)", fontSize: 16 }}>✓</span>;
  if (status === "failed")
    return <span style={{ color: "var(--red)", fontSize: 16 }}>✗</span>;
  if (status === "running")
    return <RefreshCw size={14} color="var(--blue)" className="spin" />;
  return <Clock size={14} color="var(--text3)" />;
}

// ── Info Row (right sidebar) ──────────────────────────────────────────────────
function InfoRow({ icon, label, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: "0.73rem", color: "var(--text3)", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {icon && <span style={{ color: "var(--accent)", flexShrink: 0 }}>{icon}</span>}
        {children}
      </div>
    </div>
  );
}

// ── Avatar chip ───────────────────────────────────────────────────────────────
function AvatarChip({ name }) {
  const initials = (name || "U").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        width: 24, height: 24, borderRadius: 6,
        background: "var(--accent-bg)", color: "var(--accent)",
        fontSize: "0.65rem", fontWeight: 700,
        display: "flex", alignItems: "center", justifyContent: "center",
        border: "1px solid rgba(91,110,245,0.2)",
      }}>
        {initials}
      </div>
      <span style={{ fontSize: "0.82rem", fontWeight: 500, color: "var(--text)" }}>{name || "—"}</span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function TestDetail() {
  const { testId } = useParams();
  const navigate = useNavigate();

  const [test, setTest]       = useState(null);
  const [project, setProject] = useState(null);
  const [runs, setRuns]       = useState([]);  // all runs for this project
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  // ── Edit mode state ──────────────────────────────────────────────────────
  const [editing, setEditing]         = useState(false);
  const [editName, setEditName]       = useState("");
  const [editDesc, setEditDesc]       = useState("");
  const [editSteps, setEditSteps]     = useState([]);
  const [editPriority, setEditPriority] = useState("medium");
  const [saving, setSaving]           = useState(false);
  const [editError, setEditError]     = useState(null);

  const load = useCallback(async () => {
    const t = await api.getTest(testId);
    setTest(t);
    const [p, r] = await Promise.all([
      api.getProject(t.projectId).catch(() => null),
      api.getRuns(t.projectId).catch(() => []),
    ]);
    setProject(p);
    // Filter runs that include this test in their results
    const relevant = r.filter(run =>
      run.type === "test_run" &&
      (run.tests?.includes(testId) || run.results?.some(res => res.testId === testId))
    );
    setRuns(relevant);
  }, [testId]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  function startEditing() {
    setEditName(test.name || "");
    setEditDesc(test.description || "");
    setEditSteps([...(test.steps || [])]);
    setEditPriority(test.priority || "medium");
    setEditError(null);
    setEditing(true);
  }

  async function handleSaveEdit() {
    if (!editName.trim()) { setEditError("Test name is required."); return; }
    setSaving(true);
    setEditError(null);
    try {
      const cleanSteps = editSteps.filter(s => s.trim());
      const stepsChanged = JSON.stringify(cleanSteps) !== JSON.stringify(test.steps || []);

      const updated = await api.updateTest(testId, {
        name: editName.trim(),
        description: editDesc.trim(),
        steps: cleanSteps,
        priority: editPriority,
        // When steps changed, ask the backend to regenerate the Playwright code
        // so the test script stays in sync with the human-readable steps.
        regenerateCode: stepsChanged,
      });
      setTest(updated);
      setEditing(false);
    } catch (err) {
      setEditError(err.message || "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  }

  function cancelEditing() {
    setEditing(false);
    setEditError(null);
  }

  function updateEditStep(i, val) {
    setEditSteps(prev => prev.map((s, idx) => idx === i ? val : s));
  }
  function removeEditStep(i) {
    setEditSteps(prev => prev.filter((_, idx) => idx !== i));
  }
  function addEditStep() {
    setEditSteps(prev => [...prev, ""]);
  }

  function handleExport() {
    if (!test) return;
    const exportData = {
      id: test.id,
      name: test.name,
      description: test.description || "",
      type: test.type || "",
      priority: test.priority || "medium",
      reviewStatus: test.reviewStatus || "draft",
      sourceUrl: test.sourceUrl || "",
      steps: test.steps || [],
      playwrightCode: test.playwrightCode || null,
      lastResult: test.lastResult || null,
      lastRunAt: test.lastRunAt || null,
      createdAt: test.createdAt || null,
      project: project ? { id: project.id, name: project.name, url: project.url } : null,
      runHistory: runs.slice(0, 20).map(run => {
        const result = run.results?.find(r => r.testId === testId);
        return {
          runId: run.id,
          status: result?.status || run.status,
          durationMs: result?.durationMs || null,
          startedAt: run.startedAt || null,
        };
      }),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sentri-test-${(test.name || "export").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  async function handleRunTest() {
    if (!test?.projectId) return;
    setRunning(true);
    try {
      const { runId } = await api.runSingleTest(testId);
      navigate(`/runs/${runId}`);
    } catch (err) {
      alert(err.message);
      setRunning(false);
    }
  }

  if (loading) return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "0 4px" }}>
      {[48, 200, 200].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 12, marginBottom: 16 }} />
      ))}
    </div>
  );

  if (!test) return (
    <div style={{ padding: 60, textAlign: "center", color: "var(--text2)" }}>
      Test not found.{" "}
      <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>Go back</button>
    </div>
  );

  const author = test.author || project?.name || "Karthik kk";

  return (
    <div className="fade-in" style={{ maxWidth: 980, margin: "0 auto" }}>

      {/* ── Breadcrumb + toolbar ─────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        {/* Breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.82rem", color: "var(--text3)" }}>
          <button
            onClick={() => navigate("/projects")}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", display: "flex", alignItems: "center", gap: 4, padding: 0, fontSize: "0.82rem" }}
          >
            Tests
          </button>
          <ChevronRight size={13} />
          <span style={{ color: "var(--text)" }}>Test Details</span>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          {editing ? (
            <>
              <button className="btn btn-ghost btn-sm" onClick={cancelEditing} disabled={saving}>
                <X size={14} /> Cancel
              </button>
              <button className="btn btn-primary btn-sm" onClick={handleSaveEdit} disabled={saving}>
                {saving ? <RefreshCw size={14} className="spin" /> : <Save size={14} />}
                {saving ? "Saving & regenerating code…" : "Save Changes"}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost btn-sm" onClick={handleExport}>
                <Download size={14} /> Export
              </button>
              <button className="btn btn-ghost btn-sm" onClick={startEditing}>
                <Edit2 size={14} /> Edit Test
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleRunTest}
                disabled={running}
              >
                {running
                  ? <RefreshCw size={14} className="spin" />
                  : <Play size={14} />}
                Run Test
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Page title ───────────────────────────────────────────────────── */}
      {editing ? (
        <div style={{ marginBottom: 24 }}>
          <input
            className="input"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            placeholder="Test name"
            style={{ fontSize: "1.3rem", fontWeight: 700, height: 48, marginBottom: 8 }}
            autoFocus
          />
          {editError && (
            <div style={{
              background: "var(--red-bg)", color: "var(--red)",
              borderRadius: "var(--radius)", padding: "8px 12px",
              fontSize: "0.82rem",
            }}>
              {editError}
            </div>
          )}
        </div>
      ) : (
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: 24 }}>
          {test.name}
        </h1>
      )}

      {/* ── Two-column layout ────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 20, alignItems: "start" }}>

        {/* LEFT COLUMN */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Description card */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: "var(--bg2)", border: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <GitCommit size={14} color="var(--text2)" />
              </div>
              <h2 style={{ fontWeight: 700, fontSize: "1rem", margin: 0 }}>Description</h2>
            </div>
            {editing ? (
              <textarea
                className="input"
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder="Describe what this test verifies…"
                rows={3}
                style={{ fontSize: "0.875rem", lineHeight: 1.7, resize: "vertical" }}
              />
            ) : (
              <p style={{ fontSize: "0.875rem", color: "var(--text)", lineHeight: 1.7, margin: 0 }}>
                {test.description || <span style={{ color: "var(--text3)" }}>No description provided.</span>}
              </p>
            )}
          </div>

          {/* Test Steps card */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: "var(--bg2)", border: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <CheckCircle2 size={14} color="var(--text2)" />
              </div>
              <h2 style={{ fontWeight: 700, fontSize: "1rem", margin: 0 }}>Test Steps</h2>
            </div>

            {editing ? (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {editSteps.map((step, idx) => (
                    <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <div style={{
                        width: 24, height: 24, borderRadius: "50%",
                        background: "var(--bg3)", border: "1px solid var(--border)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: "0.65rem", fontWeight: 700, color: "var(--text3)",
                        flexShrink: 0, marginTop: 7,
                      }}>
                        {idx + 1}
                      </div>
                      <input
                        className="input"
                        value={step}
                        onChange={e => updateEditStep(idx, e.target.value)}
                        style={{ flex: 1, height: 36, fontSize: "0.82rem" }}
                      />
                      <button
                        onClick={() => removeEditStep(idx)}
                        style={{
                          background: "none", border: "none", cursor: "pointer",
                          color: "var(--text3)", padding: "6px 4px", flexShrink: 0,
                          marginTop: 2,
                        }}
                        title="Remove step"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={addEditStep}
                  style={{
                    marginTop: 8, background: "none", border: "1px dashed var(--border)",
                    borderRadius: 6, cursor: "pointer", color: "var(--text3)",
                    fontSize: "0.78rem", padding: "5px 12px", width: "100%",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                  }}
                >
                  <Plus size={12} /> Add step
                </button>
              </>
            ) : (
              (!test.steps || test.steps.length === 0) ? (
                <div style={{ color: "var(--text3)", fontSize: "0.875rem", padding: "20px 0" }}>
                  No steps defined for this test.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {test.steps.map((step, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 16,
                        padding: "12px 0",
                        borderBottom: idx < test.steps.length - 1 ? "1px solid var(--border)" : "none",
                      }}
                    >
                      {/* Step number */}
                      <div style={{
                        width: 26, height: 26, borderRadius: 6,
                        background: "var(--bg2)", border: "1px solid var(--border)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: "0.75rem", fontWeight: 700, color: "var(--text2)",
                        flexShrink: 0, marginTop: 1,
                      }}>
                        {idx + 1}
                      </div>
                      {/* Step text */}
                      <span style={{ fontSize: "0.875rem", color: "var(--text)", lineHeight: 1.6, paddingTop: 3 }}>
                        {step}
                      </span>
                    </div>
                  ))}
                </div>
              )
            )}

            {/* Playwright code block (collapsed) */}
            {test.playwrightCode && !editing && (
              <details style={{ marginTop: 16 }}>
                <summary style={{
                  cursor: "pointer", fontSize: "0.78rem", color: "var(--accent)",
                  fontWeight: 600, userSelect: "none", listStyle: "none",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <ChevronRight size={13} style={{ transition: "transform 0.2s" }} />
                  View generated Playwright code
                  {test.codeRegeneratedAt && (
                    <span style={{ fontSize: "0.68rem", color: "var(--green)", fontWeight: 500, marginLeft: 6 }}>
                      ✓ regenerated
                    </span>
                  )}
                </summary>
                <pre style={{
                  marginTop: 12, padding: 16,
                  background: "#0f1117", borderRadius: 8,
                  fontSize: "0.73rem", color: "#8b9cf4",
                  overflowX: "auto", lineHeight: 1.8, maxHeight: 360,
                  whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}>
                  {test.playwrightCode}
                </pre>
              </details>
            )}

            {/* Editing hint: code will be regenerated on save */}
            {editing && test.playwrightCode && (
              <div style={{
                marginTop: 14, padding: "8px 12px",
                background: "var(--accent-bg)", borderRadius: 6,
                border: "1px solid rgba(91,110,245,0.2)",
                fontSize: "0.78rem", color: "var(--accent)",
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <RefreshCw size={12} />
                Playwright code will be automatically regenerated from your updated steps when you save.
              </div>
            )}
          </div>

          {/* Recent Test Runs card */}
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 18, marginTop: 0 }}>
              Recent Test Runs
            </h2>

            {/* Run type icon legend */}
            <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
              {[
                { icon: "✓", color: "var(--green)",  label: "Passed" },
                { icon: "✗", color: "var(--red)",    label: "Failed" },
                { icon: "↺", color: "var(--blue)",   label: "Running" },
                { icon: "✎", color: "var(--text3)",  label: "Manual" },
              ].map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.73rem", color: "var(--text3)" }}>
                  <span style={{ color: item.color, fontSize: 13, fontWeight: 700 }}>{item.icon}</span>
                  {item.label}
                </div>
              ))}
            </div>

            {runs.length === 0 ? (
              <div style={{ padding: "32px 0", textAlign: "center", color: "var(--text3)", fontSize: "0.875rem" }}>
                This test hasn't been run yet.{" "}
                <button
                  className="btn btn-ghost btn-xs"
                  style={{ marginLeft: 4 }}
                  onClick={handleRunTest}
                  disabled={running}
                >
                  <Play size={11} /> Run now
                </button>
              </div>
            ) : (
              <table className="table" style={{ marginTop: 0 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>ACU Usage</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 10).map(run => {
                    const result = run.results?.find(r => r.testId === testId);
                    const status = result?.status || run.status;
                    const duration = result?.durationMs;
                    return (
                      <tr
                        key={run.id}
                        style={{ cursor: "pointer" }}
                        onClick={() => navigate(`/runs/${run.id}`)}
                      >
                        <td>
                          <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
                            {fmtDateTime(run.startedAt)}
                          </span>
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <RunIcon status={status} />
                            <span style={{ fontSize: "0.82rem", color: "var(--text2)", textTransform: "capitalize" }}>
                              {status || "—"}
                            </span>
                          </div>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
                            {duration ? (duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`) : "—"}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>0.00</span>
                        </td>
                        <td>
                          <ExternalLink size={12} color="var(--text3)" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* RIGHT SIDEBAR */}
        <div className="card" style={{ padding: 22 }}>
          <h3 style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: 20, marginTop: 0 }}>
            Test Information
          </h3>

          {/* Test ID */}
          <InfoRow label="Test ID">
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text2)", userSelect: "all" }}>
              {test.id}
            </span>
          </InfoRow>

          {/* Test type / review status */}
          <InfoRow label="Test type">
            <ReviewBadge status={test.reviewStatus} />
          </InfoRow>

          {/* Latest result */}
          <InfoRow label="Latest test result">
            <StatusBadge result={test.lastResult} />
          </InfoRow>

          {/* Author */}
          <InfoRow label="Author">
            <AvatarChip name={author} />
          </InfoRow>

          {/* Last modified by */}
          <InfoRow label="Last modified by">
            <AvatarChip name={author} />
          </InfoRow>

          {/* Created */}
          <InfoRow label="Created" icon={<Calendar size={14} />}>
            <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
              {fmtDate(test.createdAt)}
            </span>
          </InfoRow>

          {/* Last modified */}
          <InfoRow label="Last modified" icon={<Calendar size={14} />}>
            <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
              {fmtDate(test.reviewedAt || test.createdAt)}
            </span>
          </InfoRow>

          {/* Last run */}
          {test.lastRunAt && (
            <InfoRow label="Last run" icon={<Clock size={14} />}>
              <span style={{ fontSize: "0.82rem", color: "var(--text2)" }}>
                {fmtDateTime(test.lastRunAt)}
              </span>
            </InfoRow>
          )}

          {/* Divider */}
          <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0 18px" }} />

          {/* Source URL */}
          {test.sourceUrl && (
            <InfoRow label="Source URL">
              <a
                href={test.sourceUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: "0.75rem", color: "var(--accent)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}
              >
                {test.sourceUrl.replace(/^https?:\/\/[^/]+/, "") || "/"}
                <ExternalLink size={10} style={{ marginLeft: 4, verticalAlign: "middle" }} />
              </a>
            </InfoRow>
          )}

          {/* Priority */}
          <InfoRow label="Priority">
            {editing ? (
              <select
                className="input"
                value={editPriority}
                onChange={e => setEditPriority(e.target.value)}
                style={{ height: 32, fontSize: "0.82rem", width: "auto" }}
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            ) : (
              <span className={`badge ${
                test.priority === "high"   ? "badge-red" :
                test.priority === "medium" ? "badge-amber" : "badge-gray"
              }`}>
                {test.priority || "medium"}
              </span>
            )}
          </InfoRow>

          {/* Type */}
          {test.type && (
            <InfoRow label="Type">
              <span className="badge badge-blue">{test.type}</span>
            </InfoRow>
          )}

          {/* Tags */}
          {(test.isJourneyTest || test.scenario) && (
            <InfoRow label="Tags">
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {test.isJourneyTest && <span className="badge badge-purple">Journey</span>}
                {test.scenario === "positive"  && <span className="badge badge-green">Positive</span>}
                {test.scenario === "negative"  && <span className="badge badge-red">Negative</span>}
                {test.scenario === "edge_case" && <span className="badge badge-amber">Edge Case</span>}
              </div>
            </InfoRow>
          )}

          {/* Quick actions */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginTop: 4, display: "flex", flexDirection: "column", gap: 8 }}>
            {test.reviewStatus !== "approved" && (
              <button
                className="btn btn-sm"
                style={{ width: "100%", background: "var(--green-bg)", color: "var(--green)", border: "1px solid #86efac", justifyContent: "center" }}
                onClick={() => api.approveTest(test.projectId, testId).then(load)}
              >
                <CheckCircle2 size={13} /> Approve Test
              </button>
            )}
            {test.reviewStatus === "approved" && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ width: "100%", justifyContent: "center" }}
                onClick={() => api.restoreTest(test.projectId, testId).then(load)}
              >
                <RotateCcw size={13} /> Move to Draft
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={handleRunTest}
              disabled={running}
            >
              {running ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
              Run This Test
            </button>
            <button
              className="btn btn-ghost btn-sm"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => navigate(`/projects/${test.projectId}`)}
            >
              View Project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

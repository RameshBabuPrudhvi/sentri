import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Play, Edit2, RefreshCw, Download,
  CheckCircle2, XCircle, Clock,
  ChevronRight, Calendar, GitCommit,
  RotateCcw, ExternalLink, X, Plus, Save, GitMerge,
  Link2, Tag, Clipboard, Wand2,
} from "lucide-react";
import { api } from "../api.js";
import DiffView from "../components/DiffView.jsx";
import { cleanTestName } from "../utils/formatTestName.js";
import { testTypeBadgeClass, testTypeLabel, isBddTest } from "../utils/testTypeLabels.js";
import { exportCsv } from "../utils/exportCsv.js";
import { StatusBadge, ReviewBadge, ScenarioBadges } from "../components/TestBadges.jsx";
import { fmtDate, fmtDateTime } from "../utils/formatters.js";
import highlightCode from "../utils/highlightCode.js";
import playwrightToCurl from "../utils/playwrightToCurl.js";
import splitCodeBySteps from "../utils/splitCodeBySteps.js";
import CodeEditorModal from "../components/test/CodeEditorModal.jsx";
import AiFixPanel from "../components/AiFixPanel.jsx";

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
      <div className="td-info-label">
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

  // ── Traceability fields (inline editing) ──────────────────────────────────
  const [editingIssueKey, setEditingIssueKey] = useState(false);
  const [issueKeyDraft, setIssueKeyDraft]     = useState("");
  const [editingTags, setEditingTags]         = useState(false);
  const [tagsDraft, setTagsDraft]             = useState("");

  // ── Steps / Source tab toggle ────────────────────────────────────────────
  const [stepsView, setStepsView] = useState("steps"); // "steps" | "source"
  const [showDiff,  setShowDiff]  = useState(false);   // show code diff when playwrightCodePrev exists
  const [curlCopied, setCurlCopied] = useState(null);  // index of step whose cURL was just copied

  // ── Code editor modal state ──────────────────────────────────────────────
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);
  const [codeEditorInitial, setCodeEditorInitial] = useState(null); // pre-fill code for editor

  // ── AI fix panel state ──────────────────────────────────────────────────
  const [showFixPanel, setShowFixPanel] = useState(false);

  // ── Code regeneration review state ──────────────────────────────────────
  const [codePreview, setCodePreview] = useState(null); // { generatedCode, originalCode }
  const [applyingPreview, setApplyingPreview] = useState(false);

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

  // ── Inline code editing state ─────────────────────────────────────────
  const [editCode, setEditCode] = useState("");
  const [codeEdited, setCodeEdited] = useState(false); // tracks if user manually touched code
  const inlineEditorRef = useRef(null);
  const inlineHighlightRef = useRef(null);
  const inlineLineNumRef = useRef(null);

  function startEditing() {
    setEditName(test.name || "");
    setEditDesc(test.description || "");
    setEditSteps([...(test.steps || [])]);
    setEditPriority(test.priority || "medium");
    setEditCode(test.playwrightCode || "");
    setCodeEdited(false);
    setEditError(null);
    setEditing(true);
    setStepsView("steps");
  }

  async function handleSaveEdit() {
    if (!editName.trim()) { setEditError("Test name is required."); return; }
    setSaving(true);
    setEditError(null);
    try {
      const cleanSteps = editSteps.filter(s => s.trim());

      const payload = {
        name: editName.trim(),
        description: editDesc.trim(),
        steps: cleanSteps,
        priority: editPriority,
      };

      if (codeEdited && editCode.trim()) {
        // User manually edited code — save it directly, skip AI regeneration
        payload.playwrightCode = editCode;
      } else if (test.playwrightCode) {
        // Steps may have changed — request a code preview for review
        payload.previewCode = true;
      }

      const updated = await api.updateTest(testId, payload);
      setTest(updated);
      setEditing(false);
      setStepsView("steps");

      // If the backend returned a code preview, show the review panel
      if (updated._codePreview) {
        setCodePreview(updated._codePreview);
      }
    } catch (err) {
      setEditError(err.message || "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAcceptPreview() {
    if (!codePreview?.generatedCode || applyingPreview) return;
    setApplyingPreview(true);
    try {
      const updated = await api.updateTest(testId, {
        playwrightCode: codePreview.generatedCode,
      });
      setTest(updated);
      setCodePreview(null);
    } catch (err) {
      setEditError(err.message || "Failed to apply generated code.");
    } finally {
      setApplyingPreview(false);
    }
  }

  function handleEditPreview() {
    // Open the code editor pre-filled with the generated code
    setCodeEditorInitial(codePreview.generatedCode);
    setCodeEditorOpen(true);
    setCodePreview(null);
  }

  function handleDiscardPreview() {
    setCodePreview(null);
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

    const projectName = project?.name || "";
    const projectUrl  = project?.url  || "";
    const exportedAt  = new Date().toISOString();
    const steps       = (test.steps || []).length > 0 ? test.steps : [""];

    const runHistory = runs.slice(0, 20).map(run => {
      const result = run.results?.find(r => r.testId === testId);
      return {
        runId:      run.id,
        status:     result?.status || run.status,
        durationMs: result?.durationMs ?? "",
        startedAt:  run.startedAt || "",
      };
    });

    // Industry standard: Test ID | Name | Description | Step # | Step |
    // Project | Priority | Type | Review Status | Status | Last Run At |
    // Created At | Source URL | Journey | Run ID | Run Status | Duration (ms) | Run Started At | Exported At
    const headers = [
      "Test ID", "Name", "Description", "Step #", "Step",
      "Project", "Priority", "Type", "Review Status",
      "Status", "Last Run At", "Created At", "Source URL", "Journey",
      "Run ID", "Run Status", "Run Duration (ms)", "Run Started At", "Exported At",
    ];

    const rows = [];
    steps.forEach((step, stepIdx) => {
      // Repeat run history per step row — if no runs, emit one row per step
      const runs_ = runHistory.length > 0 ? runHistory : [null];
      runs_.forEach((rh, rhIdx) => {
        rows.push([
          stepIdx === 0 && rhIdx === 0 ? test.id                                    : "",
          stepIdx === 0 && rhIdx === 0 ? cleanTestName(test.name)                   : "",
          stepIdx === 0 && rhIdx === 0 ? (test.description || "")                   : "",
          step ? stepIdx + 1 : "",
          step || "",
          stepIdx === 0 && rhIdx === 0 ? projectName                                : "",
          stepIdx === 0 && rhIdx === 0 ? (test.priority || "medium")                : "",
          stepIdx === 0 && rhIdx === 0 ? (test.type || "")                          : "",
          stepIdx === 0 && rhIdx === 0 ? (test.reviewStatus || "draft")             : "",
          stepIdx === 0 && rhIdx === 0 ? (test.lastResult || "")                    : "",
          stepIdx === 0 && rhIdx === 0 ? (test.lastRunAt || "")                     : "",
          stepIdx === 0 && rhIdx === 0 ? (test.createdAt || "")                     : "",
          stepIdx === 0 && rhIdx === 0 ? (test.sourceUrl || projectUrl || "")       : "",
          stepIdx === 0 && rhIdx === 0 ? (test.isJourneyTest ? "Yes" : "No")        : "",
          rh ? rh.runId      : "",
          rh ? rh.status     : "",
          rh ? rh.durationMs : "",
          rh ? rh.startedAt  : "",
          stepIdx === 0 && rhIdx === 0 ? exportedAt : "",
        ]);
      });
    });

    const filename = `sentri-test-${cleanTestName(test.name || "export").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    exportCsv(headers, rows, filename);
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
        {/* Breadcrumb: Project > Tests > Test Details (when project is known) */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.82rem", color: "var(--text3)" }}>
          {project ? (
            <>
              <button
                onClick={() => navigate(`/projects/${test.projectId}`)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", display: "flex", alignItems: "center", gap: 4, padding: 0, fontSize: "0.82rem" }}
              >
                {project.name}
              </button>
              <ChevronRight size={13} />
              <button
                onClick={() => navigate(`/projects/${test.projectId}`)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 0, fontSize: "0.82rem" }}
              >
                Tests
              </button>
            </>
          ) : (
            <button
              onClick={() => navigate("/tests")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", display: "flex", alignItems: "center", gap: 4, padding: 0, fontSize: "0.82rem" }}
            >
              Tests
            </button>
          )}
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
                {saving ? (test.playwrightCode && !codeEdited ? "Saving & generating preview…" : "Saving…") : "Save Changes"}
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
              {/* Show "Fix with AI" when the test's lastResult is "failed" OR
                  when the most recent run result for this test is "failed" (covers
                  the case where the page was loaded before lastResult was flushed
                  to SQLite, e.g. navigating from a just-finished run). */}
              {(() => {
                const latestRunResult = runs[0]?.results?.find(r => r.testId === testId);
                const isFailed = test.lastResult === "failed" || latestRunResult?.status === "failed";
                return isFailed && test.playwrightCode && !showFixPanel ? (
                  <button
                    className="btn btn-sm"
                    style={{
                      background: "var(--accent-bg)", color: "var(--accent)",
                      border: "1px solid rgba(91,110,245,0.3)", fontWeight: 600,
                    }}
                    onClick={() => setShowFixPanel(true)}
                  >
                    <Wand2 size={14} /> Fix with AI
                  </button>
                ) : null;
              })()}
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
          {cleanTestName(test.name)}
        </h1>
      )}

      {/* ── Two-column layout ────────────────────────────────────────────── */}
      <div className="td-layout">

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
            {/* ── Card header with Steps / Source tab toggle ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: "var(--bg2)", border: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <CheckCircle2 size={14} color="var(--text2)" />
              </div>
              <h2 style={{ fontWeight: 700, fontSize: "1rem", margin: 0, flex: 1 }}>Test Steps</h2>

              {/* Steps / Source pill toggle — always shown when code exists */}
              {test.playwrightCode && (
                <div style={{
                  display: "flex", alignItems: "center",
                  background: "var(--bg2)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: 3, gap: 2,
                }}>
                  {/* Steps pill */}
                  <button
                    onClick={() => setStepsView("steps")}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "5px 12px", borderRadius: 6, border: "none",
                      cursor: "pointer", fontSize: "0.74rem", fontWeight: 600,
                      transition: "all 0.15s",
                      background: stepsView === "steps" ? "var(--surface)" : "transparent",
                      color:      stepsView === "steps" ? "var(--text)"    : "var(--text3)",
                      boxShadow:  stepsView === "steps" ? "0 1px 4px rgba(0,0,0,0.10)" : "none",
                    }}
                  >
                    <CheckCircle2 size={12} />
                    Steps
                  </button>
                  {/* Source pill — toggles inline code view (editable in edit mode) */}
                  <button
                    onClick={() => setStepsView(stepsView === "source" ? "steps" : "source")}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "5px 12px", borderRadius: 6, border: "none",
                      cursor: "pointer", fontSize: "0.74rem", fontWeight: 600,
                      transition: "all 0.15s",
                      background: stepsView === "source" ? "var(--surface)" : "transparent",
                      color:      stepsView === "source" ? "var(--accent)"  : "var(--text3)",
                      boxShadow:  stepsView === "source" ? "0 1px 4px rgba(0,0,0,0.10)" : "none",
                    }}
                  >
                    {"</>"} Source
                    {editing && codeEdited && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} title="Code edited" />}
                  </button>
                </div>
              )}

              {/* Copy as cURL — only shown for API tests in view mode */}
              {test.playwrightCode && !editing && test.isApiTest && (
                <button
                  onClick={async () => {
                    const curl = playwrightToCurl(test.playwrightCode);
                    if (!curl) return;
                    try {
                      await navigator.clipboard.writeText(curl);
                      setCurlCopied(true);
                      setTimeout(() => setCurlCopied(false), 2000);
                    } catch { /* ignore */ }
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "5px 10px", borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: curlCopied ? "var(--green-bg)" : "var(--bg2)",
                    color: curlCopied ? "var(--green)" : "var(--text3)",
                    fontSize: "0.72rem", fontWeight: 600, cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                  title="Copy all API calls as cURL commands (paste into Postman, Insomnia, or terminal)"
                >
                  {curlCopied ? <CheckCircle2 size={11} /> : <Clipboard size={11} />}
                  {curlCopied ? "Copied!" : "Copy as cURL"}
                </button>
              )}

              {/* Show changes — only when a regenerated previous version exists */}
              {test.playwrightCodePrev && !editing && (
                <button
                  onClick={() => setShowDiff(v => !v)}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "5px 10px", borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: showDiff ? "var(--accent-bg)" : "var(--bg2)",
                    color: showDiff ? "var(--accent)" : "var(--text3)",
                    fontSize: "0.72rem", fontWeight: 600, cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  <GitMerge size={11} />
                  {showDiff ? "Hide diff" : "Show changes"}
                </button>
              )}
            </div>

            {/* ── Edit mode ── */}
            {editing && stepsView === "source" && test.playwrightCode ? (
              /* ── Inline code editor (edit mode + Source tab) ── */
              <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #1e2130" }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 12px",
                  background: "#0d0f17", borderBottom: "1px solid #1e2130",
                  fontSize: "0.7rem", color: "#4a5070",
                }}>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{editCode.split("\n").length} lines</span>
                  <span>·</span>
                  <span>Tab inserts 2 spaces</span>
                  {codeEdited && <span style={{ marginLeft: "auto", color: "#f59e0b", fontWeight: 600 }}>● Modified</span>}
                </div>
                <div style={{ display: "flex", background: "#13151c", minHeight: 280, maxHeight: 500 }}>
                  <div
                    ref={inlineLineNumRef}
                    style={{
                      padding: "14px 0", minWidth: 44, flexShrink: 0,
                      textAlign: "right",
                      fontFamily: "'Fira Code', 'Cascadia Code', monospace",
                      fontSize: "0.76rem", lineHeight: 1.75,
                      color: "#3a3f5c", borderRight: "1px solid #1e2130",
                      userSelect: "none", overflow: "hidden",
                    }}
                  >
                    {editCode.split("\n").map((_, i) => (
                      <div key={i} style={{ padding: "0 10px" }}>{i + 1}</div>
                    ))}
                  </div>
                  <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                    <pre
                      ref={inlineHighlightRef}
                      aria-hidden="true"
                      style={{
                        position: "absolute", inset: 0,
                        margin: 0, padding: "14px 16px",
                        fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
                        fontSize: "0.76rem", lineHeight: 1.75,
                        color: "#cdd5f0", whiteSpace: "pre", overflow: "auto",
                        pointerEvents: "none", background: "transparent",
                        border: "none", outline: "none",
                      }}
                      dangerouslySetInnerHTML={{ __html: highlightCode(editCode) + "\n" }}
                    />
                    <textarea
                      ref={inlineEditorRef}
                      value={editCode}
                      onChange={e => { setEditCode(e.target.value); setCodeEdited(true); }}
                      onScroll={e => {
                        if (inlineHighlightRef.current) inlineHighlightRef.current.scrollTop = e.target.scrollTop;
                        if (inlineLineNumRef.current) inlineLineNumRef.current.scrollTop = e.target.scrollTop;
                      }}
                      onKeyDown={e => {
                        if (e.key === "Tab") {
                          e.preventDefault();
                          const ta = e.target;
                          const start = ta.selectionStart;
                          const end = ta.selectionEnd;
                          const newVal = ta.value.substring(0, start) + "  " + ta.value.substring(end);
                          setEditCode(newVal);
                          setCodeEdited(true);
                          requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
                        }
                      }}
                      spellCheck={false}
                      style={{
                        position: "absolute", inset: 0,
                        width: "100%", height: "100%",
                        background: "transparent", color: "transparent",
                        fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
                        fontSize: "0.76rem", lineHeight: 1.75,
                        padding: "14px 16px", border: "none", outline: "none",
                        resize: "none", boxSizing: "border-box",
                        caretColor: "#7c6af5", tabSize: 2,
                        whiteSpace: "pre", overflow: "auto",
                      }}
                      aria-label="Inline code editor"
                    />
                  </div>
                </div>
              </div>
            ) : editing ? (
              /* ── Step editor (edit mode + Steps tab) ── */
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
            ) : stepsView === "source" && test.playwrightCode ? (
              /* ── SOURCE view: numbered steps each with their code block ── */
              (() => {
                const stepChunks = splitCodeBySteps(test.playwrightCode, (test.steps || []).length, test.steps);
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    {/* Diff panel — shown above source when "Show changes" is active */}
                    {showDiff && test.playwrightCodePrev && (
                      <div style={{ marginBottom: 16 }}>
                        <DiffView
                          before={test.playwrightCodePrev}
                          after={test.playwrightCode}
                        />
                      </div>
                    )}
                    {(test.steps || []).map((step, idx) => (
                      <div key={idx} style={{
                        borderBottom: idx < (test.steps.length - 1) ? "1px solid var(--border)" : "none",
                        paddingBottom: 16, marginBottom: idx < (test.steps.length - 1) ? 16 : 0,
                      }}>
                        {/* Step label row */}
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                          <div style={{
                            width: 22, height: 22, borderRadius: "50%",
                            background: "var(--accent-bg)", border: "1px solid rgba(91,110,245,0.3)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: "0.65rem", fontWeight: 700, color: "var(--accent)",
                            flexShrink: 0,
                          }}>
                            {idx + 1}
                          </div>
                          <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text)" }}>
                            {step}
                          </span>
                        </div>
                        {/* Code block */}
                        {stepChunks[idx] ? (
                          <div style={{
                            background: "#13151c",
                            borderRadius: 8,
                            border: "1px solid #1e2130",
                            overflow: "hidden",
                          }}>
                            <pre style={{
                              margin: 0,
                              padding: "14px 16px",
                              fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
                              fontSize: "0.76rem",
                              lineHeight: "1.75",
                              color: "#cdd5f0",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              overflowX: "auto",
                            }}
                              dangerouslySetInnerHTML={{ __html: highlightCode(stepChunks[idx]) }}
                            />
                          </div>
                        ) : (
                          <div style={{ fontSize: "0.76rem", color: "var(--text3)", fontStyle: "italic", paddingLeft: 32 }}>
                            No code for this step.
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()
            ) : (
              /* ── STEPS view (default) ── */
              (!test.steps || test.steps.length === 0) ? (
                <div style={{ color: "var(--text3)", fontSize: "0.875rem", padding: "20px 0" }}>
                  No steps defined for this test.
                </div>
              ) : (
                (() => {
                  const bdd = isBddTest(test.steps);
                  const gherkinKw = /^(Given|When|Then|And|But)\b/i;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                      {test.steps.map((step, idx) => {
                        const trimmed = (step || "").trim();
                        const kwMatch = bdd ? trimmed.match(gherkinKw) : null;
                        const keyword = kwMatch ? kwMatch[1] : null;
                        const rest = keyword ? trimmed.slice(keyword.length) : trimmed;
                        return (
                          <div
                            key={idx}
                            style={{
                              display: "flex", alignItems: "flex-start", gap: 16,
                              padding: "12px 0",
                              borderBottom: idx < test.steps.length - 1 ? "1px solid var(--border)" : "none",
                            }}
                          >
                            <div style={{
                              width: 26, height: 26, borderRadius: 6,
                              background: bdd ? "var(--accent-bg)" : "var(--bg2)",
                              border: bdd ? "1px solid rgba(91,110,245,0.3)" : "1px solid var(--border)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: "0.75rem", fontWeight: 700,
                              color: bdd ? "var(--accent)" : "var(--text2)",
                              flexShrink: 0, marginTop: 1,
                            }}>
                              {idx + 1}
                            </div>
                            <span style={{ fontSize: "0.875rem", color: "var(--text)", lineHeight: 1.6, paddingTop: 3 }}>
                              {keyword ? (
                                <>
                                  <span style={{
                                    fontWeight: 700, color: "var(--accent)",
                                    fontFamily: "var(--font-mono)", fontSize: "0.82rem",
                                    letterSpacing: "0.01em",
                                  }}>
                                    {keyword}
                                  </span>
                                  {rest}
                                </>
                              ) : step}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              )
            )}

            {/* Editing hint: code regeneration + source tab access */}
            {editing && test.playwrightCode && stepsView === "steps" && (
              <div style={{
                marginTop: 14, padding: "8px 12px",
                background: "var(--accent-bg)", borderRadius: 6,
                border: "1px solid rgba(91,110,245,0.2)",
                fontSize: "0.78rem", color: "var(--accent)",
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <RefreshCw size={12} />
                Code will be regenerated on save — you'll review changes before applying. Switch to <strong>Source</strong> to edit code directly.
              </div>
            )}
          </div>

          {/* Code Regeneration Review Panel */}
          {codePreview && (
            <div className="card" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--accent)", borderRadius: 10 }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "12px 16px",
                background: "var(--accent-bg)",
                borderBottom: "1px solid rgba(91,110,245,0.2)",
              }}>
                <RefreshCw size={15} color="var(--accent)" />
                <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--accent)", flex: 1 }}>
                  Code Regenerated — Review Changes
                </span>
                <button onClick={handleDiscardPreview} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 4, display: "flex" }} title="Discard">
                  <X size={15} />
                </button>
              </div>
              <div style={{ padding: "10px 16px", fontSize: "0.82rem", color: "var(--text2)", background: "var(--bg2)", borderBottom: "1px solid var(--border)" }}>
                The AI updated the Playwright code to match your new steps. Review the diff below, then accept, edit, or discard.
              </div>
              <div style={{ padding: "12px 16px" }}>
                <DiffView before={codePreview.originalCode || ""} after={codePreview.generatedCode} />
              </div>
              <div style={{
                display: "flex", gap: 8, padding: "12px 16px",
                borderTop: "1px solid var(--border)",
                justifyContent: "flex-end",
              }}>
                <button className="btn btn-ghost btn-sm" onClick={handleDiscardPreview} disabled={applyingPreview}>
                  <X size={13} /> Discard
                </button>
                <button className="btn btn-ghost btn-sm" onClick={handleEditPreview} disabled={applyingPreview}>
                  <Edit2 size={13} /> Edit Code
                </button>
                <button className="btn btn-primary btn-sm" onClick={handleAcceptPreview} disabled={applyingPreview}>
                  {applyingPreview
                    ? <><RefreshCw size={13} className="spin" /> Applying…</>
                    : <><CheckCircle2 size={13} /> Accept</>
                  }
                </button>
              </div>
            </div>
          )}

          {/* AI Fix Panel */}
          {showFixPanel && test.playwrightCode && (
            <AiFixPanel
              testId={testId}
              originalCode={test.playwrightCode}
              onApplied={(updated) => {
                setTest(updated);
                setShowFixPanel(false);
              }}
              onClose={() => setShowFixPanel(false)}
            />
          )}

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

        {/* ── Code Editor Modal ───────────────────────────────────────────── */}
        {codeEditorOpen && (
          <CodeEditorModal
            test={test}
            testId={testId}
            initialCode={codeEditorInitial}
            onClose={() => { setCodeEditorOpen(false); setCodeEditorInitial(null); setEditing(false); }}
            onSaved={(updated) => { setTest(updated); setCodeEditorInitial(null); setEditing(false); }}
          />
        )}

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
            <span className="text-sm text-sub">{fmtDate(test.createdAt)}</span>
          </InfoRow>

          {/* Last modified */}
          <InfoRow label="Last modified" icon={<Calendar size={14} />}>
            <span className="text-sm text-sub">{fmtDate(test.reviewedAt || test.createdAt)}</span>
          </InfoRow>

          {/* Last run */}
          {test.lastRunAt && (
            <InfoRow label="Last run" icon={<Clock size={14} />}>
              <span className="text-sm text-sub">{fmtDateTime(test.lastRunAt)}</span>
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
              <span className={`badge ${testTypeBadgeClass(test.type)}`}>
                {testTypeLabel(test.type)}
              </span>
            </InfoRow>
          )}

          {/* Tags */}
          {(test.isJourneyTest || test.scenario || isBddTest(test.steps)) && (
            <InfoRow label="Tags">
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                <ScenarioBadges test={test} isBddTest={isBddTest} />
              </div>
            </InfoRow>
          )}

          {/* Linked Issue */}
          <InfoRow label="Linked Issue" icon={<Link2 size={14} />}>
            {editingIssueKey ? (
              <div style={{ display: "flex", gap: 4, flex: 1 }}>
                <input
                  className="input"
                  value={issueKeyDraft}
                  onChange={e => setIssueKeyDraft(e.target.value)}
                  placeholder="PROJ-123"
                  style={{ height: 28, fontSize: "0.78rem", flex: 1, fontFamily: "var(--font-mono)" }}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      api.updateTest(testId, { linkedIssueKey: issueKeyDraft.trim() }).then(t => { setTest(t); setEditingIssueKey(false); });
                    }
                    if (e.key === "Escape") setEditingIssueKey(false);
                  }}
                />
                <button className="btn btn-xs" style={{ background: "var(--green-bg)", color: "var(--green)", border: "1px solid #86efac" }}
                  onClick={() => api.updateTest(testId, { linkedIssueKey: issueKeyDraft.trim() }).then(t => { setTest(t); setEditingIssueKey(false); })}>
                  <Save size={10} />
                </button>
                <button className="btn btn-ghost btn-xs" onClick={() => setEditingIssueKey(false)}>
                  <X size={10} />
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
                {test.linkedIssueKey ? (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--accent)", fontWeight: 500 }}>
                    {test.linkedIssueKey}
                  </span>
                ) : (
                  <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>Not linked</span>
                )}
                <button
                  className="btn btn-ghost btn-xs"
                  style={{ marginLeft: "auto", padding: "2px 6px" }}
                  onClick={() => { setIssueKeyDraft(test.linkedIssueKey || ""); setEditingIssueKey(true); }}
                >
                  <Edit2 size={10} />
                </button>
              </div>
            )}
          </InfoRow>

          {/* Tags */}
          <InfoRow label="Tags" icon={<Tag size={14} />}>
            {editingTags ? (
              <div style={{ display: "flex", gap: 4, flex: 1 }}>
                <input
                  className="input"
                  value={tagsDraft}
                  onChange={e => setTagsDraft(e.target.value)}
                  placeholder="smoke, regression, login"
                  style={{ height: 28, fontSize: "0.78rem", flex: 1 }}
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      const tags = tagsDraft.split(",").map(t => t.trim()).filter(Boolean);
                      api.updateTest(testId, { tags }).then(t => { setTest(t); setEditingTags(false); });
                    }
                    if (e.key === "Escape") setEditingTags(false);
                  }}
                />
                <button className="btn btn-xs" style={{ background: "var(--green-bg)", color: "var(--green)", border: "1px solid #86efac" }}
                  onClick={() => {
                    const tags = tagsDraft.split(",").map(t => t.trim()).filter(Boolean);
                    api.updateTest(testId, { tags }).then(t => { setTest(t); setEditingTags(false); });
                  }}>
                  <Save size={10} />
                </button>
                <button className="btn btn-ghost btn-xs" onClick={() => setEditingTags(false)}>
                  <X size={10} />
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, flexWrap: "wrap" }}>
                {(test.tags || []).length > 0 ? (
                  test.tags.map((tag, i) => (
                    <span key={i} className="badge badge-gray" style={{ fontSize: "0.7rem" }}>{tag}</span>
                  ))
                ) : (
                  <span style={{ fontSize: "0.78rem", color: "var(--text3)" }}>No tags</span>
                )}
                <button
                  className="btn btn-ghost btn-xs"
                  style={{ marginLeft: "auto", padding: "2px 6px" }}
                  onClick={() => { setTagsDraft((test.tags || []).join(", ")); setEditingTags(true); }}
                >
                  <Edit2 size={10} />
                </button>
              </div>
            )}
          </InfoRow>

          {/* Prompt version / model (read-only, shown if available) */}
          {test.promptVersion && (
            <InfoRow label="Generated by">
              <span style={{ fontSize: "0.78rem", color: "var(--text2)" }}>
                {test.modelUsed || "AI"} · prompt v{test.promptVersion}
              </span>
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
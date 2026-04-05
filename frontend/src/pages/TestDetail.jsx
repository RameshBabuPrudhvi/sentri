import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Play, Edit2, RefreshCw, Download,
  CheckCircle2, XCircle, Clock, AlertCircle,
  ChevronRight, Calendar, User, GitCommit,
  RotateCcw, ExternalLink, X, Plus, Save, Code2, GitMerge,
} from "lucide-react";
import { api } from "../api.js";
import DiffView from "../components/DiffView.jsx";
import { cleanTestName } from "../utils/formatTestName.js";
import { testTypeBadgeClass, testTypeLabel } from "../utils/testTypeLabels.js";
import { exportCsv } from "../utils/exportCsv.js";

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

// ── Playwright syntax highlighter ─────────────────────────────────────────────
// Tokenises the code first so strings/comments are never double-highlighted.
function highlightCode(code) {
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Tokenise: pull out comments, strings, and template literals first
  const TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  const tokens = [];
  let last = 0;
  let m;
  while ((m = TOKEN_RE.exec(code)) !== null) {
    if (m.index > last) tokens.push({ type: "code", text: code.slice(last, m.index) });
    const raw = m[0];
    tokens.push({ type: raw.startsWith("//") || raw.startsWith("/*") ? "comment" : "string", text: raw });
    last = m.index + raw.length;
  }
  if (last < code.length) tokens.push({ type: "code", text: code.slice(last) });

  const KEYWORDS = /\b(import|export|from|const|let|var|async|await|return|if|else|true|false|null|undefined|new|typeof|instanceof|of|in|for|while|do|switch|case|break|continue|throw|try|catch|finally|class|extends|default)\b/g;
  const GLOBALS  = /\b(test|expect|describe|beforeAll|afterAll|beforeEach|afterEach|page|context|browser|request)\b/g;
  const METHODS  = /\.([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*\()/g;
  const NUMBERS  = /\b(\d+)\b/g;
  const ARROWS   = /(=&gt;|===|!==|==|!=|\|\||&amp;&amp;)/g;

  function highlightFragment(text) {
    return escHtml(text)
      .replace(KEYWORDS, '<span style="color:#c792ea">$1</span>')
      .replace(GLOBALS,  '<span style="color:#82aaff">$1</span>')
      .replace(METHODS,  '.<span style="color:#82aaff">$1</span>$2')
      .replace(NUMBERS,  '<span style="color:#f78c6c">$1</span>')
      .replace(ARROWS,   '<span style="color:#89ddff">$1</span>');
  }

  return tokens.map(t => {
    if (t.type === "comment") return `<span style="color:#546174;font-style:italic">${escHtml(t.text)}</span>`;
    if (t.type === "string")  return `<span style="color:#c3e88d">${escHtml(t.text)}</span>`;
    return highlightFragment(t.text);
  }).join("");
}

// ── Main Page ─────────────────────────────────────────────────────────────────

// ── Split Playwright code into per-step chunks ────────────────────────────────
function splitCodeBySteps(code, stepCount) {
  if (!code || stepCount === 0) return [];

  // 1. Extract the test body from the async arrow function
  const arrowMatch = code.match(/async\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\{([\s\S]*)/);
  let body = code;
  if (arrowMatch) {
    const bodyAndRest = arrowMatch[1];
    let depth = 1, i = 0;
    for (; i < bodyAndRest.length && depth > 0; i++) {
      if (bodyAndRest[i] === "{") depth++;
      else if (bodyAndRest[i] === "}") depth--;
    }
    body = bodyAndRest.slice(0, i - 1).trim();
  }

  // 2. Split into non-empty lines
  const lines = body.split("\n").map(l => l.trimEnd()).filter(l => l.trim());
  if (lines.length === 0) return Array(stepCount).fill("");

  // 3. Distribute lines evenly; remainder goes into LAST bucket so no
  //    trailing step is ever left empty when lines < stepCount * baseSize
  const baseSize = Math.floor(lines.length / stepCount);
  const remainder = lines.length % stepCount;

  const chunks = [];
  let cursor = 0;
  for (let s = 0; s < stepCount; s++) {
    const take = baseSize + (s === stepCount - 1 ? remainder : 0);
    const slice = lines.slice(cursor, cursor + Math.max(take, 1));
    chunks.push(slice.join("\n"));
    cursor += Math.max(take, 1);
    if (cursor >= lines.length) {
      while (chunks.length < stepCount) chunks.push("");
      break;
    }
  }
  return chunks;
}

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

  // ── Steps / Source tab toggle ────────────────────────────────────────────
  const [stepsView, setStepsView] = useState("steps"); // "steps" | "source"
  const [showDiff,  setShowDiff]  = useState(false);   // show code diff when playwrightCodePrev exists

  // ── Code editor modal state ──────────────────────────────────────────────
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);
  const [editedCode, setEditedCode]         = useState("");
  const [codeSaving, setCodeSaving]         = useState(false);
  const [codeSaveError, setCodeSaveError]   = useState(null);
  const [codeSaveSuccess, setCodeSaveSuccess] = useState(false);
  const [cursorPos, setCursorPos]           = useState({ line: 1, col: 1 });
  const [copySuccess, setCopySuccess]       = useState(false);

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
        // Always regenerate Playwright code on save so the script stays
        // in sync with any changes to steps, name, or description.
        regenerateCode: true,
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

  function openCodeEditor() {
    setEditedCode(test.playwrightCode || "");
    setCodeSaveError(null);
    setCodeSaveSuccess(false);
    setCursorPos({ line: 1, col: 1 });
    setCopySuccess(false);
    setCodeEditorOpen(true);
  }

  const editorScrollRef = React.useRef(null);
  const lineNumRef = React.useRef(null);

  function handleCursorMove(e) {
    const ta = e.target;
    const text = ta.value.substring(0, ta.selectionStart);
    const lines = text.split("\n");
    setCursorPos({ line: lines.length, col: lines[lines.length - 1].length + 1 });
  }

  function handleEditorScroll(e) {
    const ta = e.target;
    if (editorScrollRef.current) editorScrollRef.current.scrollTop = ta.scrollTop;
    if (lineNumRef.current) lineNumRef.current.scrollTop = ta.scrollTop;
  }

  function handleTabKey(e) {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const newVal = val.substring(0, start) + "  " + val.substring(end);
      setEditedCode(newVal);
      // Restore cursor position after React re-render
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }

  async function handleCopyCode() {
    try {
      await navigator.clipboard.writeText(editedCode);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch { /* ignore */ }
  }

  function handleDownloadCode() {
    const filename = (test.name || "test").replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".spec.ts";
    const blob = new Blob([editedCode], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  async function handleSaveCode() {
    setCodeSaving(true);
    setCodeSaveError(null);
    setCodeSaveSuccess(false);
    try {
      const updated = await api.updateTest(testId, { playwrightCode: editedCode });
      setTest(updated);
      setCodeSaveSuccess(true);
      setTimeout(() => setCodeSaveSuccess(false), 2500);
    } catch (err) {
      setCodeSaveError(err.message || "Failed to save code.");
    } finally {
      setCodeSaving(false);
    }
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

    const steps = (test.steps || []).join(" | ");
    const projectName = project?.name || "";
    const projectUrl  = project?.url  || "";
    const exportedAt = new Date().toISOString();

    const headers = [
      "Test ID", "Name", "Description", "Type", "Priority",
      "Review Status", "Source URL", "Steps", "Last Result",
      "Last Run At", "Created At", "Project Name", "Project URL",
      "Run ID", "Run Status", "Run Duration (ms)", "Run Started At",
      "Exported At",
    ];

    const baseFields = [
      test.id, test.name, test.description || "", test.type || "",
      test.priority || "medium", test.reviewStatus || "draft",
      test.sourceUrl || "", steps, test.lastResult || "",
      test.lastRunAt || "", test.createdAt || "", projectName, projectUrl,
    ];

    const runHistory = runs.slice(0, 20).map(run => {
      const result = run.results?.find(r => r.testId === testId);
      return {
        runId: run.id,
        status: result?.status || run.status,
        durationMs: result?.durationMs ?? "",
        startedAt: run.startedAt || "",
      };
    });

    // One row per run-history entry; if no runs, emit a single row
    const rows = runHistory.length === 0
      ? [[ ...baseFields, "", "", "", "", exportedAt ]]
      : runHistory.map(rh => [ ...baseFields, rh.runId, rh.status, rh.durationMs, rh.startedAt, exportedAt ]);

    const filename = `sentri-test-${(test.name || "export").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
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
        {/* Breadcrumb */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.82rem", color: "var(--text3)" }}>
          <button
            onClick={() => navigate("/tests")}
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
          {cleanTestName(test.name)}
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

              {/* Steps / Source pill toggle — only shown in view mode with code present */}
              {test.playwrightCode && !editing && (
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
                  {/* Source pill */}
                  <button
                    onClick={() => setStepsView("source")}
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
                  </button>
                </div>
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
            ) : stepsView === "source" && test.playwrightCode ? (
              /* ── SOURCE view: numbered steps each with their code block ── */
              (() => {
                const stepChunks = splitCodeBySteps(test.playwrightCode, (test.steps || []).length);
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
                      <div style={{
                        width: 26, height: 26, borderRadius: 6,
                        background: "var(--bg2)", border: "1px solid var(--border)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: "0.75rem", fontWeight: 700, color: "var(--text2)",
                        flexShrink: 0, marginTop: 1,
                      }}>
                        {idx + 1}
                      </div>
                      <span style={{ fontSize: "0.875rem", color: "var(--text)", lineHeight: 1.6, paddingTop: 3 }}>
                        {step}
                      </span>
                    </div>
                  ))}
                </div>
              )
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

        {/* ── Code Editor Modal ───────────────────────────────────────────── */}
        {codeEditorOpen && (
          <div
            onClick={e => { if (e.target === e.currentTarget) setCodeEditorOpen(false); }}
            onKeyDown={e => { if (e.key === "Escape") setCodeEditorOpen(false); }}
            style={{
              position: "fixed", inset: 0, zIndex: 1000,
              background: "rgba(0,0,0,0.55)",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 24,
            }}
          >
            <div style={{
              width: "100%", maxWidth: 880, maxHeight: "90vh",
              display: "flex", flexDirection: "column",
              borderRadius: 12, overflow: "hidden",
              border: "1px solid #2a2d3e",
              boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
            }}>

              {/* ── Header ── */}
              <div style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "13px 18px",
                background: "var(--bg)",
                borderBottom: "1px solid var(--border)",
              }}>
                {/* Language pill */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "rgba(124,106,245,0.12)", border: "1px solid rgba(124,106,245,0.3)",
                  borderRadius: 6, padding: "4px 10px",
                  fontFamily: "var(--font-mono)", fontSize: "0.72rem",
                  fontWeight: 600, color: "#a89cf7",
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#7c6af5", flexShrink: 0, display: "inline-block" }} />
                  TypeScript
                </div>

                {/* Title */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "var(--text)" }}>
                    Playwright source code
                    {test.codeRegeneratedAt && (
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        background: "rgba(34,197,94,0.1)", color: "#22c55e",
                        fontSize: "0.68rem", borderRadius: 4, padding: "2px 7px", marginLeft: 8,
                      }}>✓ auto-generated</span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 2 }}>
                    {cleanTestName(test.name)}
                  </div>
                </div>

                {/* Icon buttons */}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {/* Copy */}
                  <button
                    onClick={handleCopyCode}
                    title="Copy code"
                    style={{
                      background: copySuccess ? "rgba(34,197,94,0.12)" : "none",
                      border: "none", cursor: "pointer",
                      color: copySuccess ? "#22c55e" : "var(--text3)",
                      padding: "6px 8px", borderRadius: 6,
                      display: "flex", alignItems: "center", gap: 5,
                      fontSize: "0.72rem", fontWeight: 500,
                      transition: "all 0.15s",
                    }}
                  >
                    {copySuccess ? <CheckCircle2 size={14} /> : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                        <path d="M11 5.5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5.5" stroke="currentColor" strokeWidth="1.2"/>
                      </svg>
                    )}
                    {copySuccess ? "Copied!" : "Copy"}
                  </button>

                  {/* Download */}
                  <button
                    onClick={handleDownloadCode}
                    title="Download .spec.ts"
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--text3)", padding: "6px 8px", borderRadius: 6,
                      display: "flex", alignItems: "center", gap: 5,
                      fontSize: "0.72rem", fontWeight: 500,
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                      <path d="M2 12h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                    Download
                  </button>

                  <div style={{ width: 1, height: 16, background: "var(--border)", margin: "0 4px" }} />

                  {/* Close */}
                  <button
                    onClick={() => setCodeEditorOpen(false)}
                    title="Close"
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--text3)", padding: 6, borderRadius: 6,
                      display: "flex", alignItems: "center",
                    }}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* ── Tab bar ── */}
              <div style={{
                display: "flex", alignItems: "center",
                padding: "0 16px",
                background: "#0d0f17",
                borderBottom: "1px solid #1e2130",
              }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "8px 14px",
                  fontSize: "0.72rem", fontFamily: "var(--font-mono)",
                  color: "#cdd5f0",
                  borderBottom: "2px solid #7c6af5",
                  userSelect: "none",
                }}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <rect x="2" y="2" width="12" height="12" rx="2" stroke="#7c6af5" strokeWidth="1.2"/>
                    <path d="M5 8h6M8 5v6" stroke="#7c6af5" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                  {(test.name || "test").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.spec.ts
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#7c6af5", display: "inline-block" }} />
                </div>
              </div>

              {/* ── Info bar ── */}
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 16px",
                background: "#10121a",
                borderBottom: "1px solid #1e2130",
              }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 5,
                  fontSize: "0.68rem", color: "#4a5070",
                }}>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{editedCode.split("\n").length} lines</span>
                  <span>·</span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>UTF-8</span>
                  <span>·</span>
                  <span>Tab inserts 2 spaces</span>
                </div>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
                  <kbd style={{
                    fontSize: "0.62rem", padding: "1px 5px", borderRadius: 3,
                    background: "#1e2130", border: "1px solid #2a2d3e", color: "#6b7394",
                    fontFamily: "var(--font-mono)",
                  }}>Esc</kbd>
                  <span style={{ fontSize: "0.65rem", color: "#4a5070" }}>to close</span>
                </div>
              </div>

              {/* ── Editor: line numbers + highlighted overlay ── */}
              <div style={{ display: "flex", background: "#13151c", flex: 1, overflow: "hidden", minHeight: 360 }}>
                {/* Line numbers */}
                <div
                  ref={lineNumRef}
                  style={{
                    padding: "14px 0",
                    minWidth: 48, flexShrink: 0,
                    textAlign: "right",
                    fontFamily: "'Fira Code', 'Cascadia Code', monospace",
                    fontSize: "0.78rem", lineHeight: "1.75",
                    color: "#3a3f5c",
                    borderRight: "1px solid #1e2130",
                    userSelect: "none",
                    overflow: "hidden",
                  }}
                >
                  {editedCode.split("\n").map((_, i) => (
                    <div key={i} style={{
                      padding: "0 10px",
                      color: i + 1 === cursorPos.line ? "#7c6af5" : "#3a3f5c",
                    }}>{i + 1}</div>
                  ))}
                </div>

                {/* Highlighted pre + transparent textarea overlay */}
                <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                  {/* Syntax-highlighted layer */}
                  <pre
                    ref={editorScrollRef}
                    aria-hidden="true"
                    style={{
                      position: "absolute", inset: 0,
                      margin: 0, padding: "14px 18px",
                      fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
                      fontSize: "0.78rem", lineHeight: "1.75",
                      color: "#cdd5f0",
                      whiteSpace: "pre", overflowX: "auto",
                      pointerEvents: "none",
                      background: "transparent",
                      border: "none", outline: "none",
                      overflow: "auto",
                    }}
                    dangerouslySetInnerHTML={{ __html: highlightCode(editedCode) + "\n" }}
                  />
                  {/* Transparent editable textarea on top */}
                  <textarea
                    value={editedCode}
                    onChange={e => setEditedCode(e.target.value)}
                    onClick={handleCursorMove}
                    onKeyUp={handleCursorMove}
                    onKeyDown={handleTabKey}
                    onScroll={handleEditorScroll}
                    spellCheck={false}
                    style={{
                      position: "absolute", inset: 0,
                      width: "100%", height: "100%",
                      background: "transparent", color: "transparent",
                      fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
                      fontSize: "0.78rem", lineHeight: "1.75",
                      padding: "14px 18px", border: "none", outline: "none",
                      resize: "none", boxSizing: "border-box",
                      caretColor: "#7c6af5",
                      tabSize: 2,
                      whiteSpace: "pre", overflowX: "auto",
                      overflow: "auto",
                    }}
                  />
                </div>
              </div>

              {/* ── Footer ── */}
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 16px",
                background: "var(--bg)",
                borderTop: "1px solid var(--border)",
              }}>
                {/* Status messages */}
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text3)" }}>
                    Ln {cursorPos.line}, Col {cursorPos.col}
                  </span>
                  <div style={{ width: 1, height: 12, background: "var(--border)" }} />
                  {codeSaveError ? (
                    <span style={{ fontSize: "0.75rem", color: "var(--red)" }}>{codeSaveError}</span>
                  ) : codeSaveSuccess ? (
                    <span style={{ fontSize: "0.75rem", color: "#22c55e", display: "flex", alignItems: "center", gap: 5 }}>
                      <CheckCircle2 size={13} /> Saved successfully
                    </span>
                  ) : (
                    <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                      Changes override auto-generated code
                    </span>
                  )}
                </div>

                {/* Actions */}
                <button
                  onClick={() => { setEditedCode(test.playwrightCode || ""); }}
                  style={{
                    background: "none", border: "1px solid var(--border)",
                    borderRadius: 6, cursor: "pointer", color: "var(--text2)",
                    padding: "6px 13px", fontSize: "0.78rem",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  <RotateCcw size={12} /> Discard
                </button>
                <button
                  onClick={() => setCodeEditorOpen(false)}
                  style={{
                    background: "none", border: "1px solid var(--border)",
                    borderRadius: 6, cursor: "pointer", color: "var(--text2)",
                    padding: "6px 13px", fontSize: "0.78rem",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  <X size={12} /> Close
                </button>
                <button
                  onClick={handleSaveCode}
                  disabled={codeSaving}
                  style={{
                    background: "#5b4bdd", border: "none",
                    borderRadius: 6, cursor: "pointer", color: "#fff",
                    padding: "6px 16px", fontSize: "0.78rem", fontWeight: 600,
                    display: "flex", alignItems: "center", gap: 6,
                    opacity: codeSaving ? 0.7 : 1,
                  }}
                >
                  {codeSaving ? <RefreshCw size={13} className="spin" /> : <Save size={13} />}
                  {codeSaving ? "Saving…" : "Save code"}
                </button>
              </div>

            </div>
          </div>
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
              <span className={`badge ${testTypeBadgeClass(test.type)}`}>
                {testTypeLabel(test.type)}
              </span>
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
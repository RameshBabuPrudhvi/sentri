import React, { useEffect, useState, useCallback, useRef, Suspense, lazy } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Play, Edit2, RefreshCw, Download,
  CheckCircle2, Clock,
  ChevronRight, Calendar, GitCommit,
  RotateCcw, ExternalLink, X, Plus, Save, GitMerge,
  Link2, Tag, Clipboard, Wand2, MoreHorizontal,
} from "lucide-react";
import { api } from "../api.js";
import { queryClient, testQueryKeys } from "../queryClient.js";
import { useTestDetailQuery } from "../hooks/queries/useTestDetailQuery.js";
const DiffView    = lazy(() => import("../components/ai/DiffView.jsx"));
const AiFixPanel  = lazy(() => import("../components/ai/AiFixPanel.jsx"));
import { cleanTestName } from "../utils/formatTestName.js";
import { testTypeBadgeClass, testTypeLabel, isBddTest } from "../utils/testTypeLabels.js";
import { exportCsv } from "../utils/exportCsv.js";
import { StatusBadge, ReviewBadge, ScenarioBadges } from "../components/shared/TestBadges.jsx";
import { fmtDate, fmtDateTime } from "../utils/formatters.js";
import highlightCode from "../utils/highlightCode.js";
import playwrightToCurl from "../utils/playwrightToCurl.js";
import splitCodeBySteps from "../utils/splitCodeBySteps.js";
import InlineCodeEditor from "../components/test/InlineCodeEditor.jsx";
import CodePreviewPanel from "../components/test/CodePreviewPanel.jsx";
import AiTestEditor from "../components/test/AiTestEditor.jsx";
import TablePagination, { PAGE_SIZE } from "../components/shared/TablePagination.jsx";

function RunIcon({ status }) {
  if (status === "passed" || status === "completed")
    return <span className="td-run-glyph td-run-glyph--pass">✓</span>;
  if (status === "failed")
    return <span className="td-run-glyph td-run-glyph--fail">✗</span>;
  if (status === "running")
    return <RefreshCw size={14} color="var(--blue)" className="spin" />;
  return <Clock size={14} color="var(--text3)" />;
}

function InfoRow({ icon, label, children }) {
  return (
    <div className="td-info-row">
      <div className="td-info-label">{label}</div>
      <div className="td-info-row-inner">
        {icon && <span className="td-info-icon">{icon}</span>}
        {children}
      </div>
    </div>
  );
}

function AvatarChip({ name }) {
  const initials = (name || "U").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="td-avatar-chip">
      <div className="td-avatar">{initials}</div>
      <span className="td-avatar-name">{name || "—"}</span>
    </div>
  );
}

export default function TestDetail() {
  const { testId } = useParams();
  const navigate = useNavigate();

  const detailQuery = useTestDetailQuery(testId);
  const test = detailQuery.data?.test ?? null;
  const project = detailQuery.data?.project ?? null;
  const runs = detailQuery.data?.runs ?? [];
  const loading = detailQuery.isLoading;
  const [running, setRunning] = useState(false);

  const setTest = useCallback((updater) => {
    queryClient.setQueryData(testQueryKeys.detail(testId), (prev) => {
      if (!prev) return prev;
      const nextTest = typeof updater === "function" ? updater(prev.test) : updater;
      return { ...prev, test: nextTest };
    });
  }, [testId]);

  const load = useCallback(
    () => queryClient.invalidateQueries({ queryKey: testQueryKeys.detail(testId) }),
    [testId],
  );

  const [editing, setEditing]           = useState(false);
  const [editName, setEditName]         = useState("");
  const [editDesc, setEditDesc]         = useState("");
  const [editSteps, setEditSteps]       = useState([]);
  const [editPriority, setEditPriority] = useState("medium");
  const [saving, setSaving]             = useState(false);
  const [editError, setEditError]       = useState(null);

  const [editingIssueKey, setEditingIssueKey] = useState(false);
  const [issueKeyDraft, setIssueKeyDraft]     = useState("");
  const [editingTags, setEditingTags]         = useState(false);
  const [tagsDraft, setTagsDraft]             = useState("");

  const [runPage, setRunPage]     = useState(1);
  const [stepsView, setStepsView] = useState("steps");
  const [showDiff, setShowDiff]   = useState(false);
  const [curlCopied, setCurlCopied] = useState(null);
  const [prevSteps, setPrevSteps] = useState(null);

  const [showFixPanel, setShowFixPanel] = useState(false);
  const [showAiEditor, setShowAiEditor] = useState(false);
  const [codePreview, setCodePreview]   = useState(null);
  const [applyingPreview, setApplyingPreview] = useState(false);
  const [regenWarning, setRegenWarning] = useState(null);
  const [editCode, setEditCode]         = useState("");
  const [codeEdited, setCodeEdited]     = useState(false);

  // ── More-actions dropdown ──
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);

  useEffect(() => {
    if (!moreOpen) return;
    function handleClick(e) {
      if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreOpen]);

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
    setPrevSteps(null);
    setShowDiff(false);
    setRegenWarning(null);
    setMoreOpen(false);
  }

  async function handleSaveEdit() {
    if (!editName.trim()) { setEditError("Test name is required."); return; }
    setSaving(true); setEditError(null);
    try {
      const cleanSteps = editSteps.filter(s => s.trim());
      const stepsChanged = JSON.stringify(cleanSteps) !== JSON.stringify(test.steps || []);
      if (stepsChanged && test.steps && test.steps.length > 0) {
        setPrevSteps([...test.steps]); setShowDiff(true);
      }
      const payload = { name: editName.trim(), description: editDesc.trim(), steps: cleanSteps, priority: editPriority };
      if (codeEdited) {
        payload.playwrightCode = editCode;
      } else if (test.playwrightCode && stepsChanged) {
        payload.previewCode = true;
      } else if (!test.playwrightCode && stepsChanged && cleanSteps.length > 0) {
        payload.regenerateCode = true;
      }
      const updated = await api.updateTest(testId, payload);
      setTest(updated); setEditing(false); setStepsView("steps");
      if (updated._codePreview) setCodePreview(updated._codePreview);
      if (updated._regenerationError) setRegenWarning(updated._regenerationError);
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
      const updated = await api.updateTest(testId, { playwrightCode: codePreview.generatedCode });
      setTest(updated); setCodePreview(null);
    } catch (err) {
      setRegenWarning(err.message || "Failed to apply generated code.");
    } finally { setApplyingPreview(false); }
  }

  function handleEditPreview() {
    setEditName(test.name || ""); setEditDesc(test.description || "");
    setEditSteps([...(test.steps || [])]); setEditPriority(test.priority || "medium");
    setEditCode(codePreview.generatedCode); setCodeEdited(true);
    setEditError(null); setEditing(true); setStepsView("source"); setCodePreview(null);
  }

  function cancelEditing() { setEditing(false); setEditError(null); }

  function updateEditStep(i, val) { setEditSteps(prev => prev.map((s, idx) => idx === i ? val : s)); }
  function removeEditStep(i) { setEditSteps(prev => prev.filter((_, idx) => idx !== i)); }
  function addEditStep() { setEditSteps(prev => [...prev, ""]); }

  function handleExport() {
    if (!test) return;
    const projectName = project?.name || "";
    const projectUrl  = project?.url  || "";
    const exportedAt  = new Date().toISOString();
    const steps       = (test.steps || []).length > 0 ? test.steps : [""];
    const runHistory = runs.slice(0, 20).map(run => {
      const result = run.results?.find(r => r.testId === testId);
      return { runId: run.id, status: result?.status || run.status, durationMs: result?.durationMs ?? "", startedAt: run.startedAt || "" };
    });
    const headers = ["Test ID","Name","Description","Step #","Step","Project","Priority","Type","Review Status","Status","Last Run At","Created At","Source URL","Journey","Run ID","Run Status","Run Duration (ms)","Run Started At","Exported At"];
    const rows = [];
    steps.forEach((step, stepIdx) => {
      const runs_ = runHistory.length > 0 ? runHistory : [null];
      runs_.forEach((rh, rhIdx) => {
        rows.push([
          stepIdx === 0 && rhIdx === 0 ? test.id                                    : "",
          stepIdx === 0 && rhIdx === 0 ? cleanTestName(test.name)                   : "",
          stepIdx === 0 && rhIdx === 0 ? (test.description || "")                   : "",
          step ? stepIdx + 1 : "", step || "",
          stepIdx === 0 && rhIdx === 0 ? projectName                                : "",
          stepIdx === 0 && rhIdx === 0 ? (test.priority || "medium")                : "",
          stepIdx === 0 && rhIdx === 0 ? (test.type || "")                          : "",
          stepIdx === 0 && rhIdx === 0 ? (test.reviewStatus || "draft")             : "",
          stepIdx === 0 && rhIdx === 0 ? (test.lastResult || "")                    : "",
          stepIdx === 0 && rhIdx === 0 ? (test.lastRunAt || "")                     : "",
          stepIdx === 0 && rhIdx === 0 ? (test.createdAt || "")                     : "",
          stepIdx === 0 && rhIdx === 0 ? (test.sourceUrl || projectUrl || "")       : "",
          stepIdx === 0 && rhIdx === 0 ? (test.isJourneyTest ? "Yes" : "No")        : "",
          rh ? rh.runId : "", rh ? rh.status : "", rh ? rh.durationMs : "", rh ? rh.startedAt : "",
          stepIdx === 0 && rhIdx === 0 ? exportedAt : "",
        ]);
      });
    });
    const filename = `sentri-test-${cleanTestName(test.name || "export").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0,10)}.csv`;
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
    <div className="td-page td-page--padded">
      {[48, 200, 200].map((h, i) => (
        // Heights vary per skeleton row → keep the height inline; the rest
        // (border-radius, margin) lives in `.td-skeleton`.
        <div key={i} className="skeleton td-skeleton" style={{ height: h }} />
      ))}
    </div>
  );

  if (!test) return (
    <div className="td-page--not-found">
      Test not found.{" "}
      <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>Go back</button>
    </div>
  );

  const author = test.author || project?.name || "";

  const latestRunResult = runs[0]?.results?.find(r => r.testId === testId);
  const isFailed = test.lastResult === "failed" || latestRunResult?.status === "failed";
  const showFixBtn = isFailed && test.playwrightCode && !showFixPanel;

  return (
    <div className="fade-in td-page">

      {/* ── Breadcrumb + toolbar ── */}
      <div className="td-toolbar">
        <div className="td-breadcrumb">
          {project ? (
            <>
              <button className="td-breadcrumb-btn" onClick={() => navigate(`/projects/${test.projectId}`)}>
                {project.name}
              </button>
              <ChevronRight size={13} />
              <button className="td-breadcrumb-btn" onClick={() => navigate(`/projects/${test.projectId}`)}>
                Tests
              </button>
            </>
          ) : (
            <button className="td-breadcrumb-btn" onClick={() => navigate("/tests")}>
              Tests
            </button>
          )}
          <ChevronRight size={13} />
          <span className="td-breadcrumb-current">Test Details</span>
        </div>

        {/* ── Action buttons ── */}
        <div className="td-toolbar-actions">
          {editing ? (
            <>
              <button className="btn btn-ghost btn-sm" onClick={cancelEditing} disabled={saving}>
                <X size={14} /> Cancel
              </button>
              <button className="btn btn-primary btn-sm" onClick={handleSaveEdit} disabled={saving}>
                {saving ? <RefreshCw size={14} className="spin" /> : <Save size={14} />}
                {saving ? (test.playwrightCode && !codeEdited ? "Saving & generating…" : "Saving…") : "Save Changes"}
              </button>
            </>
          ) : (
            <>
              {/* Fix with AI — only when latest result is failed */}
              {showFixBtn && (
                <button className="td-fix-btn" onClick={() => setShowFixPanel(true)}>
                  <Wand2 size={14} /> Fix with AI
                </button>
              )}

              {/* More actions (⋯) dropdown */}
              <div className="td-more-wrap" ref={moreRef}>
                <button
                  className="td-more-btn"
                  title="More actions"
                  onClick={() => setMoreOpen(v => !v)}
                  aria-haspopup="true"
                  aria-expanded={moreOpen}
                >
                  <MoreHorizontal size={16} />
                </button>
                {moreOpen && (
                  <div className="td-more-menu" role="menu">
                    <button className="td-more-item" onClick={() => { startEditing(); }}>
                      <Edit2 size={14} /> Edit Test
                    </button>
                    {test.playwrightCode && (
                      <button className="td-more-item" onClick={() => { setShowAiEditor(v => !v); setMoreOpen(false); }}>
                        <Wand2 size={14} /> {showAiEditor ? "Hide AI Editor" : "Edit with AI"}
                      </button>
                    )}
                    <hr className="td-more-separator" />
                    <button className="td-more-item" onClick={() => { handleExport(); setMoreOpen(false); }}>
                      <Download size={14} /> Export CSV
                    </button>
                  </div>
                )}
              </div>

              {/* Primary: Run Test */}
              <button
                className="btn btn-primary btn-sm"
                onClick={handleRunTest}
                disabled={running}
              >
                {running ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
                Run Test
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Page title ── */}
      {editing ? (
        <div className="td-title-edit">
          <input
            className="input td-title-input"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            placeholder="Test name"
            autoFocus
          />
          {editError && <div className="td-edit-error">{editError}</div>}
        </div>
      ) : (
        <h1 className="td-title">{cleanTestName(test.name)}</h1>
      )}

      {/* ── Regen warning ── */}
      {regenWarning && (
        <div className="td-regen-warning">
          <span className="td-regen-icon">⚠</span>
          <span className="td-regen-message">{regenWarning}</span>
          <button className="td-regen-warning-close" onClick={() => setRegenWarning(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Two-column layout ── */}
      <div className="td-layout">

        {/* LEFT COLUMN */}
        <div className="td-left-col">

          {/* Description card */}
          <div className="card card-padded">
            <div className="td-card-header">
              <div className="td-card-icon"><GitCommit size={14} color="var(--text2)" /></div>
              <h2 className="td-card-title">Description</h2>
            </div>
            {editing ? (
              <textarea
                className="input td-desc-textarea"
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                placeholder="Describe what this test verifies…"
                rows={3}
              />
            ) : (
              <p className="td-desc-text">
                {test.description || <span className="td-desc-empty">No description provided.</span>}
              </p>
            )}
          </div>

          {/* Test Steps card */}
          <div className="card card-padded">
            {showAiEditor && (
              <AiTestEditor
                test={test}
                testId={testId}
                onApplied={(updated) => { setTest(updated); setShowAiEditor(false); setStepsView("source"); }}
              />
            )}

            <div className="td-steps-header">
              <div className="td-card-icon"><CheckCircle2 size={14} color="var(--text2)" /></div>
              <h2 className="td-card-title td-card-title--flex">Test Steps</h2>

              {/* Steps / Source tab toggle */}
              {test.playwrightCode && (
                <div className="td-tab-group">
                  <button
                    className={`td-tab-pill ${stepsView === "steps" ? "active" : ""}`}
                    onClick={() => setStepsView("steps")}
                  >
                    <CheckCircle2 size={12} /> Steps
                  </button>
                  <button
                    className={`td-tab-pill ${stepsView === "source" ? "active-accent" : ""}`}
                    onClick={() => setStepsView(stepsView === "source" ? "steps" : "source")}
                  >
                    {"</>"} Source
                    {editing && codeEdited && <span className="td-unsaved-dot" title="Code edited" />}
                  </button>
                </div>
              )}

              {/* Copy as cURL */}
              {test.playwrightCode && !editing && test.isApiTest && (
                <button
                  className={`td-curl-btn ${curlCopied ? "copied" : ""}`}
                  title="Copy all API calls as cURL commands"
                  onClick={async () => {
                    const curl = playwrightToCurl(test.playwrightCode);
                    if (!curl) return;
                    try { await navigator.clipboard.writeText(curl); setCurlCopied(true); setTimeout(() => setCurlCopied(false), 2000); } catch { /* ignore */ }
                  }}
                >
                  {curlCopied ? <CheckCircle2 size={11} /> : <Clipboard size={11} />}
                  {curlCopied ? "Copied!" : "Copy as cURL"}
                </button>
              )}

              {/* Show changes diff toggle */}
              {(test.playwrightCodePrev || prevSteps) && !editing && (
                <button
                  className={`td-diff-btn ${showDiff ? "active" : ""}`}
                  onClick={() => setShowDiff(v => !v)}
                >
                  <GitMerge size={11} />
                  {showDiff ? "Hide diff" : "Show changes"}
                </button>
              )}
            </div>

            {/* ── Edit: Source tab ── */}
            {editing && stepsView === "source" && test.playwrightCode ? (
              <InlineCodeEditor
                code={editCode}
                modified={codeEdited}
                onChange={(val) => { setEditCode(val); setCodeEdited(true); }}
              />

            /* ── Edit: Steps tab ── */
            ) : editing ? (
              <>
                <div className="td-step-editor-list">
                  {editSteps.map((step, idx) => (
                    <div key={idx} className="td-step-editor-row">
                      <div className="td-step-num-edit">{idx + 1}</div>
                      <input
                        className="input td-step-edit-input"
                        value={step}
                        onChange={e => updateEditStep(idx, e.target.value)}
                      />
                      <button className="td-step-remove-btn" onClick={() => removeEditStep(idx)} title="Remove step">
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button className="td-add-step-btn" onClick={addEditStep}>
                  <Plus size={12} /> Add step
                </button>
              </>

            /* ── View: Source tab ── */
            ) : stepsView === "source" && test.playwrightCode ? (
              (() => {
                const stepChunks = splitCodeBySteps(test.playwrightCode, (test.steps || []).length, test.steps);
                return (
                  <div className="td-source-list">
                    {showDiff && test.playwrightCodePrev && (
                      <div className="td-diff-block">
                        <Suspense fallback={<div className="td-diff-fallback" />}>
                          <DiffView before={test.playwrightCodePrev} after={test.playwrightCode} />
                        </Suspense>
                      </div>
                    )}
                    {(test.steps || []).map((step, idx) => (
                      <div key={idx} className="td-source-step">
                        <div className="td-source-step-label">
                          <div className="td-source-step-num">{idx + 1}</div>
                          <span className="td-source-step-text">{step}</span>
                        </div>
                        {stepChunks[idx] ? (
                          <div className="td-source-code-block">
                            <pre className="td-source-pre" dangerouslySetInnerHTML={{ __html: highlightCode(stepChunks[idx]) }} />
                          </div>
                        ) : (
                          <div className="td-source-no-code">No code for this step.</div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()

            /* ── View: Steps tab (default) ── */
            ) : (
              (!test.steps || test.steps.length === 0) ? (
                <div className="td-steps-empty">No steps defined for this test.</div>
              ) : (
                (() => {
                  const stepsDiffPanel = showDiff && prevSteps ? (
                    <div className="td-diff-block">
                      <div className="td-diff-section-label">Steps changes</div>
                      <Suspense fallback={<div className="td-diff-fallback td-diff-fallback--sm" />}>
                        <DiffView
                          before={prevSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
                          after={(test.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n")}
                        />
                      </Suspense>
                    </div>
                  ) : null;

                  const bdd = isBddTest(test.steps);
                  const gherkinKw = /^(Given|When|Then|And|But)\b/i;
                  const failError = isFailed ? (latestRunResult?.error || "") : "";
                  let failedStepIdx = -1;
                  if (isFailed && test.steps.length > 0) {
                    const stepMatch = failError.match(/step\s+(\d+)/i);
                    failedStepIdx = stepMatch ? parseInt(stepMatch[1], 10) - 1 : test.steps.length - 1;
                  }

                  return (
                    <div className="td-step-list">
                      {stepsDiffPanel}
                      {test.steps.map((step, idx) => {
                        const trimmed = (step || "").trim();
                        const kwMatch = bdd ? trimmed.match(gherkinKw) : null;
                        const keyword = kwMatch ? kwMatch[1] : null;
                        const rest = keyword ? trimmed.slice(keyword.length) : trimmed;
                        const isFailedStep = idx === failedStepIdx;
                        return (
                          <div
                            key={idx}
                            className={`td-step-row${isFailedStep && failError ? "" : ""}`}
                          >
                            <div className={`td-step-num ${isFailedStep ? "failed" : bdd ? "bdd" : ""}`}>
                              {idx + 1}
                            </div>
                            <span className={`td-step-text ${isFailedStep ? "failed" : ""}`}>
                              {keyword ? (
                                <>
                                  <span className={`td-step-keyword ${isFailedStep ? "failed" : ""}`}>{keyword}</span>
                                  {rest}
                                </>
                              ) : step}
                            </span>
                            {isFailedStep && failError && (
                              <div data-error-popover className="td-step-error-popover">
                                {failError}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              )
            )}

            {editing && test.playwrightCode && stepsView === "steps" && (
              <div className="td-regen-hint">
                <RefreshCw size={12} />
                Code will be regenerated on save — you'll review changes before applying.{" "}
                <i>Switch to <strong>Source</strong> to edit code directly.</i>
              </div>
            )}
          </div>

          {/* Code Regeneration Review Panel */}
          {codePreview && (
            <CodePreviewPanel
              preview={codePreview}
              applying={applyingPreview}
              onAccept={handleAcceptPreview}
              onEdit={handleEditPreview}
              onDiscard={() => setCodePreview(null)}
            />
          )}

          {/* AI Fix Panel */}
          {showFixPanel && test.playwrightCode && (
            <Suspense fallback={<div className="td-fix-panel-fallback" />}>
              <AiFixPanel
                testId={testId}
                originalCode={test.playwrightCode}
                onApplied={(updated) => { setTest(updated); setShowFixPanel(false); }}
                onClose={() => setShowFixPanel(false)}
              />
            </Suspense>
          )}

          {/* Recent Test Runs card */}
          <div className="card card-padded td-runs-table">
            <h2 className="td-runs-title">Recent Test Runs</h2>
            <div className="td-runs-legend">
              {[
                { icon: "✓", color: "var(--green)",  label: "Passed" },
                { icon: "✗", color: "var(--red)",    label: "Failed" },
                { icon: "↺", color: "var(--blue)",   label: "Running" },
                { icon: "✎", color: "var(--text3)",  label: "Manual" },
              ].map((item, i) => (
                <div key={i} className="td-runs-legend-item">
                  {/* Per-row colour stays inline because it differs per legend entry. */}
                  <span className="td-runs-legend-icon" style={{ color: item.color }}>{item.icon}</span>
                  {item.label}
                </div>
              ))}
            </div>

            {runs.length === 0 ? (
              <div className="td-runs-empty">
                This test hasn't been run yet.{" "}
                <button className="btn btn-ghost btn-xs td-runs-empty-run-btn" onClick={handleRunTest} disabled={running}>
                  <Play size={11} /> Run now
                </button>
              </div>
            ) : (
              <>
                <table className="table td-runs-table-inline">
                  <thead>
                    <tr>
                      <th>Date</th><th>Status</th><th>Duration</th><th>ACU Usage</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.slice((runPage - 1) * PAGE_SIZE, runPage * PAGE_SIZE).map(run => {
                      const result = run.results?.find(r => r.testId === testId);
                      const status = result?.status || run.status;
                      const duration = result?.durationMs;
                      return (
                        <tr key={run.id} className="td-runs-row" onClick={() => navigate(`/runs/${run.id}`)}>
                          <td><span className="td-info-text">{fmtDateTime(run.startedAt)}</span></td>
                          <td>
                            <div className="td-runs-status-cell">
                              <RunIcon status={status} />
                              <span className="td-info-text td-runs-status-text">{status || "—"}</span>
                            </div>
                          </td>
                          <td><span className="td-info-text">{duration ? (duration < 1000 ? `${duration}ms` : `${(duration/1000).toFixed(1)}s`) : "—"}</span></td>
                          <td><span className="td-info-text">0.00</span></td>
                          <td><ExternalLink size={12} color="var(--text3)" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <TablePagination total={runs.length} page={runPage} totalPages={Math.max(1, Math.ceil(runs.length / PAGE_SIZE))} onPageChange={setRunPage} label="runs" />
              </>
            )}
          </div>
        </div>

        {/* RIGHT SIDEBAR */}
        <div className="card td-sidebar">
          <h3 className="td-sidebar-title">Test Information</h3>

          <InfoRow label="Test ID">
            <span className="td-info-mono">{test.id}</span>
          </InfoRow>

          <InfoRow label="Test type">
            <ReviewBadge status={test.reviewStatus} />
          </InfoRow>

          <InfoRow label="Latest test result">
            <StatusBadge result={test.lastResult} />
          </InfoRow>

          {typeof test.qualityScore === "number" && (
            <InfoRow label="Quality score">
              <div className="td-quality-wrap">
                <span
                  className={`badge td-quality-score ${test.qualityScore >= 70 ? "badge-green" : test.qualityScore >= 40 ? "badge-amber" : "badge-red"}`}
                  title="AI-computed quality score (0–100)"
                >
                  {test.qualityScore}
                </span>
                <div className="td-quality-bar-bg" title={`${test.qualityScore} / 100`}>
                  <div className="td-quality-bar-fill" style={{
                    width: `${test.qualityScore}%`,
                    background: test.qualityScore >= 70 ? "var(--green)" : test.qualityScore >= 40 ? "var(--amber)" : "var(--red)",
                  }} />
                </div>
              </div>
            </InfoRow>
          )}

          <InfoRow label="Author"><AvatarChip name={author} /></InfoRow>
          <InfoRow label="Last modified by"><AvatarChip name={author} /></InfoRow>
          <InfoRow label="Created" icon={<Calendar size={14} />}>
            <span className="td-info-text">{fmtDate(test.createdAt)}</span>
          </InfoRow>
          <InfoRow label="Last modified" icon={<Calendar size={14} />}>
            <span className="td-info-text">{fmtDate(test.reviewedAt || test.createdAt)}</span>
          </InfoRow>
          {test.lastRunAt && (
            <InfoRow label="Last run" icon={<Clock size={14} />}>
              <span className="td-info-text">{fmtDateTime(test.lastRunAt)}</span>
            </InfoRow>
          )}

          <hr className="td-sidebar-divider" />

          {test.sourceUrl && (
            <InfoRow label="Source URL">
              <a href={test.sourceUrl} target="_blank" rel="noreferrer" className="td-source-url-link">
                {test.sourceUrl.replace(/^https?:\/\/[^/]+/, "") || "/"}
                <ExternalLink size={10} className="td-source-url-icon" />
              </a>
            </InfoRow>
          )}

          <InfoRow label="Priority">
            {editing ? (
              <select className="input td-sidebar-select" value={editPriority} onChange={e => setEditPriority(e.target.value)}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            ) : (
              <span className={`badge ${test.priority === "high" ? "badge-red" : test.priority === "medium" ? "badge-amber" : "badge-gray"}`}>
                {test.priority || "medium"}
              </span>
            )}
          </InfoRow>

          {test.type && (
            <InfoRow label="Type">
              <span className={`badge ${testTypeBadgeClass(test.type)}`}>{testTypeLabel(test.type)}</span>
            </InfoRow>
          )}

          {(test.isJourneyTest || test.scenario || isBddTest(test.steps)) && (
            <InfoRow label="Tags">
              <div className="td-sidebar-tag-row">
                <ScenarioBadges test={test} isBddTest={isBddTest} />
              </div>
            </InfoRow>
          )}

          {/* Linked Issue */}
          <InfoRow label="Linked Issue" icon={<Link2 size={14} />}>
            {editingIssueKey ? (
              <div className="td-inline-edit-row">
                <input
                  className="input td-inline-edit-input td-inline-edit-input--mono"
                  value={issueKeyDraft}
                  onChange={e => setIssueKeyDraft(e.target.value)}
                  placeholder="PROJ-123"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") api.updateTest(testId, { linkedIssueKey: issueKeyDraft.trim() }).then(t => { setTest(t); setEditingIssueKey(false); });
                    if (e.key === "Escape") setEditingIssueKey(false);
                  }}
                />
                <button className="btn btn-xs td-inline-save-btn"
                  onClick={() => api.updateTest(testId, { linkedIssueKey: issueKeyDraft.trim() }).then(t => { setTest(t); setEditingIssueKey(false); })}>
                  <Save size={10} />
                </button>
                <button className="btn btn-ghost btn-xs" onClick={() => setEditingIssueKey(false)}><X size={10} /></button>
              </div>
            ) : (
              <div className="td-inline-display-row">
                {test.linkedIssueKey
                  ? <span className="td-linked-issue-val">{test.linkedIssueKey}</span>
                  : <span className="td-linked-issue-empty">Not linked</span>}
                <button className="btn btn-ghost btn-xs td-edit-inline-btn"
                  onClick={() => { setIssueKeyDraft(test.linkedIssueKey || ""); setEditingIssueKey(true); }}>
                  <Edit2 size={10} />
                </button>
              </div>
            )}
          </InfoRow>

          {/* Tags */}
          <InfoRow label="Tags" icon={<Tag size={14} />}>
            {editingTags ? (
              <div className="td-inline-edit-row">
                <input
                  className="input td-inline-edit-input"
                  value={tagsDraft}
                  onChange={e => setTagsDraft(e.target.value)}
                  placeholder="smoke, regression, login"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      const tags = tagsDraft.split(",").map(t => t.trim()).filter(Boolean);
                      api.updateTest(testId, { tags }).then(t => { setTest(t); setEditingTags(false); });
                    }
                    if (e.key === "Escape") setEditingTags(false);
                  }}
                />
                <button className="btn btn-xs td-inline-save-btn"
                  onClick={() => {
                    const tags = tagsDraft.split(",").map(t => t.trim()).filter(Boolean);
                    api.updateTest(testId, { tags }).then(t => { setTest(t); setEditingTags(false); });
                  }}>
                  <Save size={10} />
                </button>
                <button className="btn btn-ghost btn-xs" onClick={() => setEditingTags(false)}><X size={10} /></button>
              </div>
            ) : (
              <div className="td-tags-row">
                {(test.tags || []).length > 0
                  ? test.tags.map((tag, i) => <span key={i} className="badge badge-gray td-sidebar-tag-badge">{tag}</span>)
                  : <span className="td-tags-empty">No tags</span>}
                <button className="btn btn-ghost btn-xs td-edit-inline-btn"
                  onClick={() => { setTagsDraft((test.tags || []).join(", ")); setEditingTags(true); }}>
                  <Edit2 size={10} />
                </button>
              </div>
            )}
          </InfoRow>

          {test.promptVersion && (
            <InfoRow label="Generated by">
              <span className="td-info-text">{test.modelUsed || "AI"} · prompt v{test.promptVersion}</span>
            </InfoRow>
          )}

          {/* Quick actions */}
          <div className="td-sidebar-actions">
            {test.reviewStatus !== "approved" && (
              <button className={`btn btn-sm td-approve-btn`} onClick={() => api.approveTest(test.projectId, testId).then(load)}>
                <CheckCircle2 size={13} /> Approve Test
              </button>
            )}
            {test.reviewStatus === "approved" && (
              <button className="btn btn-ghost btn-sm td-draft-btn" onClick={() => api.restoreTest(test.projectId, testId).then(load)}>
                <RotateCcw size={13} /> Move to Draft
              </button>
            )}
            <button className="btn btn-primary btn-sm td-run-sidebar-btn" onClick={handleRunTest} disabled={running}>
              {running ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
              Run This Test
            </button>
            <button className="btn btn-ghost btn-sm td-view-project-btn" onClick={() => navigate(`/projects/${test.projectId}`)}>
              View Project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

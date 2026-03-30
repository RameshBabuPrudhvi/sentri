import React, { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, X, Filter, CheckCircle2, XCircle, Clock, ChevronRight, Loader2, Play, Flag } from "lucide-react";
import { api } from "../api.js";

const STATUS_FILTERS = ["All", "Passing", "Failing", "Not Run"];
const REVIEW_FILTERS = ["Approved", "Draft", "All Tests"];

function AgentTag({ type = "TA" }) {
  const s = { QA: "avatar-qa", TA: "avatar-ta", EX: "avatar-ex" };
  return <div className={`avatar ${s[type]}`}>{type}</div>;
}

function StatusBadge({ result }) {
  if (!result) return <span className="badge badge-gray"><Clock size={10} /> Not run</span>;
  if (result === "passed") return <span className="badge badge-green"><CheckCircle2 size={10} /> Passing</span>;
  if (result === "failed") return <span className="badge badge-red"><XCircle size={10} /> Failing</span>;
  return <span className="badge badge-amber">{result}</span>;
}

// ── Create Test Modal ─────────────────────────────────────────────────────────
// Flow: form → generating steps → review steps → generating code → done (draft)

function CreateTestModal({ projects, onClose, onCreated, defaultProjectId }) {
  // "form" | "gen-steps" | "review" | "gen-code" | "done"
  const [phase, setPhase] = useState("form");

  const [name, setName]               = useState("");
  const [description, setDescription] = useState("");
  // Auto-populate: prefer defaultProjectId, then first project
  const [projectId, setProjectId]     = useState(defaultProjectId || projects[0]?.id || "");
  const [error, setError]             = useState(null);
  const [createdTest, setCreatedTest] = useState(null);
  const [isSaving, setIsSaving]       = useState(false);

  // Editable generated steps (review phase)
  const [generatedSteps, setGeneratedSteps] = useState([]);

  const navigate  = useNavigate();
  const nameRef   = useRef(null);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // ── Phase 1: submit form → ask AI for steps ────────────────────────────────
  async function handleGenerateSteps(e) {
    e?.preventDefault();
    setError(null);
    if (!name.trim())    { setError("Test name is required.");    return; }
    if (!projectId)      { setError("Please select a project.");  return; }

    // If a previous draft was already created (user navigated back and is
    // re-generating), delete the orphan so we don't leak draft tests.
    if (createdTest) {
      api.deleteTest(createdTest.projectId, createdTest.id).catch(() => {});
      setCreatedTest(null);
    }

    setPhase("gen-steps");
    try {
      // Hit the AI generate endpoint — backend phase 1 gives us steps
      // We do this in two calls so the user can review steps before code is written.
      // Use the lightweight /generate endpoint which returns steps + code together.
      const result = await api.generateTest(projectId, {
        name: name.trim(),
        description: description.trim(),
      });
      // result has .steps and .playwrightCode from backend
      setGeneratedSteps(result.steps || []);
      setCreatedTest(result); // hold the full test for the done screen
      setPhase("review");
    } catch (err) {
      setError(err.message || "AI generation failed. Check your API key in Settings.");
      setPhase("form");
    }
  }

  // ── Phase 2: user edits steps, then confirms → persist edits → show done ──
  async function handleConfirmSteps() {
    setError(null);
    // Persist the user-edited steps back to the backend. The test was already
    // saved as a draft by the backend during handleGenerateSteps, but any
    // additions, removals, or rewrites the user made in the review UI would
    // otherwise be silently discarded — the UI said "Save as Draft" but never
    // actually saved anything. We PATCH the steps now before transitioning.
    try {
      setIsSaving(true);
      const updated = await api.updateTest(createdTest.id, {
        steps: generatedSteps.filter(s => s.trim()),
        regenerateCode: true,
      });
      setPhase("done");
      if (onCreated) onCreated(updated);
    } catch (err) {
      setError(err.message || "Failed to save steps. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  // Step editing helpers
  function updateStep(i, val) {
    setGeneratedSteps(prev => prev.map((s, idx) => idx === i ? val : s));
  }
  function removeStep(i) {
    setGeneratedSteps(prev => prev.filter((_, idx) => idx !== i));
  }
  function addStep() {
    setGeneratedSteps(prev => [...prev, ""]);
  }

  const selectedProject = projects.find(p => p.id === projectId);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
          zIndex: 999, backdropFilter: "blur(2px)",
        }}
      />

      {/* Modal */}
      <div style={{
        position: "fixed", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 1000,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        width: phase === "review" ? "min(600px, 96vw)" : "min(500px, 96vw)",
        maxHeight: "90vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        transition: "width 0.2s ease",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "18px 22px 16px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          {phase === "review" && (
            <button
              onClick={() => setPhase("form")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text2)", padding: 2, display: "flex" }}
            >
              <ChevronRight size={17} style={{ transform: "rotate(180deg)" }} />
            </button>
          )}
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>
            {phase === "form"      && "Generate a Test Case"}
            {phase === "gen-steps" && "Analysing your description…"}
            {phase === "review"    && "Review Generated Steps"}
            {phase === "gen-code"  && "Writing Playwright script…"}
            {phase === "done"      && "Test Saved to Draft"}
          </h2>
          {/* Progress dots */}
          {phase !== "done" && (
            <div style={{ display: "flex", gap: 5, marginRight: 8 }}>
              {["form", "gen-steps", "review", "done"].map((p, i) => {
                const phaseOrder = { form: 0, "gen-steps": 1, review: 2, "gen-code": 2, done: 3 };
                const current = phaseOrder[phase] ?? 0;
                return (
                  <div key={p} style={{
                    width: i <= current ? 18 : 6,
                    height: 6, borderRadius: 3,
                    background: i <= current ? "var(--accent)" : "var(--bg3)",
                    transition: "all 0.25s",
                  }} />
                );
              })}
            </div>
          )}
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 2, display: "flex" }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 22px 24px", overflowY: "auto", flex: 1 }}>

          {/* ── FORM ────────────────────────────────────────────────────── */}
          {phase === "form" && (
            <>
              <p style={{ fontSize: "0.82rem", color: "var(--text2)", marginTop: 0, marginBottom: 20, lineHeight: 1.6 }}>
                Describe what you want to test. AI will generate detailed steps and a Playwright script, saved as a <strong>Draft</strong> for your review.
              </p>

              {/* Project — always shown, always auto-populated */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>
                  Project
                </label>
                <select
                  className="input"
                  value={projectId}
                  onChange={e => setProjectId(e.target.value)}
                  style={{ height: 38 }}
                >
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {selectedProject && (
                  <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                    {selectedProject.url}
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>
                  Test Name
                </label>
                <input
                  ref={nameRef}
                  className="input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Dashboard loads all employee charts"
                  style={{ height: 38 }}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) handleGenerateSteps(e); }}
                />
              </div>

              <div style={{ marginBottom: error ? 12 : 20 }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>
                  Description
                  <span style={{ fontWeight: 400, color: "var(--text3)", marginLeft: 6 }}>(optional but recommended)</span>
                </label>
                <textarea
                  className="input"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Verify the employees age and the distribution and make sure all the graphs are loading as expected"
                  rows={4}
                  style={{ resize: "vertical", lineHeight: 1.6, paddingTop: 10 }}
                />
              </div>

              {error && (
                <div style={{
                  background: "var(--red-bg)", color: "var(--red)",
                  borderRadius: "var(--radius)", padding: "8px 12px",
                  fontSize: "0.82rem", marginBottom: 16, lineHeight: 1.5,
                }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleGenerateSteps}
                  disabled={!name.trim() || !projectId}
                >
                  Generate with AI ✦
                </button>
              </div>
            </>
          )}

          {/* ── GENERATING STEPS ─────────────────────────────────────────── */}
          {phase === "gen-steps" && (
            <div style={{ textAlign: "center", padding: "48px 0" }}>
              <Loader2 size={36} className="spin" color="var(--accent)" style={{ marginBottom: 16 }} />
              <div style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: 8 }}>
                Generating test steps…
              </div>
              <div style={{ fontSize: "0.82rem", color: "var(--text2)", lineHeight: 1.6, maxWidth: 320, margin: "0 auto" }}>
                AI is analysing <em>{name}</em> and writing detailed QA steps and a Playwright script.
              </div>
              <div style={{ marginTop: 20, display: "flex", justifyContent: "center", gap: 6 }}>
                {["Parsing description", "Generating steps", "Writing Playwright code"].map((label, i) => (
                  <span key={i} style={{
                    fontSize: "0.7rem", padding: "2px 10px", borderRadius: 99,
                    background: "var(--accent-bg)", color: "var(--accent)",
                    fontWeight: 600,
                  }}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── REVIEW STEPS ─────────────────────────────────────────────── */}
          {phase === "review" && (
            <>
              <div style={{
                padding: "10px 14px", background: "var(--accent-bg)",
                borderRadius: 8, border: "1px solid rgba(91,110,245,0.2)",
                fontSize: "0.8rem", color: "var(--accent)", marginBottom: 18,
                display: "flex", alignItems: "center", gap: 8, lineHeight: 1.5,
              }}>
                <span style={{ fontSize: "1rem" }}>✦</span>
                AI generated {generatedSteps.length} steps and a Playwright script. Review and edit the steps below, then confirm to save as <strong>Draft</strong>.
              </div>

              {/* Project + test name summary */}
              <div style={{ marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.88rem", marginBottom: 2 }}>{name}</div>
                  {selectedProject && (
                    <div style={{ fontSize: "0.72rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
                      {selectedProject.name} · {selectedProject.url}
                    </div>
                  )}
                </div>
                <span className="badge badge-amber" style={{ flexShrink: 0 }}>Draft</span>
              </div>

              {/* Editable steps list */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 8, color: "var(--text2)" }}>
                  Test Steps <span style={{ fontWeight: 400, color: "var(--text3)" }}>— edit as needed</span>
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {generatedSteps.map((step, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <div style={{
                        width: 22, height: 22, borderRadius: "50%",
                        background: "var(--bg3)", border: "1px solid var(--border)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: "0.65rem", fontWeight: 700, color: "var(--text3)",
                        flexShrink: 0, marginTop: 7,
                      }}>
                        {i + 1}
                      </div>
                      <input
                        className="input"
                        value={step}
                        onChange={e => updateStep(i, e.target.value)}
                        style={{ flex: 1, height: 36, fontSize: "0.8rem" }}
                      />
                      <button
                        onClick={() => removeStep(i)}
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
                  onClick={addStep}
                  style={{
                    marginTop: 8, background: "none", border: "1px dashed var(--border)",
                    borderRadius: 6, cursor: "pointer", color: "var(--text3)",
                    fontSize: "0.78rem", padding: "5px 12px", width: "100%",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                  }}
                >
                  <Plus size={12} /> Add step
                </button>
              </div>

              {/* Playwright code note */}
              {createdTest?.playwrightCode && (
                <div style={{
                  padding: "8px 12px", background: "var(--green-bg)",
                  border: "1px solid #86efac", borderRadius: 6,
                  fontSize: "0.78rem", color: "#14532d", marginBottom: 16,
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <CheckCircle2 size={13} color="var(--green)" />
                  Playwright test script generated and ready to run.
                </div>
              )}

              {error && (
                <div style={{
                  background: "var(--red-bg)", color: "var(--red)",
                  borderRadius: "var(--radius)", padding: "8px 12px",
                  fontSize: "0.82rem", marginBottom: 14,
                }}>
                  {error}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setPhase("form")}>
                  ← Back
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleConfirmSteps}
                  disabled={isSaving || generatedSteps.filter(s => s.trim()).length === 0}
                >
                  {isSaving ? "Saving…" : "Save to Draft"}
                </button>
              </div>
            </>
          )}

          {/* ── DONE ─────────────────────────────────────────────────────── */}
          {phase === "done" && createdTest && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{
                width: 52, height: 52, borderRadius: "50%",
                background: "var(--amber-bg)", color: "var(--amber)",
                display: "flex", alignItems: "center", justifyContent: "center",
                margin: "0 auto 16px",
                border: "2px solid #fcd34d",
              }}>
                <Flag size={24} />
              </div>
              <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 6 }}>
                Saved to Draft!
              </div>
              <div style={{ fontSize: "0.82rem", color: "var(--text2)", marginBottom: 6, lineHeight: 1.6 }}>
                <strong>{createdTest.name}</strong> has been saved to the{" "}
                <strong>Generated Tests (Draft)</strong> queue.
              </div>
              <div style={{ fontSize: "0.78rem", color: "var(--text3)", marginBottom: 24, lineHeight: 1.6 }}>
                Review and approve it in your project to add it to the Regression Suite.
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => { onClose(); navigate(`/tests/${createdTest.id}`); }}
                >
                  View Test
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Run All Modal ─────────────────────────────────────────────────────────────

function RunAllModal({ projects, onClose }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function handleRun() {
    if (!projectId) { setError("Please select a project."); return; }
    setError(null);
    setRunning(true);
    try {
      const { runId } = await api.runTests(projectId);
      onClose();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err.message || "Failed to start run.");
      setRunning(false);
    }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 999, backdropFilter: "blur(2px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        zIndex: 1000, background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        width: "min(420px, 95vw)", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 22px 16px", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>Run Regression Tests</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 2, display: "flex" }}><X size={18} /></button>
        </div>
        <div style={{ padding: "20px 22px 24px" }}>
          <p style={{ fontSize: "0.82rem", color: "var(--text2)", marginTop: 0, marginBottom: 20, lineHeight: 1.6 }}>
            Select a project to run all approved tests in its regression suite.
          </p>
          {projects.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label>Project</label>
              <select className="input" value={projectId} onChange={e => setProjectId(e.target.value)} style={{ height: 38 }}>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          {error && (
            <div style={{ background: "var(--red-bg)", color: "var(--red)", borderRadius: "var(--radius)", padding: "8px 12px", fontSize: "0.82rem", marginBottom: 16 }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={handleRun} disabled={running || !projectId}>
              {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
              {running ? "Starting…" : "Run Tests"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Review Modal ─────────────────────────────────────────────────────────────

function ReviewModal({ projects, onClose }) {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 999, backdropFilter: "blur(2px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        zIndex: 1000, background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        width: "min(420px, 95vw)", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 22px 16px", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>Review & Fix Tests</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 2, display: "flex" }}><X size={18} /></button>
        </div>
        <div style={{ padding: "20px 22px 24px" }}>
          <p style={{ fontSize: "0.82rem", color: "var(--text2)", marginTop: 0, marginBottom: 20, lineHeight: 1.6 }}>
            Go to a project to review generated draft tests, approve them for regression, or reject failing ones.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
            {projects.length === 0 ? (
              <div style={{ fontSize: "0.82rem", color: "var(--text3)", textAlign: "center", padding: "16px 0" }}>No projects yet.</div>
            ) : projects.map(p => (
              <button
                key={p.id}
                className="btn btn-ghost btn-sm"
                style={{ justifyContent: "flex-start", gap: 10 }}
                onClick={() => { onClose(); navigate(`/projects/${p.id}`); }}
              >
                <Flag size={13} color="var(--accent)" />
                {p.name}
                <ChevronRight size={13} style={{ marginLeft: "auto" }} />
              </button>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Projects() {
  const [projects, setProjects]           = useState([]);
  const [tests, setTests]                 = useState([]);
  const [search, setSearch]               = useState("");
  const [filter, setFilter]               = useState("All");
  const [loading, setLoading]             = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRunModal, setShowRunModal]   = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewFilter, setReviewFilter]     = useState("Approved");
  const navigate = useNavigate();

  useEffect(() => {
    api.getProjects().then(async (projs) => {
      setProjects(projs);
      const all = await Promise.all(projs.map(p => api.getTests(p.id).catch(() => [])));
      setTests(all.flat());
    }).finally(() => setLoading(false));
  }, []);

  const filtered = tests.filter(t => {
    // Review status filter — default to approved only (regression suite)
    const matchReview = reviewFilter === "All Tests"
      || (reviewFilter === "Approved" && t.reviewStatus === "approved")
      || (reviewFilter === "Draft" && t.reviewStatus === "draft");
    const matchSearch = !search
      || t.name?.toLowerCase().includes(search.toLowerCase())
      || t.description?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "All"
      || (filter === "Passing" && t.lastResult === "passed")
      || (filter === "Failing" && t.lastResult === "failed")
      || (filter === "Not Run" && !t.lastResult);
    return matchReview && matchSearch && matchFilter;
  });

  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));

  function handleTestCreated(newTest) {
    setTests(prev => [newTest, ...prev]);
  }

  const quickActions = [
    {
      icon: "✦",
      title: "Create Tests",
      desc: "Create a new test case for your application",
      color: "var(--accent-bg)",
      iconColor: "var(--accent)",
      action: () => {
        if (projects.length === 0) {
          navigate("/projects/new");
        } else {
          setShowCreateModal(true);
        }
      },
    },
    {
      icon: "▶",
      title: "Run Tests",
      desc: "Execute regression tests from your test suite",
      color: "var(--green-bg)",
      iconColor: "var(--green)",
      action: () => {
        if (projects.length === 0) {
          navigate("/projects/new");
        } else {
          setShowRunModal(true);
        }
      },
    },
    {
      icon: "⚑",
      title: "Review and Fix Tests",
      desc: "Refine and manage your draft and failing tests",
      color: "var(--amber-bg)",
      iconColor: "var(--amber)",
      action: () => {
        if (projects.length === 0) {
          navigate("/projects/new");
        } else {
          setShowReviewModal(true);
        }
      },
    },
  ];

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>Tests</h1>
        <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
          <Plus size={14} /> New Project
        </button>
      </div>

      {/* Quick Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        {quickActions.map((a, i) => (
          <div
            key={i}
            className="card"
            style={{ padding: 18, cursor: "pointer", transition: "box-shadow 0.15s" }}
            onClick={a.action}
            onMouseEnter={e => e.currentTarget.style.boxShadow = "var(--shadow)"}
            onMouseLeave={e => e.currentTarget.style.boxShadow = ""}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{
                width: 34, height: 34, borderRadius: 9,
                background: a.color, display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: 16, flexShrink: 0, color: a.iconColor,
              }}>
                {a.icon}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 3 }}>{a.title}</div>
                <div style={{ fontSize: "0.78rem", color: "var(--text2)", lineHeight: 1.5 }}>{a.desc}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tests table */}
      <div className="card">
        <div style={{
          padding: "14px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem", flex: "0 0 auto" }}>
            {reviewFilter === "Draft" ? "Draft Tests" : reviewFilter === "All Tests" ? "All Tests" : "Regression Tests"} ({filtered.length})
          </div>
          <div style={{ flex: 1, minWidth: 200, position: "relative" }}>
            <Search size={13} color="var(--text3)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)" }} />
            <input
              className="input"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tests..."
              style={{ paddingLeft: 28, height: 32, fontSize: "0.82rem" }}
            />
          </div>
          <div style={{
            display: "flex", gap: 4,
            background: "var(--bg2)", padding: 3,
            borderRadius: "var(--radius)", border: "1px solid var(--border)",
          }}>
            {STATUS_FILTERS.map(f => (
              <button
                key={f}
                className="btn btn-xs"
                onClick={() => setFilter(f)}
                style={{
                  background: filter === f ? "#fff" : "transparent",
                  color: filter === f ? "var(--text)" : "var(--text3)",
                  border: filter === f ? "1px solid var(--border)" : "1px solid transparent",
                  boxShadow: filter === f ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <div style={{
            display: "flex", gap: 4,
            background: "var(--bg2)", padding: 3,
            borderRadius: "var(--radius)", border: "1px solid var(--border)",
          }}>
            {REVIEW_FILTERS.map(f => (
              <button
                key={f}
                className="btn btn-xs"
                onClick={() => setReviewFilter(f)}
                style={{
                  background: reviewFilter === f ? "#fff" : "transparent",
                  color: reviewFilter === f ? "var(--text)" : "var(--text3)",
                  border: reviewFilter === f ? "1px solid var(--border)" : "1px solid transparent",
                  boxShadow: reviewFilter === f ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 24 }}>
            {[...Array(5)].map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8, borderRadius: 8 }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "60px 24px", textAlign: "center", color: "var(--text2)" }}>
            {tests.length === 0
              ? "No tests yet — crawl a project to generate tests"
              : "No tests match your search"}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Test Name</th>
                <th>Status</th>
                <th>Last Run</th>
                <th>Project</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr
                  key={t.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => navigate(`/tests/${t.id}`)}
                >
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <AgentTag type="TA" />
                      <div>
                        <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{t.name}</div>
                        {t.description && (
                          <div style={{
                            fontSize: "0.75rem", color: "var(--text3)", marginTop: 1,
                            maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>
                            {t.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td><StatusBadge result={t.lastResult} /></td>
                  <td>
                    <span style={{ fontSize: "0.8rem", color: "var(--text2)" }}>
                      {t.lastRunAt
                        ? new Date(t.lastRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                        : "—"}
                    </span>
                  </td>
                  <td>
                    {projMap[t.projectId] && (
                      <span className="badge badge-gray">{projMap[t.projectId].name}</span>
                    )}
                  </td>
                  <td>
                    {t.reviewStatus === "draft" && <span className="badge badge-amber">Draft</span>}
                    {t.reviewStatus === "rejected" && <span className="badge badge-red">Rejected</span>}
                    {t.isJourneyTest && <span className="badge badge-purple" style={{ marginLeft: 4 }}>Journey</span>}
                    {t.priority === "high" && <span className="badge badge-red" style={{ marginLeft: 4 }}>High</span>}
                    {t.type === "manual" && <span className="badge badge-blue" style={{ marginLeft: 4 }}>Manual</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      {showCreateModal && (
        <CreateTestModal
          projects={projects}
          onClose={() => setShowCreateModal(false)}
          onCreated={handleTestCreated}
          defaultProjectId={projects[0]?.id || ""}
        />
      )}
      {showRunModal && (
        <RunAllModal
          projects={projects}
          onClose={() => setShowRunModal(false)}
        />
      )}
      {showReviewModal && (
        <ReviewModal
          projects={projects}
          onClose={() => setShowReviewModal(false)}
        />
      )}
    </div>
  );
}

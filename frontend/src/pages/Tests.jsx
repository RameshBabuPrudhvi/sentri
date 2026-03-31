import React, { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Search, Plus, X, CheckCircle2, XCircle, Clock,
  ChevronRight, Loader2, Play, Flag,
} from "lucide-react";
import { api } from "../api.js";

const STATUS_FILTERS = [
  { key: "All",     label: "All",     icon: null },
  { key: "Passing", label: "Passing", icon: <CheckCircle2 size={11} style={{ color: "var(--green)" }} /> },
  { key: "Failing", label: "Failing", icon: <XCircle size={11} style={{ color: "var(--red)" }} /> },
  { key: "Not Run", label: "Not Run", icon: <Clock size={11} style={{ color: "var(--text3)" }} /> },
];
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

// ── Create Test Modal ──────────────────────────────────────────────────────────

function CreateTestModal({ projects, onClose, onCreated, defaultProjectId }) {
  const [phase, setPhase] = useState("form");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || "");
  const [error, setError] = useState(null);

  const navigate = useNavigate();
  const nameRef = useRef(null);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  async function handleGenerateSteps(e) {
    e?.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Test name is required."); return; }
    if (!projectId) { setError("Please select a project."); return; }
    setPhase("submitting");
    try {
      const { runId } = await api.generateTest(projectId, {
        name: name.trim(),
        description: description.trim(),
      });
      onClose();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err.message || "Failed to start generation.");
      setPhase("form");
    }
  }

  const selectedProject = projects.find(p => p.id === projectId);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 999, backdropFilter: "blur(2px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        zIndex: 1000, background: "var(--surface)", border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)", boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        width: "min(500px, 96vw)", maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 22px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>Generate a Test Case</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 2, display: "flex" }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: "20px 22px 24px", overflowY: "auto", flex: 1 }}>
          {(phase === "form" || phase === "submitting") && (
            <>
              <p style={{ fontSize: "0.82rem", color: "var(--text2)", marginTop: 0, marginBottom: 20, lineHeight: 1.6 }}>
                Describe what you want to test. AI will generate detailed steps and a Playwright script, saved as a <strong>Draft</strong> for your review.
              </p>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>Project</label>
                <select className="input" value={projectId} onChange={e => setProjectId(e.target.value)} style={{ height: 38 }}>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {selectedProject && (
                  <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                    {selectedProject.url}
                  </div>
                )}
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: 5, color: "var(--text2)" }}>Test Name</label>
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
                <div style={{ background: "var(--red-bg)", color: "var(--red)", borderRadius: "var(--radius)", padding: "8px 12px", fontSize: "0.82rem", marginBottom: 16, lineHeight: 1.5 }}>
                  {error}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleGenerateSteps}
                  disabled={!name.trim() || !projectId || phase === "submitting"}
                >
                  Generate with AI ✦
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ── Run All Modal ──────────────────────────────────────────────────────────────

function RunAllModal({ projects, onClose, defaultProjectId }) {
  // FIX #8: default to most recently active project passed from caller
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || "");
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

// ── Review Modal ───────────────────────────────────────────────────────────────

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

// ── Empty State ────────────────────────────────────────────────────────────────

function EmptyState({ projects, tests, search, reviewFilter, onCreateTest, onClearSearch, onClearFilters, navigate }) {
  // No projects at all — first-time user
  if (projects.length === 0) {
    return (
      <div style={{ padding: "52px 40px", textAlign: "center" }}>
        <div style={{ fontSize: "2rem", marginBottom: 14 }}>🚀</div>
        <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 8, color: "var(--text)" }}>
          Welcome to Tests
        </div>
        <div style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: 8, lineHeight: 1.7, maxWidth: 380, margin: "0 auto 20px" }}>
          Start by creating a project. Sentri will crawl your app and AI-generate test cases for you to review and run.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button className="btn btn-primary btn-sm" onClick={() => navigate("/projects/new")}>
            Create first project
          </button>
        </div>
      </div>
    );
  }

  // Has projects, no tests at all — crawl hasn't been run yet
  if (tests.length === 0) {
    return (
      <div style={{ padding: "52px 40px", textAlign: "center" }}>
        <div style={{ fontSize: "2rem", marginBottom: 14 }}>🧪</div>
        <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 8, color: "var(--text)" }}>
          No tests generated yet
        </div>
        <div style={{ fontSize: "0.875rem", color: "var(--text2)", lineHeight: 1.7, maxWidth: 400, margin: "0 auto 20px" }}>
          Go to a project and run a <strong>Crawl</strong> to let Sentri discover your app's pages and auto-generate test cases — or create one manually.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate("/projects")}>
            Go to Projects
          </button>
          <button className="btn btn-primary btn-sm" onClick={onCreateTest}>
            Generate with AI ✦
          </button>
        </div>
      </div>
    );
  }

  // Has tests, but the active filter hides them all
  const draftCount  = tests.filter(t => !t.reviewStatus || t.reviewStatus === "draft").length;
  const approvedCount = tests.filter(t => t.reviewStatus === "approved").length;

  // Contextual hint based on which filter is active
  let hint = null;
  if (reviewFilter === "Approved" && draftCount > 0) {
    hint = (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 10,
        background: "var(--amber-bg)", border: "1px solid rgba(217,119,6,0.2)",
        borderRadius: "var(--radius)", padding: "10px 16px",
        fontSize: "0.82rem", color: "var(--amber)", marginBottom: 20, textAlign: "left",
      }}>
        <span style={{ fontSize: "1rem" }}>💡</span>
        <span>
          You have <strong>{draftCount} draft {draftCount === 1 ? "test" : "tests"}</strong> waiting for review.
          Switch to <strong>Draft</strong> to approve them and add them to your regression suite.
        </span>
      </div>
    );
  } else if (reviewFilter === "Draft" && approvedCount > 0) {
    hint = (
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 10,
        background: "var(--blue-bg)", border: "1px solid rgba(37,99,235,0.15)",
        borderRadius: "var(--radius)", padding: "10px 16px",
        fontSize: "0.82rem", color: "var(--blue)", marginBottom: 20, textAlign: "left",
      }}>
        <span style={{ fontSize: "1rem" }}>ℹ️</span>
        <span>No draft tests — all <strong>{approvedCount}</strong> tests have already been reviewed.</span>
      </div>
    );
  }

  return (
    <div style={{ padding: "52px 40px", textAlign: "center" }}>
      <div style={{ fontSize: "2rem", marginBottom: 14 }}>🔍</div>
      <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 8, color: "var(--text)" }}>
        No tests match your filters
      </div>
      {hint && <div style={{ marginBottom: 4 }}>{hint}</div>}
      <div style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: 20 }}>
        {search ? `No results for "${search}".` : "Try adjusting your filters."}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <button className="btn btn-ghost btn-sm" onClick={onClearFilters}>
          Clear filters
        </button>
        <button className="btn btn-primary btn-sm" onClick={onCreateTest}>
          Generate with AI ✦
        </button>
      </div>
    </div>
  );
}

// ── Tests Page ─────────────────────────────────────────────────────────────────

export default function Tests() {
  const [projects, setProjects] = useState([]);
  const [tests, setTests] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const search      = searchParams.get("q")      || "";
  const filter      = searchParams.get("status") || "All";
  const reviewFilter= searchParams.get("review") || "All Tests";

  const setSearch      = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v ? n.set("q", v) : n.delete("q"); return n; }, { replace: true }), [setSearchParams]);
  const setFilter      = useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "All" ? n.set("status", v) : n.delete("status"); return n; }, { replace: true }), [setSearchParams]);
  const setReviewFilter= useCallback((v) => setSearchParams(p => { const n = new URLSearchParams(p); v !== "All Tests" ? n.set("review", v) : n.delete("review"); return n; }, { replace: true }), [setSearchParams]);

  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // Use batch getAllTests endpoint — falls back to per-project if not available
    Promise.all([api.getProjects(), api.getAllTests().catch(() => null)]).then(async ([projs, allFromBatch]) => {
      setProjects(projs);
      if (allFromBatch) {
        setTests(allFromBatch);
      } else {
        const all = await Promise.all(projs.map(p => api.getTests(p.id).catch(() => [])));
        setTests(all.flat());
      }
    }).finally(() => setLoading(false));
  }, []);

  const filtered = tests.filter(t => {
    const matchReview =
      reviewFilter === "All Tests" ? true :
      reviewFilter === "Approved" ? t.reviewStatus === "approved" :
      reviewFilter === "Draft" ? t.reviewStatus === "draft" : true;
    const matchSearch = !search
      || t.name?.toLowerCase().includes(search.toLowerCase())
      || t.description?.toLowerCase().includes(search.toLowerCase());
    const matchFilter =
      filter === "All" ? true :
      filter === "Passing" ? t.lastResult === "passed" :
      filter === "Failing" ? t.lastResult === "failed" :
      filter === "Not Run" ? !t.lastResult : true;
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
      action: () => projects.length === 0 ? navigate("/projects/new") : setShowCreateModal(true),
    },
    {
      icon: "▶",
      title: "Run Tests",
      desc: "Execute regression tests from your test suite",
      color: "var(--green-bg)",
      iconColor: "var(--green)",
      action: () => projects.length === 0 ? navigate("/projects/new") : setShowRunModal(true),
    },
    {
      icon: "⚑",
      title: "Review and Fix Tests",
      desc: "Refine and manage your draft and failing tests",
      color: "var(--amber-bg)",
      iconColor: "var(--amber)",
      action: () => projects.length === 0 ? navigate("/projects/new") : setShowReviewModal(true),
    },
  ];

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: 2 }}>Tests</h1>
          <p style={{ fontSize: "0.82rem", color: "var(--text2)", margin: 0 }}>
            Manage, run, and review test cases across all projects
          </p>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => projects.length === 0 ? navigate("/projects/new") : setShowCreateModal(true)}
          title={projects.length === 0 ? "Create a project first" : undefined}
        >
          <Plus size={14} /> New Test
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
          <div style={{ display: "flex", gap: 4, background: "var(--bg2)", padding: 3, borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
            {STATUS_FILTERS.map(f => (
              <button key={f.key} className="btn btn-xs" onClick={() => setFilter(f.key)} style={{
                background: filter === f.key ? "#fff" : "transparent",
                color: filter === f.key ? "var(--text)" : "var(--text3)",
                border: filter === f.key ? "1px solid var(--border)" : "1px solid transparent",
                boxShadow: filter === f.key ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
                display: "flex", alignItems: "center", gap: 4,
              }}>
                {f.icon}{f.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4, background: "var(--bg2)", padding: 3, borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
            {REVIEW_FILTERS.map(f => (
              <button key={f} className="btn btn-xs" onClick={() => setReviewFilter(f)} style={{
                background: reviewFilter === f ? "#fff" : "transparent",
                color: reviewFilter === f ? "var(--text)" : "var(--text3)",
                border: reviewFilter === f ? "1px solid var(--border)" : "1px solid transparent",
                boxShadow: reviewFilter === f ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
              }}>
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
          <EmptyState
            projects={projects}
            tests={tests}
            search={search}
            reviewFilter={reviewFilter}
            onCreateTest={() => setShowCreateModal(true)}
            onClearSearch={() => setSearch("")}
            onClearFilters={() => { setSearch(""); setFilter("All"); setReviewFilter("All Tests"); }}
            navigate={navigate}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Test ID</th>
                <th>Test Name</th>
                <th>Status</th>
                <th>Last Run</th>
                <th>Project</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/tests/${t.id}`)}>
                  <td>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text3)" }}>
                      {t.id.slice(0, 8)}…
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <AgentTag type="TA" />
                      <div>
                        <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{t.name}</div>
                        {t.description && (
                          <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: 1, maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
                      <span
                        className="badge badge-gray"
                        style={{ cursor: "pointer" }}
                        onClick={e => { e.stopPropagation(); navigate(`/projects/${t.projectId}`); }}
                      >
                        {projMap[t.projectId].name}
                      </span>
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
        <RunAllModal projects={projects} onClose={() => setShowRunModal(false)} defaultProjectId={filtered[0]?.projectId || projects[0]?.id || ""} />
      )}
      {showReviewModal && (
        <ReviewModal projects={projects} onClose={() => setShowReviewModal(false)} />
      )}
    </div>
  );
}

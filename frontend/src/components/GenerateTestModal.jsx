/**
 * GenerateTestModal.jsx
 *
 * Drop-in replacement for the inline generate modal in Tests.jsx.
 * Adds a "Test Dials" tab alongside the existing "Story" tab so users
 * can configure AI generation behaviour before hitting Generate.
 *
 * Usage (same as before):
 *   <GenerateTestModal projects={projects} onClose={onClose} />
 */

import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { X, Upload, FileCode2, Clock, ChevronDown } from "lucide-react";
import { api } from "../api.js";
import TestDials from "./TestDials.jsx";
import { buildTestDialsPrompt, countActiveDials } from "./testDialsPrompt.js";

// ── Tab bar ───────────────────────────────────────────────────────────────────

function Tab({ label, badge, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: "10px 4px", background: "none", border: "none",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        color: active ? "var(--accent)" : "var(--text2)",
        fontWeight: active ? 600 : 400, fontSize: "0.875rem",
        cursor: "pointer", display: "flex", alignItems: "center",
        justifyContent: "center", gap: 6, marginBottom: -1,
        transition: "color 0.15s",
      }}
    >
      {label}
      {badge != null && (
        <span className="active-count-pill">
          {badge}
        </span>
      )}
    </button>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function GenerateTestModal({ projects = [], onClose }) {
  const navigate = useNavigate();
  const nameRef = useRef();

  const [tab, setTab] = useState("story");   // "story" | "dials"
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState("form");   // "form" | "submitting"
  const [error, setError] = useState(null);
  const [dialsConfig, setDialsConfig] = useState(null);

  // Active dial count for badge
  const [activeDialCount, setActiveDialCount] = useState(3);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 60);
  }, []);

  // Recount whenever dialsConfig changes
  useEffect(() => {
    setActiveDialCount(countActiveDials(dialsConfig));
  }, [dialsConfig]);

  async function handleGenerate(e) {
    e?.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Test name is required."); setTab("story"); return; }
    if (!projectId)   { setError("Please select a project."); setTab("story"); return; }

    setPhase("submitting");
    try {
      // Send dialsPrompt as a dedicated field (matching the crawl endpoint pattern)
      // instead of embedding it in the description string.
      const dialsPrompt = dialsConfig ? buildTestDialsPrompt(dialsConfig) : "";

      const { runId } = await api.generateTest(projectId, {
        name: name.trim(),
        description: description.trim(),
        dialsPrompt,
      });
      onClose();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err.message || "Failed to start generation.");
      setPhase("form");
    }
  }

  const selectedProject = projects.find(p => p.id === projectId);
  const canSubmit = name.trim() && projectId && phase !== "submitting";

  return (
    <>
      {/* Backdrop */}
      <div className="modal-backdrop" onClick={onClose} />

      {/* Modal */}
      <div className="modal-panel" style={{
        width: "min(560px, 96vw)", maxHeight: "92vh",
        display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "18px 22px 0", flexShrink: 0,
        }}>
          <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>
            Generate a Test Case
          </h2>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Tab bar */}
        <div style={{
          display: "flex", borderBottom: "1px solid var(--border)",
          padding: "0 22px", marginTop: 12, flexShrink: 0,
        }}>
          <Tab label="Story" active={tab === "story"} onClick={() => setTab("story")} />
          <Tab label="Test Dials" badge={activeDialCount} active={tab === "dials"} onClick={() => setTab("dials")} />
          <Tab label="Options" active={tab === "options"} onClick={() => setTab("options")} />
        </div>

        {/* Body */}
        <div style={{ overflowY: "auto", flex: 1, padding: "20px 22px" }}>

          {/* ── Story tab ── */}
          {tab === "story" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Story Input card */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Story Input</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-xs" style={{ gap: 5 }}>
                      <Upload size={11} /> Import Issue
                    </button>
                    <button className="btn btn-ghost btn-xs" style={{ gap: 5 }}>
                      <FileCode2 size={11} /> Import Code
                    </button>
                  </div>
                </div>

                {/* Project selector */}
                <div style={{ marginBottom: 12 }}>
                  <label className="dial-label" style={{ display: "block", marginBottom: 5 }}>
                    Project
                  </label>
                  <select
                    className="input"
                    value={projectId}
                    onChange={e => setProjectId(e.target.value)}
                    style={{ height: 38 }}
                  >
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  {selectedProject && (
                    <div style={{ fontSize: "0.72rem", color: "var(--text3)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                      {selectedProject.url}
                    </div>
                  )}
                </div>

                {/* Test name */}
                <div style={{ marginBottom: 12 }}>
                  <label className="dial-label" style={{ display: "block", marginBottom: 5 }}>
                    Test Name
                  </label>
                  <input
                    ref={nameRef}
                    className="input"
                    value={name}
                    onChange={e => { setName(e.target.value); if (error) setError(null); }}
                    placeholder="e.g. Dashboard loads all employee charts"
                    style={{ height: 38 }}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) handleGenerate(e); }}
                  />
                </div>

                {/* Description / story textarea */}
                <div style={{ marginBottom: 8 }}>
                  <label className="dial-label" style={{ display: "block", marginBottom: 5 }}>
                    Paste your User Stories, Issues, Epics, or Requirements here...
                  </label>
                  <textarea
                    className="input"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Paste your User Stories, Issues, Epics, or Requirements here..."
                    rows={6}
                    style={{ resize: "vertical", lineHeight: 1.6, paddingTop: 10 }}
                  />
                </div>

                {/* Attachments row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
                  <span style={{ fontSize: "0.78rem", color: "var(--text2)", fontWeight: 500 }}>Attachments</span>
                  <button className="btn btn-ghost btn-xs" style={{ gap: 5 }}>
                    <Upload size={11} /> Add Attachment
                  </button>
                </div>

                {/* Char count + examples */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                  <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                    {(name + description).length} chars
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-xs">📚 Examples</button>
                    <button className="btn btn-ghost btn-xs">
                      <Clock size={11} /> History (0)
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => { setName(""); setDescription(""); }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>

              {/* AI Generate section */}
              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>AI Generate Test Cases</span>
                  <span style={{ fontSize: "0.72rem", color: "var(--text3)", display: "flex", alignItems: "center", gap: 4 }}>
                    <Clock size={11} /> ~30-60 seconds
                  </span>
                </div>
                {error && (
                  <div className="alert-error" style={{ marginBottom: 12 }}>
                    {error}
                  </div>
                )}
                <button
                  className="btn btn-primary"
                  style={{ width: "100%", justifyContent: "center", fontWeight: 700, fontSize: "0.9rem" }}
                  onClick={handleGenerate}
                  disabled={!canSubmit}
                >
                  {phase === "submitting" ? "Starting…" : "Generate Test Cases"}
                </button>
              </div>
            </div>
          )}

          {/* ── Test Dials tab ── */}
          {tab === "dials" && (
            <div>
              <TestDials onChange={setDialsConfig} />

              {/* Generate CTA also on dials tab */}
              <div style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>AI Generate Test Cases</span>
                  <span style={{ fontSize: "0.72rem", color: "var(--text3)", display: "flex", alignItems: "center", gap: 4 }}>
                    <Clock size={11} /> ~30-60 seconds
                  </span>
                </div>
                {error && (
                  <div className="alert-error" style={{ marginBottom: 10 }}>
                    {error}
                  </div>
                )}
                <button
                  className="btn btn-primary"
                  style={{ width: "100%", justifyContent: "center", fontWeight: 700, fontSize: "0.9rem" }}
                  onClick={handleGenerate}
                  disabled={!canSubmit}
                >
                  {phase === "submitting" ? "Starting…" : "Generate Test Cases"}
                </button>
                {!name.trim() && (
                  <p style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text3)", marginTop: 8 }}>
                    ← Switch to Story tab and enter a test name first
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── Options tab ── */}
          {tab === "options" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, color: "var(--text2)", fontSize: "0.875rem" }}>
              <p style={{ color: "var(--text3)", fontSize: "0.82rem", lineHeight: 1.6 }}>
                Additional options for this generation run.
              </p>

              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" style={{ accentColor: "var(--accent)", width: 14, height: 14 }} />
                  <span style={{ fontSize: "0.85rem" }}>Save as Draft (require human review before running)</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" defaultChecked style={{ accentColor: "var(--accent)", width: 14, height: 14 }} />
                  <span style={{ fontSize: "0.85rem" }}>Generate Playwright automation code</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input type="checkbox" style={{ accentColor: "var(--accent)", width: 14, height: 14 }} />
                  <span style={{ fontSize: "0.85rem" }}>Add to Pull Request on completion</span>
                </label>
              </div>

              {/* Generate CTA on options tab too */}
              <div style={{ marginTop: 4 }}>
                <button
                  className="btn btn-primary"
                  style={{ width: "100%", justifyContent: "center", fontWeight: 700, fontSize: "0.9rem" }}
                  onClick={handleGenerate}
                  disabled={!canSubmit}
                >
                  {phase === "submitting" ? "Starting…" : "Generate Test Cases"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

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
import { Upload, FileCode2, Clock, X, Paperclip, Trash2 } from "lucide-react";
import { api } from "../api.js";
import ModalShell from "./ModalShell.jsx";
import TestDials from "./TestDials.jsx";
import { countActiveDials, loadSavedConfig } from "../utils/testDialsStorage.js";

const ACCEPTED_EXTENSIONS = ".txt,.md,.csv,.json,.xml,.html,.yml,.yaml,.feature,.gherkin";
const MAX_ATTACHMENT_SIZE = 100_000; // 100 KB — keeps the AI prompt manageable

// ── Generate CTA (single source of truth) ─────────────────────────────────────

function GenerateCTA({ error, canSubmit, phase, onGenerate, showNameHint }) {
  return (
    <div>
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
        onClick={onGenerate}
        disabled={!canSubmit}
      >
        {phase === "submitting" ? "Starting…" : "Generate Test Cases"}
      </button>
      {showNameHint && (
        <p style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text3)", marginTop: 8 }}>
          ← Switch to Story tab and enter a test name first
        </p>
      )}
    </div>
  );
}

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
  const [attachments, setAttachments] = useState([]);  // [{name, content}]
  const [phase, setPhase] = useState("form");   // "form" | "submitting"
  const [error, setError] = useState(null);
  const [dialsConfig, setDialsConfig] = useState(() => loadSavedConfig());
  const fileInputRef = useRef();

  // Active dial count for badge
  const [activeDialCount, setActiveDialCount] = useState(() => countActiveDials(loadSavedConfig()));

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 60);
  }, []);

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // reset so the same file can be re-selected
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        setError(`"${file.name}" is too large (${Math.round(file.size / 1000)} KB). Max is 100 KB.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result;
        setAttachments(prev => {
          if (prev.some(a => a.name === file.name)) return prev; // dedupe
          return [...prev, { name: file.name, content }];
        });
      };
      reader.onerror = () => setError(`Failed to read "${file.name}".`);
      reader.readAsText(file);
    }
  }

  function removeAttachment(fileName) {
    setAttachments(prev => prev.filter(a => a.name !== fileName));
  }

  // Recount whenever dialsConfig changes
  useEffect(() => {
    setActiveDialCount(countActiveDials(dialsConfig));
  }, [dialsConfig]);

  async function handleGenerate(e) {
    e?.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Test name is required."); setTab("story"); return; }
    if (!projectId)   { setError("Please select a project."); setTab("story"); return; }

    // Merge attachment content into the description so it reaches the AI prompt.
    // The backend pipes `description` directly into userRequestedPrompt.js — no
    // backend changes needed.
    let fullDescription = description.trim();
    if (attachments.length > 0) {
      const attachmentBlock = attachments
        .map(a => `--- Attached file: ${a.name} ---\n${a.content}`)
        .join("\n\n");
      fullDescription = fullDescription
        ? `${fullDescription}\n\n${attachmentBlock}`
        : attachmentBlock;
    }

    setPhase("submitting");
    try {
      // Send the structured config object — the backend validates it and builds
      // the prompt server-side via resolveDialsPrompt(), matching the crawl endpoint.
      const { runId } = await api.generateTest(projectId, {
        name: name.trim(),
        description: fullDescription,
        dialsConfig: dialsConfig || undefined,
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
    <ModalShell onClose={onClose} width="min(560px, 96vw)" style={{ maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
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

                {/* Attachments */}
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "0.78rem", color: "var(--text2)", fontWeight: 500 }}>
                      Attachments {attachments.length > 0 && `(${attachments.length})`}
                    </span>
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ gap: 5 }}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Paperclip size={11} /> Add Attachment
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={ACCEPTED_EXTENSIONS}
                      multiple
                      onChange={handleFileSelect}
                      style={{ display: "none" }}
                    />
                  </div>
                  {attachments.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                      {attachments.map(a => (
                        <div key={a.name} style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "5px 10px", background: "var(--bg2)",
                          border: "1px solid var(--border)", borderRadius: "var(--radius)",
                          fontSize: "0.78rem",
                        }}>
                          <Paperclip size={11} color="var(--text3)" style={{ flexShrink: 0 }} />
                          <span style={{ flex: 1, color: "var(--text)", overflow: "hidden",
                            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {a.name}
                          </span>
                          <span style={{ fontSize: "0.7rem", color: "var(--text3)", flexShrink: 0 }}>
                            {Math.round(a.content.length / 1000)}k chars
                          </span>
                          <button
                            onClick={() => removeAttachment(a.name)}
                            style={{ background: "none", border: "none", cursor: "pointer",
                              color: "var(--text3)", padding: 0, display: "flex" }}
                            title="Remove attachment"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Char count + examples */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                  <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                    {(name + description).length} chars{attachments.length > 0 && ` + ${attachments.reduce((n, a) => n + a.content.length, 0)} from attachments`}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-ghost btn-xs">📚 Examples</button>
                    <button className="btn btn-ghost btn-xs">
                      <Clock size={11} /> History (0)
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => { setName(""); setDescription(""); setAttachments([]); }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>

              {/* AI Generate section */}
              <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 16 }}>
                <GenerateCTA error={error} canSubmit={canSubmit} phase={phase} onGenerate={handleGenerate} />
              </div>
            </div>
          )}

          {/* ── Test Dials tab ── */}
          {tab === "dials" && (
            <div>
              <TestDials onChange={setDialsConfig} />

              {/* Generate CTA also on dials tab */}
              <div style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                <GenerateCTA error={error} canSubmit={canSubmit} phase={phase} onGenerate={handleGenerate} showNameHint={!name.trim()} />
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
                <GenerateCTA error={error} canSubmit={canSubmit} phase={phase} onGenerate={handleGenerate} />
              </div>
            </div>
          )}
        </div>
    </ModalShell>
  );
}

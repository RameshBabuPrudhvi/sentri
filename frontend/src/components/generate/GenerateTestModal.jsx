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
import { Upload, Clock, X, Paperclip, Trash2 } from "lucide-react";
import { api } from "../api.js";
import ModalShell from "../shared/ModalShell.jsx";
import TestDials from "../shared/TestDials.jsx";
import { countActiveDials, loadSavedConfig } from "../utils/testDialsStorage.js";
import ExploreModePicker from "./ExploreModePicker.jsx";

const ACCEPTED_EXTENSIONS = ".txt,.md,.csv,.json,.xml,.html,.yml,.yaml,.feature,.gherkin";
const MAX_ATTACHMENT_SIZE  = 40_000;    // 40 KB per file
const MAX_TOTAL_ATTACHMENT = 45_000;    // 45 KB cumulative — backend caps description at 50 KB

// MIME types that are safe to read as text — anything else is rejected.
const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/x-yaml", "application/yaml"];
const TEXT_MIME_EXACT = new Set([
  "text/plain", "text/csv", "text/html", "text/markdown", "text/xml", "text/yaml",
  "application/json", "application/xml", "application/x-yaml", "application/yaml",
]);

// ── Sample prompts for the Examples popover ─────────────────────────────────────

const EXAMPLE_PROMPTS = [
  {
    name: "User login with valid credentials",
    description: "As a registered user I want to log in with my email and password so that I reach the dashboard. Verify the login form accepts valid credentials, redirects to /dashboard, and displays the user's name in the header.",
  },
  {
    name: "Add item to cart and update quantity",
    description: "As a shopper I want to add a product to my cart and change the quantity so that the cart total updates correctly. Cover adding from the product page, incrementing/decrementing quantity, and verifying the subtotal recalculates.",
  },
  {
    name: "Search returns relevant results",
    description: "As a user I want to search for a keyword and see matching results so I can find what I need. Verify the search input accepts text, results load within 3 seconds, each result contains the search term, and an empty query shows a helpful empty state.",
  },
  {
    name: "Form validation blocks invalid submission",
    description: "As a user filling out the contact form I expect validation errors when I submit with empty required fields or an invalid email format. Verify each error message appears next to the correct field, the form does not submit, and errors clear when corrected.",
  },
  {
    name: "Responsive navigation menu on mobile",
    description: "As a mobile user I want the hamburger menu to open and close correctly so I can navigate the site. Verify the menu toggle works, all primary links are visible, clicking a link navigates to the correct page, and the menu closes after selection.",
  },
  {
    name: "Password reset email flow",
    description: "As a user who forgot my password I want to request a reset link, receive a confirmation message, and be able to set a new password. Verify the forgot-password page accepts an email, shows a success toast, rejects invalid email formats, and rate-limits repeated requests.",
  },
];

// ── Toggle switch (used by Options tab) ──────────────────────────────────────

function Toggle({ value, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      style={{
        width: 38, height: 22, borderRadius: 11, border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        background: value ? "var(--accent)" : "var(--bg3, #d1d5db)",
        position: "relative", flexShrink: 0, transition: "background 0.2s",
        opacity: disabled ? 0.5 : 1,
      }}
      title={disabled ? "Assignee disabled" : undefined}
    >
      <span style={{
        position: "absolute", top: 3, left: value ? 19 : 3,
        width: 16, height: 16, borderRadius: "50%", background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

// ── Generate CTA (single source of truth) ─────────────────────────────────────

function GenerateCTA({ canSubmit, phase, onGenerate, showNameHint }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>AI Generate Test Cases</span>
        <span style={{ fontSize: "0.72rem", color: "var(--text3)", display: "flex", alignItems: "center", gap: 4 }}>
          <Clock size={11} /> ~30-60 seconds
        </span>
      </div>
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
  const [showExamples, setShowExamples] = useState(false);
  const [showImportIssue, setShowImportIssue] = useState(false);
  const [importIssueText, setImportIssueText] = useState("");
  const fileInputRef = useRef();

  // Active dial count for badge
  const [activeDialCount, setActiveDialCount] = useState(() => countActiveDials(loadSavedConfig()));

  // ── Options tab state (must live at top level — no hooks in conditionals) ──
  const [splitByAC, setSplitByAC] = useState(true);
  const [stepsAsTables, setStepsAsTables] = useState(false);
  const [prependKey, setPrependKey] = useState(true);
  const [assigneeEnabled, setAssigneeEnabled] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [folderOverride, setFolderOverride] = useState("");
  const [autoSync, setAutoSync] = useState(false);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 60);
  }, []);

  function isTextMime(file) {
    const mime = (file.type || "").toLowerCase();
    // Files with no MIME (e.g. .feature, .gherkin) — allow if extension is in the accept list
    if (!mime) return true;
    if (TEXT_MIME_EXACT.has(mime)) return true;
    if (TEXT_MIME_PREFIXES.some(p => mime.startsWith(p))) return true;
    return false;
  }

  function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // reset so the same file can be re-selected
    for (const file of files) {
      if (!isTextMime(file)) {
        setError(`"${file.name}" appears to be a binary file (${file.type || "unknown type"}). Only text-based files are supported.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_SIZE) {
        setError(`"${file.name}" is too large (${Math.round(file.size / 1000)} KB). Max is 40 KB per file.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const raw = reader.result;
        // Detect binary content that slipped through MIME check — if more than 5%
        // of the first 1 KB is non-printable, reject it.
        const sample = raw.slice(0, 1024);
        const nonPrintable = [...sample].filter(c => {
          const code = c.charCodeAt(0);
          return code < 32 && code !== 9 && code !== 10 && code !== 13; // allow tab, LF, CR
        }).length;
        if (sample.length > 0 && nonPrintable / sample.length > 0.05) {
          setError(`"${file.name}" contains binary data and cannot be used as a text attachment.`);
          return;
        }
        // Strip common prompt-injection markers (mirrors backend testDials.js sanitisation)
        const content = raw
          .replace(/^(SYSTEM|ASSISTANT|USER|HUMAN|AI)\s*:/gim, "")
          .replace(/```/g, "");
        setAttachments(prev => {
          if (prev.some(a => a.name === file.name)) return prev; // dedupe
          const totalSize = prev.reduce((n, a) => n + a.content.length, 0) + content.length;
          if (totalSize > MAX_TOTAL_ATTACHMENT) {
            setError(`Total attachment size would exceed 45 KB. Remove an existing file first.`);
            return prev;
          }
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

  function applyExample(ex) {
    setName(ex.name);
    setDescription(ex.description);
    setShowExamples(false);
    if (error) setError(null);
  }

  // Parse pasted Jira / issue text into name + description.
  // Accepts formats like:
  //   "PROJ-123 Login fails for SSO users\nAs a user..."  (key + title on first line)
  //   "Login fails for SSO users\nAs a user..."           (just title on first line)
  function handleImportIssue() {
    const raw = importIssueText.trim();
    if (!raw) return;
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    // First line → test name (strip leading Jira key like "PROJ-123 " if present)
    const firstLine = lines[0] || "";
    const parsedName = firstLine.replace(/^[A-Z][A-Z0-9]+-\d+\s*[-:.]?\s*/, "").trim();
    // Remaining lines → description
    const parsedDesc = lines.slice(1).join("\n").trim();
    if (parsedName) setName(parsedName);
    if (parsedDesc) setDescription(prev => prev ? `${prev}\n\n${parsedDesc}` : parsedDesc);
    setImportIssueText("");
    setShowImportIssue(false);
    if (error) setError(null);
  }

  // Close examples popover on outside click
  useEffect(() => {
    if (!showExamples) return;
    function close(e) {
      if (!e.target.closest("[data-examples-popover]")) setShowExamples(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showExamples]);

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
      // Pre-flight: check if an AI provider is configured before calling the LLM
      const config = await api.getConfig().catch(() => null);
      if (!config?.hasProvider) {
        setError("No AI provider configured — go to Settings to add an API key or enable Ollama.");
        setPhase("form");
        return;
      }
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
    <ModalShell onClose={onClose} width="min(560px, 96vw)" style={{ height: "min(92vh, calc(100vh - 32px))" }}>
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

        {/* Persistent error banner — visible on all tabs, never lost on tab switch */}
        {error && (
          <div style={{ padding: "0 22px", flexShrink: 0 }}>
            <div className="alert-error" style={{ marginTop: 12 }}>
              {error}
            </div>
          </div>
        )}

        {/* Body — minHeight:0 required for flex child to shrink below content size */}
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "20px 22px" }}>

          {/* ── Story tab ── */}
          {tab === "story" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Story Input card */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>Story Input</span>
                  <button
                    className="btn btn-ghost btn-xs"
                    style={{ gap: 5 }}
                    onClick={() => setShowImportIssue(v => !v)}
                  >
                    <Upload size={11} /> Import Issue
                  </button>
                </div>

                {/* Import Issue panel — paste Jira issue text */}
                {showImportIssue && (
                  <div style={{
                    marginBottom: 12, padding: 12, background: "var(--bg2)",
                    border: "1px solid var(--border)", borderRadius: "var(--radius)",
                    display: "flex", flexDirection: "column", gap: 8,
                  }}>
                    <div style={{ fontSize: "0.78rem", color: "var(--text2)", fontWeight: 500 }}>
                      Paste a Jira issue (title on first line, description below)
                    </div>
                    <textarea
                      className="input"
                      value={importIssueText}
                      onChange={e => setImportIssueText(e.target.value)}
                      placeholder={"PROJ-123 Login fails for SSO users\nAs a user with SSO enabled, I expect to be redirected to the IdP and returned to the dashboard after authentication..."}
                      rows={4}
                      style={{ resize: "vertical", lineHeight: 1.5, paddingTop: 8, fontSize: "0.82rem" }}
                      autoFocus
                    />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => { setShowImportIssue(false); setImportIssueText(""); }}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary btn-xs"
                        onClick={handleImportIssue}
                        disabled={!importIssueText.trim()}
                      >
                        Import
                      </button>
                    </div>
                  </div>
                )}

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
                    onChange={e => setName(e.target.value)}
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

                {/* Char count + actions */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                  <span style={{ fontSize: "0.72rem", color: "var(--text3)" }}>
                    {(name + description).length} chars{attachments.length > 0 && ` + ${attachments.reduce((n, a) => n + a.content.length, 0)} from attachments`}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div data-examples-popover style={{ position: "relative" }}>
                      <button
                        className="btn btn-ghost btn-xs"
                        style={{
                          display: "flex", alignItems: "center", gap: 5,
                          background: showExamples ? "var(--bg2)" : undefined,
                          border: showExamples ? "1px solid var(--border)" : undefined,
                          borderRadius: 6, padding: "4px 8px",
                        }}
                        onClick={() => setShowExamples(v => !v)}
                      >
                        {showExamples && (
                          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" style={{ flexShrink: 0 }}>
                            <path d="M2 5.5L4.5 8L9 3" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                        Examples
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
                          <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                      {showExamples && (
                        <div className="gen-examples-popover" style={{
                          position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                          width: 340, maxHeight: 320, overflowY: "auto",
                          background: "var(--surface)", border: "1px solid var(--border)",
                          borderRadius: "var(--radius)", boxShadow: "var(--shadow)",
                          zIndex: 300, padding: 4,
                        }}>
                          <div style={{ fontSize: "0.7rem", color: "var(--text3)", padding: "6px 10px 4px",
                            fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase" }}>
                            Click to fill — you can edit before generating
                          </div>
                          {EXAMPLE_PROMPTS.map((ex, i) => {
                            const isActive = name === ex.name;
                            return (
                              <button
                                key={i}
                                onClick={() => applyExample(ex)}
                                style={{
                                  width: "100%", textAlign: "left", padding: "8px 10px",
                                  background: isActive ? "var(--accent-bg)" : "none",
                                  border: "none", cursor: "pointer",
                                  borderRadius: 6, display: "flex", alignItems: "flex-start", gap: 8,
                                }}
                                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "var(--bg2)"; }}
                                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "none"; }}
                              >
                                <span style={{
                                  flexShrink: 0, width: 14, height: 14, marginTop: 2,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                }}>
                                  {isActive && (
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                      <path d="M2 6L5 9L10 3" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: "0.82rem", fontWeight: 500, color: isActive ? "var(--accent)" : "var(--text)" }}>
                                    {ex.name}
                                  </div>
                                  <div style={{ fontSize: "0.72rem", color: "var(--text3)", lineHeight: 1.4,
                                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                                    overflow: "hidden", marginTop: 2 }}>
                                    {ex.description}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
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
                <GenerateCTA canSubmit={canSubmit} phase={phase} onGenerate={handleGenerate} />
              </div>
            </div>
          )}

          {/* ── Test Dials tab ── */}
          {tab === "dials" && (
            <div>
              <TestDials value={dialsConfig} onChange={setDialsConfig} />

              {/* Generate CTA also on dials tab */}
              <div style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                <GenerateCTA canSubmit={canSubmit} phase={phase} onGenerate={handleGenerate} showNameHint={!name.trim()} />
              </div>
            </div>
          )}

          {/* ── Options tab ── */}
          {tab === "options" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 16 }}>
                Test Generation Settings
              </div>

              <ExploreModePicker value={dialsConfig} onChange={setDialsConfig} />

              {/* Divider */}
              <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0 16px" }} />

              {/* Toggle row */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.82rem", color: "var(--text2)" }}>
                  <Toggle value={splitByAC} onChange={setSplitByAC} />
                  Split by Acceptance Criteria
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.82rem", color: "var(--text2)" }}>
                  <Toggle value={stepsAsTables} onChange={setStepsAsTables} />
                  Steps as Tables
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.82rem", color: "var(--text2)" }}>
                  <Toggle value={prependKey} onChange={setPrependKey} />
                  Prepend Key
                </label>
              </div>

              {/* Divider */}
              <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0 16px" }} />

              {/* Set Assignee + Folder Override */}
              <div className="gen-options-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer", fontSize: "0.82rem", color: "var(--text2)" }}>
                    <input
                      type="checkbox"
                      checked={assigneeEnabled}
                      onChange={e => setAssigneeEnabled(e.target.checked)}
                      style={{ accentColor: "var(--accent)", width: 13, height: 13 }}
                    />
                    Set Assignee
                  </label>
                  <input
                    className="input"
                    value={assignee}
                    onChange={e => setAssignee(e.target.value)}
                    placeholder="Assignee disabled"
                    disabled={!assigneeEnabled}
                    style={{ height: 34, fontSize: "0.82rem", opacity: assigneeEnabled ? 1 : 0.5 }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: 8, fontSize: "0.82rem", color: "var(--text2)", fontWeight: 500 }}>
                    Folder Override <span style={{ color: "var(--text3)", fontWeight: 400 }}>(optional)</span>
                  </label>
                  <input
                    className="input"
                    value={folderOverride}
                    onChange={e => setFolderOverride(e.target.value)}
                    placeholder="Leave empty to auto-derive from story"
                    style={{ height: 34, fontSize: "0.82rem" }}
                  />
                </div>
              </div>

              {/* Divider */}
              <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0 16px" }} />

              {/* Auto-sync */}
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.82rem", color: "var(--text2)" }}>
                <Toggle value={autoSync} onChange={setAutoSync} />
                Auto-sync to Test Management
              </label>

              {/* Generate CTA */}
              <div style={{ marginTop: 24 }}>
                <GenerateCTA canSubmit={canSubmit} phase={phase} onGenerate={handleGenerate} />
              </div>
            </div>
          )}
        </div>
    </ModalShell>
  );
}

/**
 * @module components/test/CodeEditorModal
 * @description Full-screen Playwright code editor modal with syntax highlighting,
 * line numbers, copy/download/save actions, and keyboard shortcuts.
 *
 * Extracted from TestDetail.jsx to reduce page-level complexity.
 */

import React, { useState, useRef } from "react";
import {
  CheckCircle2, RefreshCw, RotateCcw, X, Save,
} from "lucide-react";
import { api } from "../../api.js";
import { cleanTestName } from "../../utils/formatTestName.js";
import highlightCode from "../../utils/highlightCode.js";

/**
 * @param {Object} props
 * @param {Object} props.test - The test object (needs .name, .playwrightCode, .codeRegeneratedAt).
 * @param {string} props.testId - Test ID for API calls.
 * @param {Function} props.onClose - Called when the modal should close.
 * @param {Function} props.onSaved - Called with the updated test object after a successful save.
 */
export default function CodeEditorModal({ test, testId, onClose, onSaved }) {
  const [editedCode, setEditedCode]         = useState(test.playwrightCode || "");
  const [codeSaving, setCodeSaving]         = useState(false);
  const [codeSaveError, setCodeSaveError]   = useState(null);
  const [codeSaveSuccess, setCodeSaveSuccess] = useState(false);
  const [cursorPos, setCursorPos]           = useState({ line: 1, col: 1 });
  const [copySuccess, setCopySuccess]       = useState(false);

  const editorScrollRef = useRef(null);
  const lineNumRef = useRef(null);

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
    if (e.key === "Escape") {
      e.target.blur();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const newVal = val.substring(0, start) + "  " + val.substring(end);
      setEditedCode(newVal);
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
      onSaved(updated);
      setCodeSaveSuccess(true);
      setTimeout(() => setCodeSaveSuccess(false), 2500);
    } catch (err) {
      setCodeSaveError(err.message || "Failed to save code.");
    } finally {
      setCodeSaving(false);
    }
  }

  return (
    <div
      className="td-editor-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={e => { if (e.key === "Escape") onClose(); }}
    >
      <div className="td-editor-panel">

        {/* ── Header ── */}
        <div className="td-editor-header">
          <div className="td-editor-lang-pill">
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#7c6af5", flexShrink: 0, display: "inline-block" }} />
            TypeScript
          </div>

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

          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
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

            <button
              onClick={onClose}
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
        <div className="td-editor-tab-bar">
          <div className="td-editor-tab">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="12" height="12" rx="2" stroke="#7c6af5" strokeWidth="1.2"/>
              <path d="M5 8h6M8 5v6" stroke="#7c6af5" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            {(test.name || "test").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.spec.ts
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#7c6af5", display: "inline-block" }} />
          </div>
        </div>

        {/* ── Info bar ── */}
        <div className="td-editor-info-bar">
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>{editedCode.split("\n").length} lines</span>
            <span>·</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>UTF-8</span>
            <span>·</span>
            <span>Tab inserts 2 spaces</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
            <kbd className="td-kbd">Esc</kbd>
            <span style={{ fontSize: "0.65rem", color: "#4a5070" }}>to close</span>
          </div>
        </div>

        {/* ── Editor: line numbers + highlighted overlay ── */}
        <div className="td-editor-body">
          <div ref={lineNumRef} className="td-editor-line-nums">
            {editedCode.split("\n").map((_, i) => (
              <div key={i} style={{
                padding: "0 10px",
                color: i + 1 === cursorPos.line ? "#7c6af5" : "#3a3f5c",
              }}>{i + 1}</div>
            ))}
          </div>

          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            <pre
              ref={editorScrollRef}
              aria-hidden="true"
              className="td-editor-highlight"
              dangerouslySetInnerHTML={{ __html: highlightCode(editedCode) + "\n" }}
            />
            <textarea
              className="td-editor-textarea"
              value={editedCode}
              onChange={e => setEditedCode(e.target.value)}
              onClick={handleCursorMove}
              onKeyUp={handleCursorMove}
              onKeyDown={handleTabKey}
              onScroll={handleEditorScroll}
              spellCheck={false}
              aria-label="Code editor — Tab inserts spaces, press Escape to exit"
            />
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="td-editor-footer">
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

          <button className="td-editor-footer-btn" onClick={() => { setEditedCode(test.playwrightCode || ""); }}>
            <RotateCcw size={12} /> Discard
          </button>
          <button className="td-editor-footer-btn" onClick={onClose}>
            <X size={12} /> Close
          </button>
          <button
            className="td-editor-save-btn"
            onClick={handleSaveCode}
            disabled={codeSaving}
            style={{ opacity: codeSaving ? 0.7 : 1 }}
          >
            {codeSaving ? <RefreshCw size={13} className="spin" /> : <Save size={13} />}
            {codeSaving ? "Saving…" : "Save code"}
          </button>
        </div>

      </div>
    </div>
  );
}

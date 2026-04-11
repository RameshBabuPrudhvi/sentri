/**
 * @module components/test/InlineCodeEditor
 * @description Inline Playwright code editor with syntax highlighting, line
 * numbers, and Tab-to-indent support. Used in TestDetail's edit-mode Source tab.
 *
 * Extracted from TestDetail.jsx to reduce page-level complexity.
 */

import React, { useRef } from "react";
import highlightCode from "../../utils/highlightCode.js";

/**
 * @param {Object}   props
 * @param {string}   props.code       - Current code value.
 * @param {boolean}  props.modified   - Whether the user has touched the code.
 * @param {function} props.onChange    - Called with the new code string on every edit.
 */
export default function InlineCodeEditor({ code, modified, onChange }) {
  const editorRef    = useRef(null);
  const highlightRef = useRef(null);
  const lineNumRef   = useRef(null);

  function handleScroll(e) {
    const { scrollTop, scrollLeft } = e.target;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
    }
    if (lineNumRef.current) lineNumRef.current.scrollTop = scrollTop;
  }

  function handleKeyDown(e) {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = ta.value.substring(0, start) + "  " + ta.value.substring(end);
      onChange(newVal);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
    }
  }

  return (
    <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #1e2130" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 12px",
        background: "#0d0f17", borderBottom: "1px solid #1e2130",
        fontSize: "0.7rem", color: "#4a5070",
      }}>
        <span style={{ fontFamily: "var(--font-mono)" }}>{code.split("\n").length} lines</span>
        <span>·</span>
        <span>Tab inserts 2 spaces</span>
        {modified && <span style={{ marginLeft: "auto", color: "#f59e0b", fontWeight: 600 }}>● Modified</span>}
      </div>
      <div style={{ display: "flex", background: "#13151c", minHeight: 280, maxHeight: 500, overflow: "hidden" }}>
        <div
          ref={lineNumRef}
          style={{
            padding: "14px 0", minWidth: 44, flexShrink: 0,
            textAlign: "right",
            fontFamily: "'Fira Code', 'Cascadia Code', monospace",
            fontSize: "0.76rem", lineHeight: 1.75,
            color: "#3a3f5c", borderRight: "1px solid #1e2130",
            userSelect: "none", overflowY: "hidden", overflowX: "hidden",
          }}
        >
          {code.split("\n").map((_, i) => (
            <div key={i} style={{ padding: "0 10px" }}>{i + 1}</div>
          ))}
        </div>
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <pre
            ref={highlightRef}
            aria-hidden="true"
            style={{
              position: "absolute", inset: 0,
              margin: 0, padding: "14px 16px",
              fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
              fontSize: "0.76rem", lineHeight: 1.75,
              color: "#cdd5f0", whiteSpace: "pre",
              overflowX: "hidden", overflowY: "hidden",
              pointerEvents: "none", background: "transparent",
              border: "none", outline: "none",
            }}
            dangerouslySetInnerHTML={{ __html: highlightCode(code) + "\n" }}
          />
          <textarea
            ref={editorRef}
            value={code}
            onChange={e => onChange(e.target.value)}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
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
              whiteSpace: "pre", overflowX: "auto", overflowY: "auto",
            }}
            aria-label="Inline code editor"
          />
        </div>
      </div>
    </div>
  );
}
/**
 * AiFixPanel — AI-powered test auto-fix panel
 *
 * Streams the AI-generated fix, shows a live diff (original vs fixed),
 * and provides Apply / Discard actions.
 *
 * Props:
 *   testId       — test ID to fix
 *   originalCode — the current playwrightCode
 *   onApplied    — called with the updated test object after apply
 *   onClose      — called when the panel is dismissed
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Wand2, Check, X, RefreshCw, AlertTriangle } from "lucide-react";
import { api } from "../api.js";
import DiffView from "./DiffView.jsx";

export default function AiFixPanel({ testId, originalCode, onApplied, onClose }) {
  const [streaming, setStreaming] = useState(true);
  const [tokens, setTokens] = useState("");
  const [fixedCode, setFixedCode] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const abortRef = useRef(null);
  const streamBoxRef = useRef(null);

  // Guard: if the test has no Playwright code, show an informative message
  // instead of firing a fix request that will return a 400.
  if (!originalCode) {
    return (
      <div className="card" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--accent)", borderRadius: 10 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 16px",
          background: "var(--accent-bg)",
          borderBottom: "1px solid rgba(91,110,245,0.2)",
        }}>
          <Wand2 size={15} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--accent)", flex: 1 }}>
            AI Fix — unavailable
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text3)", padding: 4, display: "flex" }} title="Close">
            <X size={15} />
          </button>
        </div>
        <div style={{ padding: "14px 16px", fontSize: "0.83rem", color: "var(--text2)" }}>
          <AlertTriangle size={14} style={{ marginRight: 6, color: "var(--yellow)" }} />
          This test has no Playwright code yet. Edit the test and save to generate code, then use AI Fix.
        </div>
        <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)", justifyContent: "flex-end" }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={13} /> Close</button>
        </div>
      </div>
    );
  }

  // Start streaming on mount
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    api.fixTest(
      testId,
      // onToken
      (token) => {
        setTokens((prev) => prev + token);
      },
      // onDone
      (result) => {
        setFixedCode(result.fixedCode);
        setExplanation(result.explanation);
        setStreaming(false);
      },
      // onError
      (errMsg) => {
        setError(errMsg);
        setStreaming(false);
      },
      controller.signal,
    ).catch((err) => {
      if (err.name !== "AbortError") {
        setError(err.message || "Fix request failed.");
        setStreaming(false);
      }
    });

    return () => {
      controller.abort();
    };
  }, [testId]);

  // Auto-scroll the streaming output
  useEffect(() => {
    if (streamBoxRef.current) {
      streamBoxRef.current.scrollTop = streamBoxRef.current.scrollHeight;
    }
  }, [tokens]);

  const handleApply = useCallback(async () => {
    if (!fixedCode || applying) return;
    setApplying(true);
    try {
      const updated = await api.applyTestFix(testId, fixedCode);
      onApplied?.(updated);
    } catch (err) {
      setError(err.message || "Failed to apply fix.");
    } finally {
      setApplying(false);
    }
  }, [testId, fixedCode, applying, onApplied]);

  const handleDiscard = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    onClose?.();
  }, [onClose]);

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--accent)", borderRadius: 10 }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "12px 16px",
        background: "var(--accent-bg)",
        borderBottom: "1px solid rgba(91,110,245,0.2)",
      }}>
        <Wand2 size={15} color="var(--accent)" />
        <span style={{ fontWeight: 700, fontSize: "0.88rem", color: "var(--accent)", flex: 1 }}>
          AI Fix {streaming ? "— generating…" : fixedCode ? "— ready" : ""}
        </span>
        {streaming && <RefreshCw size={13} className="spin" color="var(--accent)" />}
        <button
          onClick={handleDiscard}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text3)", padding: 4, display: "flex",
          }}
          title="Close"
        >
          <X size={15} />
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 16px",
          background: "var(--red-bg)", color: "var(--red)",
          fontSize: "0.82rem",
        }}>
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* Streaming output (shown while streaming, before final diff) */}
      {streaming && (
        <>
          <div style={{
            padding: "8px 16px",
            fontSize: "0.78rem", color: "var(--text3)",
            background: "var(--bg2)",
            borderBottom: "1px solid var(--border)",
          }}>
            🔍 Analyzing the failure and generating a fix. The final diff and explanation will appear when complete.
          </div>
          <div
            ref={streamBoxRef}
            style={{
              maxHeight: 300, overflowY: "auto",
              padding: "12px 16px",
              fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
              fontSize: "0.76rem", lineHeight: 1.7,
              color: "#cdd5f0", background: "#13151c",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}
          >
            {tokens || "Analyzing failure and generating fix…"}
          </div>
        </>
      )}

      {/* Diff view (shown after streaming completes) */}
      {!streaming && fixedCode && (
        <div style={{ padding: "12px 16px" }}>
          {explanation && (
            <div style={{
              fontSize: "0.82rem", color: "var(--text2)",
              marginBottom: 12, padding: "10px 12px",
              background: "var(--bg2)", borderRadius: 6,
              border: "1px solid var(--border)",
            }}>
              <div style={{ fontWeight: 700, fontSize: "0.75rem", color: "var(--text3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                What was fixed
              </div>
              {explanation}
            </div>
          )}
          <div style={{ fontWeight: 600, fontSize: "0.75rem", color: "var(--text3)", marginBottom: 6 }}>
            Code changes
          </div>
          <DiffView before={originalCode} after={fixedCode} />
        </div>
      )}

      {/* Actions */}
      {!streaming && fixedCode && !error && (
        <div style={{
          display: "flex", gap: 8, padding: "12px 16px",
          borderTop: "1px solid var(--border)",
          justifyContent: "flex-end",
        }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleDiscard}
            disabled={applying}
          >
            <X size={13} /> Discard
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleApply}
            disabled={applying}
          >
            {applying
              ? <><RefreshCw size={13} className="spin" /> Applying…</>
              : <><Check size={13} /> Apply Fix</>
            }
          </button>
        </div>
      )}

      {/* Discard only — shown when error or no fix */}
      {!streaming && !fixedCode && (
        <div style={{
          display: "flex", gap: 8, padding: "12px 16px",
          borderTop: "1px solid var(--border)",
          justifyContent: "flex-end",
        }}>
          <button className="btn btn-ghost btn-sm" onClick={handleDiscard}>
            <X size={13} /> Close
          </button>
        </div>
      )}
    </div>
  );
}
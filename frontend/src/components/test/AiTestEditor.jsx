import React, { useState, Suspense, lazy, useRef, useEffect } from "react";
import { RefreshCw, Save, Wand2 } from "lucide-react";
import { api } from "../../api.js";
import extractCodeBlock from "../../utils/extractCodeBlock.js";

const DiffView = lazy(() => import("../ai/DiffView.jsx"));

export default function AiTestEditor({ test, testId, onApplied }) {
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiCodeProposal, setAiCodeProposal] = useState("");
  const [aiEditing, setAiEditing] = useState(false);
  const [aiError, setAiError] = useState("");
  const abortRef = useRef(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleAiEditRequest() {
    if (!aiPrompt.trim() || !test?.playwrightCode) return;
    setAiEditing(true);
    setAiError("");
    setAiCodeProposal("");
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    try {
      let raw = "";
      let hadError = false;
      await api.chat(
        [{ role: "user", content: aiPrompt.trim() }],
        (token) => { raw += token; },
        (message) => { hadError = true; setAiError(message || "AI edit failed."); },
        abortRef.current.signal,
        {
          mode: "test_edit",
          testName: test.name || "",
          testSteps: test.steps || [],
          testCode: test.playwrightCode || "",
        },
      );
      if (hadError) return;
      const code = extractCodeBlock(raw);
      if (!code) {
        setAiError("AI response did not include updated code. Try a more specific instruction.");
        return;
      }
      setAiCodeProposal(code);
    } catch (err) {
      setAiError(err.message || "AI edit failed.");
    } finally {
      setAiEditing(false);
    }
  }

  async function applyAiCodeProposal() {
    if (!aiCodeProposal.trim()) return;
    setAiEditing(true);
    setAiError("");
    try {
      const updated = await api.updateTest(testId, { playwrightCode: aiCodeProposal });
      setAiPrompt("");
      setAiCodeProposal("");
      onApplied?.(updated);
    } catch (err) {
      setAiError(err.message || "Failed to apply AI edit.");
    } finally {
      setAiEditing(false);
    }
  }

  if (!test?.playwrightCode) return null;

  return (
    <div style={{ marginBottom: 16, border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "var(--bg2)" }}>
      <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: 8 }}>Edit with AI</div>
      <textarea
        className="input"
        rows={3}
        value={aiPrompt}
        onChange={(e) => setAiPrompt(e.target.value)}
        placeholder="Example: Add an assertion that cart total updates after quantity change."
        style={{ marginBottom: 8 }}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={handleAiEditRequest} disabled={aiEditing || !aiPrompt.trim()}>
          {aiEditing ? <RefreshCw size={14} className="spin" /> : <Wand2 size={14} />} Generate edit
        </button>
        {aiCodeProposal && (
          <button className="btn btn-sm" onClick={applyAiCodeProposal} disabled={aiEditing}>
            <Save size={14} /> Apply
          </button>
        )}
      </div>
      {aiError && <div style={{ color: "var(--red)", fontSize: "0.75rem", marginBottom: 8 }}>{aiError}</div>}
      {aiCodeProposal && (
        <Suspense fallback={<div style={{ height: 60, background: "var(--bg3)", borderRadius: 6 }} />}>
          <DiffView before={test.playwrightCode || ""} after={aiCodeProposal} />
        </Suspense>
      )}
    </div>
  );
}

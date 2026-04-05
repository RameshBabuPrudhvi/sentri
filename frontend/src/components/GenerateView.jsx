import React from "react";
import LLMStreamPanel from "./LLMStreamPanel.jsx";
import useLogBuffer from "../hooks/useLogBuffer.js";
import PipelineCard from "./PipelineCard.jsx";
import GenerationSuccessBanner from "./GenerationSuccessBanner.jsx";
import ActivityLogCard from "./ActivityLogCard.jsx";
import RunSidebar from "./RunSidebar.jsx";
import { cleanTestName } from "../utils/formatTestName.js";

// Pipeline stages for AI Generate flow.
// Steps 1 & 2 (Crawl & Filter) are skipped — user provides test name + description directly.
const PIPELINE_STAGES = [
  { label: "Crawl",               icon: "🔍", step: 1, skipped: true },
  { label: "Filter",              icon: "🧹", step: 2, skipped: true },
  { label: "Classify Intent",     icon: "🧠", step: 3 },
  { label: "Generate Tests via AI", icon: "⚡", step: 4 },
  { label: "Deduplicate",         icon: "🚫", step: 5 },
  { label: "Enhance Assertions",  icon: "✨", step: 6 },
  { label: "Validate",            icon: "✅", step: 7 },
  { label: "Done",                icon: "🎉", step: 8 },
];

export default function GenerateView({ run, isRunning, llmTokens = "" }) {
  const logs = useLogBuffer(run);
  const ps = run?.pipelineStats || {};

  const stats = [
    { label: "Tests Generated",    val: run?.testsGenerated ?? ps.rawTestsGenerated, color: "var(--accent)" },
    { label: "Duplicates Removed", val: ps.duplicatesRemoved,                        color: "var(--amber)" },
    { label: "Assertions Enhanced",val: ps.assertionsEnhanced,                       color: "var(--blue)" },
    { label: "Validation Rejected",val: ps.validationRejected,                       color: "var(--red)" },
    { label: "Avg Quality Score",  val: ps.averageQuality != null ? `${ps.averageQuality}/100` : null,
      color: (ps.averageQuality || 0) >= 60 ? "var(--green)" : "var(--amber)" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, alignItems: "start" }}>

      {/* ── LEFT: Pipeline + Info Banner + Logs ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        <PipelineCard
          stages={PIPELINE_STAGES}
          currentStep={run?.currentStep ?? 0}
          status={run?.status}
          isRunning={isRunning}
        />

        {/* Skipped-steps info banner */}
        <div style={{
          padding: "10px 14px", background: "var(--accent-bg)",
          border: "1px solid rgba(91,110,245,0.18)", borderRadius: "var(--radius)",
          fontSize: "0.78rem", color: "var(--accent)",
          display: "flex", alignItems: "flex-start", gap: 8, lineHeight: 1.5,
        }}>
          <span style={{ fontSize: "1rem", flexShrink: 0 }}>✦</span>
          <span>
            <strong>Crawl &amp; Filter skipped</strong> — you provided the test scenario directly,
            so the AI jumps straight to classifying intent and writing detailed test steps.
          </span>
        </div>

        <GenerationSuccessBanner run={run} isRunning={isRunning} />

        <ActivityLogCard logs={logs} isRunning={isRunning} emptyLabel="Starting generation…" />

        {/* ── LLM streaming panel — sits below the pipeline/log card ── */}
        <LLMStreamPanel tokens={llmTokens} isRunning={isRunning} />

      </div>

      {/* ── RIGHT: Stats + Run Info ── */}
      <RunSidebar stats={stats} run={run} isRunning={isRunning} failLabel="Generation failed — check logs for details.">
        {/* Generate input context */}
        {run?.generateInput && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              Test Input
            </div>
            <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
              {cleanTestName(run.generateInput.name)}
            </div>
            {run.generateInput.description && (
              <div style={{ fontSize: "0.73rem", color: "var(--text2)", lineHeight: 1.5 }}>
                {run.generateInput.description}
              </div>
            )}
          </div>
        )}
      </RunSidebar>
    </div>
  );
}

import React from "react";
import LLMStreamPanel from "../ai/LLMStreamPanel.jsx";
import useLogBuffer from "../../hooks/useLogBuffer.js";
import PipelineCard from "../run/PipelineCard.jsx";
import GenerationSuccessBanner from "./GenerationSuccessBanner.jsx";
import ActivityLogCard from "../run/ActivityLogCard.jsx";
import RunSidebar from "../run/RunSidebar.jsx";
import { cleanTestName } from "../../utils/formatTestName.js";
// GAP-005 (audit, fix) — single source of truth for the pipeline-step →
// agent role(s) mapping. Replaces the locally-hardcoded `STEP_TO_AGENT_ROLE`
// that was both incomplete (only `planner` + `author`) and wrong on step 3
// (the real call site is `intentClassifier.js:158` with `explorer`, plus
// `journeyGenerator.js:218` with `planner` — multi-agent stage). The shared
// helper at `frontend/src/config.js` lives next to AGENT_ROLES (which
// already mirrors `backend/src/aiProvider/agentHealthCheck.js`), so frontend
// attribution can't drift from the backend canonical role list.
import { getStageAgentRoles } from "../../config.js";

// Pipeline stages for AI Generate flow.
// Steps 1 & 2 (Crawl & Filter) are skipped — user provides requirement directly.
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
    <div className="run-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 16, alignItems: "start" }}>

      {/* ── LEFT: Pipeline + Info Banner + Logs ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>

        <PipelineCard
          stages={PIPELINE_STAGES}
          currentStep={run?.currentStep ?? 0}
          status={run?.status}
          isRunning={isRunning}
          /* GAP-005 (audit, fix): per-stage agent attribution via shared
             config helper. Returns an array — step 3 is multi-agent today
             (explorer + planner) so PipelineCard renders one badge per role.
             Single source of truth at `config.js#getStageAgentRoles`. */
          agentRoleFor={getStageAgentRoles}
          /* GAP-005 (audit): per-stage outcome chip. Reads from the same
             `pipelineStats` object the RunSidebar's stat strip uses, so the
             counts agree between the trace view and the summary. Stages
             without a meaningful count (Classify Intent, terminal Done) get
             null and PipelineCard skips the row. Step 4 (Generate Tests)
             prefers `run.testsGenerated` (post-validate count) over
             `rawTestsGenerated` so users see the finished number, not the
             pre-dedup count. */
          outcomeFor={(step) => {
            if (step === 4) {
              const v = run?.testsGenerated ?? ps.rawTestsGenerated;
              return v != null ? { label: "tests generated", value: v } : null;
            }
            if (step === 5 && ps.duplicatesRemoved != null) return { label: "duplicates removed", value: ps.duplicatesRemoved };
            if (step === 6 && ps.assertionsEnhanced != null) return { label: "assertions enhanced", value: ps.assertionsEnhanced };
            if (step === 7 && ps.validationRejected != null) return { label: "validation rejected", value: ps.validationRejected };
            return null;
          }}
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
            <strong>Crawl &amp; Filter skipped</strong> — you provided the requirement directly,
            so the AI jumps straight to classifying intent and writing detailed test steps.
          </span>
        </div>

        <GenerationSuccessBanner run={run} isRunning={isRunning} />

        <ActivityLogCard logs={logs} isRunning={isRunning} emptyLabel="Starting generation…" />

        {/* ── LLM streaming panel — sits below the pipeline/log card ──
            AI-004 (audit): pass pipeline + agent context so the
            panel's new context line ("Author agent · generate tests via ai
            — Stage 4/8") replaces the prior raw-tokens void. `currentStep`
            is the 1-based step index the backend writes on every pipeline
            transition.

            Model name (`run.modelUsed`) is intentionally read off the run
            even though the `runs` table doesn't currently persist it — the
            `LLMStreamPanel` skips the "with <model>" fragment cleanly when
            it's null. A future PR that wires per-run model attribution
            (tracked under GAP-005's backend work) will populate it and the
            context line will start rendering "with claude-sonnet-4"
            without any frontend change. */}
        {(() => {
          const currentStep = Number.isFinite(run?.currentStep) ? Number(run.currentStep) : null;
          const activeStage = currentStep != null
            ? PIPELINE_STAGES.find((s) => s.step === currentStep)
            : null;
          // Only stages that have an active LLM agent get a roleLabel —
          // skipped stages (Crawl, Filter) and the "Done" terminal step
          // would otherwise mis-attribute streaming output.
          //
          // GAP-005 (audit, fix): the streaming panel context line shows
          // one active agent; multi-role stages (step 3 = explorer +
          // planner) surface the **first** role here because at any given
          // streaming instant exactly one LLM call is in flight — the
          // accurate per-call attribution lives in `ai_request_log` (which
          // future PR will correlate to runId). For the stage *list*
          // (PipelineCard above), all roles render as separate badges
          // because the user reads the list as "which agents ran here
          // across the whole stage", not "which one is streaming right now".
          const stageRoles = currentStep != null ? getStageAgentRoles(currentStep) : [];
          const agentRole = stageRoles[0] || null;
          return (
            <LLMStreamPanel
              tokens={llmTokens}
              isRunning={isRunning}
              stageLabel={activeStage?.label || null}
              stageIndex={currentStep}
              totalStages={PIPELINE_STAGES.length}
              agentRole={agentRole}
              modelName={run?.modelUsed || null}
            />
          );
        })()}

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

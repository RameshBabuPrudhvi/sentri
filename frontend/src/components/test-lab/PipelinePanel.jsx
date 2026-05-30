/**
 * @module components/test-lab/PipelinePanel
 * @description 8-stage pipeline visualisation shown while a crawl/generate
 *   run is active in Test Lab. Renders one row per pipeline stage with a
 *   status dot (idle / active / done) and a per-stage stat counter pulled
 *   from `run.pipelineStats[stage.key]`.
 *
 * `PIPELINE_STAGES` is exported as a named export because it's also read by:
 *   - `frontend/src/pages/TestLab.jsx` — to render the "Step N/8" subtitle
 *     and the active-stage label in the live-run header.
 *   - `frontend/src/components/test-lab/QueueRow.jsx` — for the
 *     "Step N/8 · <label>" subtitle on running queue rows.
 *   - `frontend/src/components/test-lab/TestLabLaunchPanel.jsx` — receives
 *     it as a prop for the right-rail launch view.
 *
 * Stage → status derivation lives in `frontend/src/utils/pipelineState.js`
 * (`stageStatus`) — single source of truth shared with `AgentConversation`.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` as part of the page
 * decomposition (audit §3.1). Pure render — no state, no hooks.
 */
import React from "react";
import { stageStatus } from "../../utils/pipelineState.js";

export const PIPELINE_STAGES = [
  { label: "Crawl & snapshot",     step: 1, key: "pagesFound",          unit: "pages" },
  { label: "Filter elements",      step: 2, key: "elementsKept",         unit: "kept"  },
  { label: "Classify intents",     step: 3, key: "journeysDetected",     unit: "flows" },
  { label: "Generate tests",       step: 4, key: "rawTestsGenerated",    unit: "raw"   },
  { label: "Deduplicate",          step: 5, key: "duplicatesRemoved",    unit: "removed" },
  { label: "Enhance assertions",   step: 6, key: "assertionsEnhanced",   unit: "enhanced" },
  { label: "Validate",             step: 7, key: "validationRejected",   unit: "rejected" },
  { label: "Done",                 step: 8, key: null,                   unit: null },
];

/**
 * @param {{ run: { currentStep?: number|null, pipelineStats?: object, status?: string } | null }} props
 */
export default function PipelinePanel({ run }) {
  const cs = run?.currentStep ?? null;
  const ps = run?.pipelineStats || {};
  const status = run?.status ?? "running";

  return (
    <div className="tl-pipeline">
      {PIPELINE_STAGES.map(stage => {
        const state = stageStatus(stage.step, cs, status);
        const statVal = stage.key ? ps[stage.key] : null;
        return (
          <div key={stage.step} className={`tl-stage tl-stage--${state}`}>
            <div className={`tl-stage-dot tl-stage-dot--${state}`} />
            <span className="tl-stage-name">{stage.label}</span>
            {statVal != null && (
              <span className="tl-stage-stat">
                {statVal} {stage.unit}
              </span>
            )}
            {state === "active" && statVal == null && (
              <span className="tl-stage-stat tl-stage-stat--running">running…</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

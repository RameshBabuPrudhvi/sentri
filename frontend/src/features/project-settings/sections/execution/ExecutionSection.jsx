import React from "react";
import { useProjectSettings } from "../../components/ProjectSettingsContext.js";
import IterationCapPanel from "./IterationCapPanel.jsx";
import IframeStrategyPanel from "./IframeStrategyPanel.jsx";
import HydrationPanel from "./HydrationPanel.jsx";
import ElementTimeoutOverridePanel from "./ElementTimeoutOverridePanel.jsx";

/**
 * Execution section — per-project test-execution knobs.
 *
 * Replaces the legacy "Iterations" inner tab from `ProjectQualityCard`.
 * Panels co-located in this directory.
 *
 * AUDIT-ROADMAP B2 added three crawl/runtime knobs to this section:
 * iframe enumeration strategy, SPA hydration policy, and the per-project
 * element-timeout override. All three back onto migration 069 columns and
 * use the same `aap-panel` styling the existing IterationCapPanel /
 * VisionHealingPanel use.
 */
export default function ExecutionSection() {
  const { project, canEdit, onToast } = useProjectSettings();
  return (
    <div className="ps-section">
      <section className="ps-section__block">
        <h2 className="ps-section__title">Iteration cap</h2>
        <p className="ps-section__desc">
          Per-project ceiling on fixture rows dispatched per data-driven test.
          Defaults to 10; cap clamped to [1, 100] server-side.
        </p>
        <IterationCapPanel
          project={project}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>

      <section className="ps-section__block">
        <h2 className="ps-section__title">iframe enumeration</h2>
        <p className="ps-section__desc">
          AUDIT-ROADMAP B2 — controls which iframes the crawler walks per page.
          Enterprise apps embedding payment widgets, Intercom, Typeform, etc.
          are invisible to the crawler unless this is enabled.
        </p>
        <IframeStrategyPanel
          project={project}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>

      <section className="ps-section__block">
        <h2 className="ps-section__title">SPA hydration wait</h2>
        <p className="ps-section__desc">
          AUDIT-ROADMAP B2 — waits for the SPA's loading indicators to clear
          before snapshotting, so React / Vue / Angular / Next.js apps don't
          get captured in skeleton state.
        </p>
        <HydrationPanel
          project={project}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>

      <section className="ps-section__block">
        <h2 className="ps-section__title">Element timeout override</h2>
        <p className="ps-section__desc">
          AUDIT-ROADMAP B2 — bypasses the per-run adaptive timeout calculation
          (`2 × p95LoadMs` clamped to `[HEALING_ELEMENT_TIMEOUT, MAX_ELEMENT_TIMEOUT]`).
          Set this when an operator already knows the environment's timing.
        </p>
        <ElementTimeoutOverridePanel
          project={project}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>
    </div>
  );
}

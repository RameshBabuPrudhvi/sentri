import React from "react";
import { useProjectSettings } from "../../components/ProjectSettingsContext.js";
import VisionHealingPanel from "./VisionHealingPanel.jsx";

/**
 * Self-Healing section — vision-based fallback for selector failures.
 *
 * Replaces the legacy "Vision Healing" inner tab from `ProjectQualityCard`.
 * Panel co-located at `./VisionHealingPanel.jsx`.
 */
export default function SelfHealingSection() {
  const { project, canEdit, onToast } = useProjectSettings();
  return (
    <div className="ps-section">
      <section className="ps-section__block">
        <h2 className="ps-section__title">Vision Healing</h2>
        <p className="ps-section__desc">
          Adds a vision-based fallback when every DOM selector strategy fails.
          Stage 7 (pixelmatch) is deterministic and free; stage 8 (LLM vision)
          is paid and bounded by per-project daily / monthly caps.
        </p>
        <VisionHealingPanel
          project={project}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>
    </div>
  );
}

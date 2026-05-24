import React from "react";
import { useProjectSettings } from "../../components/ProjectSettingsContext.js";
import IterationCapPanel from "./IterationCapPanel.jsx";

/**
 * Execution section — per-project test-execution knobs.
 *
 * Replaces the legacy "Iterations" inner tab from `ProjectQualityCard`.
 * Panel co-located at `./IterationCapPanel.jsx`.
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
    </div>
  );
}

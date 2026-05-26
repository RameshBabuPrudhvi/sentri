import React from "react";
import { useProjectSettings } from "../../components/ProjectSettingsContext.js";
import AutoApprovalPanel from "./AutoApprovalPanel.jsx";

/**
 * Review section — confidence-threshold-based auto-approval workflow.
 *
 * Replaces the legacy "Auto-Approval" inner tab from `ProjectQualityCard`.
 * The panel is now co-located at `./AutoApprovalPanel.jsx`; the inline
 * copy in `components/automation/ProjectQualityCard.jsx` is the legacy
 * source until step 6 of the migration deletes that file.
 */
export default function ReviewSection() {
  const { project, canEdit, onToast } = useProjectSettings();
  return (
    <div className="ps-section">
      <section className="ps-section__block">
        <h2 className="ps-section__title">Auto-Approval</h2>
        <p className="ps-section__desc">
          Bypass manual review for tests whose confidence score exceeds a
          threshold. The calibration line shows recent revert rate so you
          can tune without flying blind.
        </p>
        <AutoApprovalPanel
          project={project}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>
    </div>
  );
}

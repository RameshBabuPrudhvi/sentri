import React from "react";
import { useProjectSettings } from "../../components/ProjectSettingsContext.js";
import AutoApprovalPanel from "./AutoApprovalPanel.jsx";
import ReviewRejectionEscalationPanel from "./ReviewRejectionEscalationPanel.jsx";

/**
 * Review section — confidence-threshold-based auto-approval workflow
 * + B3 review-rejection escalation threshold.
 *
 * Two panels:
 *   - AutoApprovalPanel: AUTO-003b — bypass review for high-confidence tests.
 *   - ReviewRejectionEscalationPanel: AUDIT-ROADMAP B3 — when the
 *     reviewer↔author loop discards a candidate, decide when FEA-001
 *     channels fire.
 *
 * The panels share a section because they sit at opposite ends of the
 * same review-policy axis: AutoApproval decides which tests SKIP review;
 * ReviewRejection decides which discarded-by-review tests deserve an alert.
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
      <section className="ps-section__block">
        <h2 className="ps-section__title">Review-Rejection Escalation</h2>
        <p className="ps-section__desc">
          When the reviewer↔author loop discards a generated test via
          <code> ReviewRejection</code>, the FEA-001 notification channels
          (Teams / email / webhook) fire per this threshold. Tune the
          per-run minimum to balance signal vs. noise for high-volume
          projects.
        </p>
        <ReviewRejectionEscalationPanel
          project={project}
          canEdit={canEdit}
          onToast={onToast}
        />
      </section>
    </div>
  );
}

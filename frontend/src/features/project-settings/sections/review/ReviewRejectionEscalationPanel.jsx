import React, { useState } from "react";
import { api } from "../../../../api.js";

/**
 * ReviewRejectionEscalationPanel — configures
 * `project.reviewRejectionAlertThreshold` (AUDIT-ROADMAP B3).
 *
 * When the post-run feedback loop's reviewer↔author loop terminates
 * with `ReviewRejection` on N tests, the FEA-001 notification
 * dispatcher (`backend/src/utils/notifications.js#fireReviewRejectionNotifications`)
 * only fires when `rejections.length >= threshold`:
 *
 *   • `0` (default) → notify on any rejection — surface everything
 *     until the operator dials in a noise floor.
 *   • positive `N`  → notify only at N+ rejections — operator-tuned
 *     noise floor for high-volume projects where 1–2 rejections per
 *     run is expected churn.
 *   • `-1`          → opt-out, never notify — mirrors GitHub Actions
 *     `failure-notification-threshold: -1` and Datadog monitor mute
 *     semantics.
 *
 * The backend PATCH validator at `backend/src/routes/projects.js`
 * accepts integers in `[-1, 1000]`. Values above 1000 are
 * functionally equivalent to opt-out (the loop hard-cap on
 * tests-per-run is well below this).
 *
 * @typedef {Object} ReviewRejectionEscalationPanelProject
 * @property {string} id - Project id (workspace-scoped).
 * @property {number} [reviewRejectionAlertThreshold] - Current value
 *   from `projects.reviewRejectionAlertThreshold` (migration 070).
 *   `null` / `undefined` renders as `0` (the column default — always
 *   notify). Persists as integer; the panel coerces empty input → 0.
 *
 * @typedef {Object} ReviewRejectionEscalationPanelProps
 * @property {ReviewRejectionEscalationPanelProject} project - Live
 *   project row from `useProjectSettings()`.
 * @property {boolean} canEdit - Set to `false` for viewers; disables
 *   the input + Save button so non-admins can read but not mutate.
 * @property {(msg: string, kind: ("success"|"error"|"info")) => void} [onToast] -
 *   Optional toast dispatcher from `useToast()`. Best-effort: panel
 *   still saves when `onToast` is missing (silent success on the wire).
 *
 * @param {ReviewRejectionEscalationPanelProps} props
 * @returns {JSX.Element}
 */
export default function ReviewRejectionEscalationPanel({ project, canEdit, onToast }) {
  // Threshold is INTEGER NOT NULL DEFAULT 0 on the column; the
  // backend's `rowToProject` normalises null → 0, so the initial
  // input value is always a number. We keep the input string-typed
  // so the user can clear it mid-edit without React fighting the
  // empty-state.
  const [value, setValue] = useState(
    project.reviewRejectionAlertThreshold == null
      ? "0"
      : String(project.reviewRejectionAlertThreshold),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    // Empty input → treat as 0 (default). The backend validator at
    // `routes/projects.js:548-557` accepts `null` → 0 too, but
    // emitting an explicit integer keeps the wire payload
    // unambiguous.
    const parsed = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < -1 || parsed > 1000) {
      onToast?.(
        "Threshold must be -1 (opt-out), 0 (always notify), or an integer 1–1000.",
        "error",
      );
      return;
    }
    setSaving(true);
    try {
      await api.updateProject(project.id, {
        reviewRejectionAlertThreshold: parsed,
      });
      const msg = parsed === -1
        ? "Review-rejection alerts disabled."
        : parsed === 0
          ? "Review-rejection alerts enabled — fires on any rejection."
          : `Review-rejection alerts will fire at ${parsed}+ rejections per run.`;
      onToast?.(msg, "success");
    } catch (err) {
      onToast?.(err?.message || "Failed to save threshold.", "error");
    } finally {
      setSaving(false);
    }
  };

  // Derive a plain-English summary so the operator sees what the
  // current value MEANS, not just the raw number.
  const current = Number.isInteger(project.reviewRejectionAlertThreshold)
    ? project.reviewRejectionAlertThreshold
    : 0;
  const summary = current === -1
    ? "Currently: alerts disabled (opt-out)."
    : current === 0
      ? "Currently: alert on any review rejection."
      : `Currently: alert when ${current} or more tests are rejected in a single run.`;

  // B3 — stable id so the `<label htmlFor>` ties to the input for
  // screen-reader landmark navigation. Also drives the `aria-describedby`
  // hook so screen readers narrate the plain-English summary alongside
  // the numeric value. WCAG 2.1 SC 1.3.1 (Info and Relationships) +
  // SC 4.1.3 (Status Messages).
  const inputId = `review-rejection-threshold-${project.id}`;
  const summaryId = `${inputId}-summary`;
  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label" htmlFor={inputId}>
          Alert threshold (-1 opt-out, 0 always, 1–1000 per-run minimum)
        </label>
        <div className="aap-field-row">
          <input
            id={inputId}
            type="number"
            min="-1"
            max="1000"
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!canEdit || saving}
            placeholder="0"
            className="aap-input"
            aria-label="Review-rejection alert threshold"
            aria-describedby={summaryId}
            aria-invalid={
              value.trim() !== "" &&
              (!Number.isInteger(Number(value.trim())) ||
                Number(value.trim()) < -1 ||
                Number(value.trim()) > 1000)
            }
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={save}
            disabled={!canEdit || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {/* `role="status"` so screen readers announce the summary change
          after a successful save without stealing focus. WCAG 4.1.3. */}
      <div className="aap-stats" id={summaryId} role="status">{summary}</div>
    </div>
  );
}

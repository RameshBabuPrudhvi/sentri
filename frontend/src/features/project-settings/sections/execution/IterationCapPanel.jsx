import React, { useState } from "react";
import { api } from "../../../../api.js";

/**
 * IterationCapPanel — configures `project.iterationCap` (CAP-001).
 *
 * Extracted verbatim from `components/automation/ProjectQualityCard.jsx`
 * (inline `IterationCapPanel` ~lines 161-220 in the legacy file).
 *
 * Empty input clears the column so the server-side default (10) re-applies;
 * integers in [1, 100] are validated by the backend (`clampIterationCap`)
 * and the runtime clamp.
 */
export default function IterationCapPanel({ project, canEdit, onToast }) {
  const [value, setValue] = useState(
    project.iterationCap == null ? "" : String(project.iterationCap),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    const cap = trimmed === "" ? null : Number(trimmed);
    if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 100)) {
      onToast?.({ type: "error", message: "Iteration cap must be empty or an integer between 1 and 100." });
      return;
    }
    setSaving(true);
    try {
      await api.updateProject(project.id, { iterationCap: cap });
      onToast?.({
        type: "success",
        message: cap === null
          ? "Iteration cap cleared — using default (10)."
          : `Iteration cap set to ${cap}.`,
      });
    } catch (err) {
      onToast?.({ type: "error", message: err?.message || "Failed to save iteration cap." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label">
          Iteration cap (1–100) — leave empty to use the default (10)
        </label>
        <div className="aap-field-row">
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!canEdit || saving}
            placeholder="e.g. 25"
            className="aap-input"
          />
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!canEdit || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="aap-stats">
        Limits how many fixture rows a single data-driven test will run per
        execution. A per-upload override on the test fixture panel can lower
        this further; the server clamps both sources to [1, 100] regardless.
      </div>
    </div>
  );
}

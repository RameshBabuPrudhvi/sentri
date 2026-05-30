import React, { useState } from "react";
import { api } from "../../../../api.js";

/**
 * ElementTimeoutOverridePanel — AUDIT-ROADMAP B2.
 *
 * Configures `project.elementTimeoutOverride` (integer ms, [500, 300000];
 * null = use the adaptive calculation). Backed by migration 069.
 *
 * Default behaviour (override === null): the runner computes
 * `2 * p95(crawl_snapshots.loadMs)` clamped to
 * `[HEALING_ELEMENT_TIMEOUT, MAX_ELEMENT_TIMEOUT]` once per run. Setting
 * an override here bypasses the adaptive math entirely — useful when an
 * operator already knows their staging environment's timing (e.g. a known-
 * slow third-party API in the critical path) and wants a stable per-action
 * budget.
 *
 * Empty input clears the column so the adaptive calculation re-engages on
 * the next run.
 */
export default function ElementTimeoutOverridePanel({ project, canEdit, onToast }) {
  const [value, setValue] = useState(
    project.elementTimeoutOverride == null ? "" : String(project.elementTimeoutOverride),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    const override = trimmed === "" ? null : Number(trimmed);
    if (override !== null && (!Number.isInteger(override) || override < 500 || override > 300000)) {
      onToast?.("Element timeout override must be empty or an integer between 500 and 300000 (ms).", "error");
      return;
    }
    setSaving(true);
    try {
      await api.updateProject(project.id, { elementTimeoutOverride: override });
      onToast?.(
        override === null
          ? "Element timeout override cleared — adaptive calculation re-engaged."
          : `Element timeout override set to ${override} ms — adaptive calculation bypassed.`,
        "success",
      );
    } catch (err) {
      onToast?.(err?.message || "Failed to save element timeout override.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label">
          Override (500–300000 ms) — leave empty to use the adaptive default
        </label>
        <div className="aap-field-row">
          <input
            type="number"
            min="500"
            max="300000"
            step="500"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!canEdit || saving}
            placeholder="e.g. 15000"
            className="aap-input"
          />
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!canEdit || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="aap-stats">
        Without an override, every run computes its own element timeout from
        the crawl's p95 page-load time (`2 × p95LoadMs` clamped to
        `[HEALING_ELEMENT_TIMEOUT, MAX_ELEMENT_TIMEOUT]`). Set this when an
        operator already knows the environment's timing — e.g. an enterprise
        app with an 8–15 s third-party API in the critical path.
      </div>
    </div>
  );
}

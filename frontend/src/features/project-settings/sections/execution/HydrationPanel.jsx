import React, { useState } from "react";
import { api } from "../../../../api.js";

/**
 * HydrationPanel — AUDIT-ROADMAP B2.
 *
 * Configures `project.hydrationType` (enum: auto | domcontentloaded |
 * custom) and `project.hydrationSelector` (only consulted when
 * hydrationType === "custom"). Backed by migration 069.
 *
 * The default `auto` mode waits for common loading-indicator selectors
 * (`.loading, [aria-busy="true"], [data-loading], .skeleton, …`) to
 * disappear before snapshotting; `custom` lets the operator supply a
 * specific selector their app uses; `domcontentloaded` opts out (legacy
 * behaviour).
 *
 * The wait is bounded by `HYDRATION_WAIT_MS` (env, default 5 000) — apps
 * without a recognisable loading indicator fall through and the crawl
 * proceeds unchanged. Best-effort: this panel surfaces the policy but
 * never the runtime budget.
 */
export default function HydrationPanel({ project, canEdit, onToast }) {
  const initialType = project.hydrationType || "auto";
  const initialSelector = project.hydrationSelector || "";

  const [type, setType] = useState(initialType);
  const [selector, setSelector] = useState(initialSelector);
  const [saving, setSaving] = useState(false);

  const trimmedSelector = selector.trim();
  const dirty = type !== initialType || trimmedSelector !== initialSelector;

  const save = async () => {
    if (trimmedSelector.length > 500) {
      onToast?.("Hydration selector must be ≤ 500 characters.", "error");
      return;
    }
    setSaving(true);
    try {
      await api.updateProject(project.id, {
        hydrationType: type,
        // Backend collapses "" → null; we send null explicitly when not
        // in custom mode so the stored selector clears on mode change.
        hydrationSelector: type === "custom" && trimmedSelector ? trimmedSelector : null,
      });
      const summary = type === "domcontentloaded"
        ? "SPA hydration wait disabled (snapshots at DCL)."
        : type === "custom"
          ? trimmedSelector
            ? `Hydration: custom — waiting for "${trimmedSelector.slice(0, 40)}${trimmedSelector.length > 40 ? "…" : ""}" to disappear.`
            : "Hydration: custom — no selector configured (wait is a no-op)."
          : "Hydration: auto — waiting for common loading indicators to clear.";
      onToast?.(summary, "success");
    } catch (err) {
      onToast?.(err?.message || "Failed to save hydration settings.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label">Hydration policy</label>
        <div className="aap-stats aap-stats--inline">
          React / Vue / Angular / Next.js apps populate the interactive DOM
          200–2 000 ms after `domcontentloaded`. Without a hydration wait
          the crawler captures skeleton state and generated tests target
          elements that don't exist at execution time.
        </div>
        <div className="aap-field-row aap-field-row--column">
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`hydration-${project.id}`}
              checked={type === "auto"}
              onChange={() => setType("auto")}
              disabled={!canEdit || saving}
            />
            Auto (default) — wait for common loading indicators to disappear
          </label>
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`hydration-${project.id}`}
              checked={type === "custom"}
              onChange={() => setType("custom")}
              disabled={!canEdit || saving}
            />
            Custom — wait for a specific selector your app uses
          </label>
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`hydration-${project.id}`}
              checked={type === "domcontentloaded"}
              onChange={() => setType("domcontentloaded")}
              disabled={!canEdit || saving}
            />
            DOMContentLoaded — opt out (legacy behaviour; snapshot at DCL)
          </label>
        </div>
      </div>

      <div className="aap-section">
        <label className="aap-field-label">Custom hydration selector (≤ 500 chars)</label>
        <div className="aap-field-row">
          <input
            type="text"
            value={selector}
            onChange={(e) => setSelector(e.target.value)}
            disabled={!canEdit || saving || type !== "custom"}
            placeholder=".app-loading-overlay, [data-app-loading]"
            className="aap-input"
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          />
        </div>
        <div className="aap-stats aap-stats--hint">
          Waited via Playwright's `page.waitForSelector(sel, &#123; state: "hidden" &#125;)`.
          Only used when the policy above is "Custom". Wait is bounded by
          `HYDRATION_WAIT_MS` (env, default 5 000 ms) — apps without a
          loading indicator fall through after the bound.
        </div>
      </div>

      <div className="aap-field-row aap-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={save}
          disabled={!canEdit || saving || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

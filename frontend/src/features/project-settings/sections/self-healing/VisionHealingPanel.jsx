import React, { useEffect, useState } from "react";
import { api } from "../../../../api.js";

/**
 * VisionHealingPanel — configures `project.visionHealing` (tri-state:
 * off / pixelmatch_only / pixelmatch_and_llm), `visionHealMaxCallsPerDay`,
 * and `visionHealMaxCostUsdPerMonth`. MNT-001.
 *
 * Extracted verbatim from `components/automation/ProjectQualityCard.jsx`
 * (inline `VisionHealingPanel` ~lines 519-690 in the legacy file).
 *
 * `pixelmatch_and_llm` is gated server-side by `aiProvider.hasVisionProvider()`;
 * the backend returns `VISION_PROVIDER_NOT_CONFIGURED` when no vision-capable
 * model is configured. We pre-check via `GET /api/v1/system/vision-provider-status`
 * so the radio renders disabled (with tooltip) BEFORE the user tries to save,
 * fulfilling the QA.md MNT-001 acceptance criterion. The save-time fallback
 * is defence-in-depth for when provider config changes between mount and save.
 */
export default function VisionHealingPanel({ project, canEdit, onToast }) {
  const initialMode = project.visionHealing || "off";
  const initialCalls = project.visionHealMaxCallsPerDay ?? 100;
  const initialCost = project.visionHealMaxCostUsdPerMonth ?? 50;

  const [mode, setMode] = useState(initialMode);
  const [callsCap, setCallsCap] = useState(String(initialCalls));
  const [costCap, setCostCap] = useState(String(initialCost));
  const [saving, setSaving] = useState(false);
  // Default `true` (optimistic) so the radio isn't briefly disabled during
  // the first paint before the status fetch resolves — worst case if the
  // fetch fails is the previous behaviour (save-time error).
  const [llmAvailable, setLlmAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getVisionProviderStatus()
      .then((s) => { if (!cancelled) setLlmAvailable(Boolean(s?.available)); })
      .catch(() => { /* keep optimistic default — save-time error path catches it */ });
    return () => { cancelled = true; };
  }, []);

  const dirty = mode !== initialMode
    || String(initialCalls) !== callsCap
    || String(initialCost) !== costCap;

  const save = async () => {
    const callsN = Number(callsCap);
    const costN = Number(costCap);
    if (!Number.isInteger(callsN) || callsN < 1 || callsN > 10000) {
      onToast?.({ type: "error", message: "Daily call cap must be an integer between 1 and 10000." });
      return;
    }
    if (!Number.isFinite(costN) || costN < 0 || costN > 100000) {
      onToast?.({ type: "error", message: "Monthly cost cap must be a number between 0 and 100000." });
      return;
    }
    setSaving(true);
    try {
      await api.updateProject(project.id, {
        visionHealing: mode,
        visionHealMaxCallsPerDay: callsN,
        visionHealMaxCostUsdPerMonth: costN,
      });
      const summary = mode === "off"
        ? "Vision healing disabled."
        : mode === "pixelmatch_only"
          ? `Pixelmatch fallback enabled · caps ${callsN}/day, $${costN}/month.`
          : `Pixelmatch + LLM fallback enabled · caps ${callsN}/day, $${costN}/month.`;
      onToast?.({ type: "success", message: summary });
    } catch (err) {
      // Distinguish the LLM-not-configured failure from a generic save error
      // so the user gets a concrete remediation step instead of "save failed".
      const msg = err?.message || "Failed to save vision-healing settings.";
      if (msg.includes("VISION_PROVIDER_NOT_CONFIGURED")) {
        setLlmAvailable(false);
        setMode("pixelmatch_only");
        onToast?.({ type: "error", message: "LLM vision is unavailable — no vision-capable model is configured server-side. Falling back to pixelmatch-only." });
      } else {
        onToast?.({ type: "error", message: msg });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label">Healing mode</label>
        <div className="aap-stats aap-stats--inline">
          Adds a vision-based fallback when every DOM selector strategy fails.
          Stage 7 (pixelmatch) is deterministic and free. Stage 8 (LLM vision)
          is paid; both per-project caps below soft-disable it when exceeded.
        </div>
        <div className="aap-field-row aap-field-row--column">
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`vision-mode-${project.id}`}
              checked={mode === "off"}
              onChange={() => setMode("off")}
              disabled={!canEdit || saving}
            />
            Off — DOM-only healing (current behaviour)
          </label>
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`vision-mode-${project.id}`}
              checked={mode === "pixelmatch_only"}
              onChange={() => setMode("pixelmatch_only")}
              disabled={!canEdit || saving}
            />
            Pixelmatch only — free CV fallback, no LLM spend
          </label>
          <label
            className="aap-toggle-label"
            title={llmAvailable ? undefined : "VISION_MODEL not configured server-side"}
          >
            <input
              type="radio"
              name={`vision-mode-${project.id}`}
              checked={mode === "pixelmatch_and_llm"}
              onChange={() => setMode("pixelmatch_and_llm")}
              disabled={!canEdit || saving || !llmAvailable}
            />
            Pixelmatch + LLM — paid; bounded by caps below
            {!llmAvailable && <span className="aap-stats aap-stats--muted">(provider not configured)</span>}
          </label>
        </div>
      </div>

      <div className="aap-section">
        <label className="aap-field-label">Daily LLM call cap (1–10000)</label>
        <div className="aap-field-row">
          <input
            type="number"
            min="1"
            max="10000"
            step="1"
            value={callsCap}
            onChange={(e) => setCallsCap(e.target.value)}
            disabled={!canEdit || saving || mode !== "pixelmatch_and_llm"}
            className="aap-input"
          />
        </div>
        <div className="aap-stats aap-stats--hint">
          Stage 8 (LLM) soft-disables for the rest of the UTC day once this is hit.
          Stage 7 (pixelmatch) keeps running.
        </div>
      </div>

      <div className="aap-section">
        <label className="aap-field-label">Monthly LLM cost cap (USD, 0–100000)</label>
        <div className="aap-field-row">
          <input
            type="number"
            min="0"
            max="100000"
            step="1"
            value={costCap}
            onChange={(e) => setCostCap(e.target.value)}
            disabled={!canEdit || saving || mode !== "pixelmatch_and_llm"}
            className="aap-input"
          />
        </div>
        <div className="aap-stats aap-stats--hint">
          Cumulative LLM-vision spend in the current calendar month. Stage 8
          soft-disables when exceeded; resets at the month boundary.
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

/**
 * @module components/project/QualityGatesPanel
 * @description Quality-gate configuration panel for a project (AUTO-012b).
 *
 * Surfaces the three gate fields backed by `PATCH /api/v1/projects/:id/quality-gates`:
 *   - `minPassRate`  (0–100, %) — fail run when pass rate is below this.
 *   - `maxFlakyPct`  (0–100, %) — fail run when flaky % is above this.
 *   - `maxFailures`  (>= 0, integer) — fail run when failure count is above this.
 *
 * Any single field can be left blank to omit it from the gate config — the
 * server stores only the fields that are present, so partial configs are valid.
 *
 * Loads via `api.getQualityGates`; saves via `api.updateQualityGates`; clears
 * via `api.deleteQualityGates`. Mutations require `qa_lead`+ on the backend, so
 * the form is rendered read-only when `canEdit === false` (Viewer role).
 */

import React, { useEffect, useState } from "react";
import { Save, Trash2, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../../api.js";

/** Convert `null|undefined|""` → "" and any other value → its string form for input binding. */
function toInput(v) {
  return v === null || v === undefined || v === "" ? "" : String(v);
}

/**
 * @param {Object}   props
 * @param {string}   props.projectId
 * @param {boolean}  props.canEdit  - Viewer renders the form read-only.
 * @param {Function} [props.onToast] - `(message, type) => void` for feedback.
 */
export default function QualityGatesPanel({ projectId, canEdit, onToast }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [gates, setGates] = useState(null); // server-side state (null when unconfigured)
  const [form, setForm] = useState({ minPassRate: "", maxFlakyPct: "", maxFailures: "" });

  const showToast = (msg, type = "info") => onToast?.(msg, type);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getQualityGates(projectId)
      .then((res) => {
        if (cancelled) return;
        const g = res?.qualityGates || null;
        setGates(g);
        setForm({
          minPassRate: toInput(g?.minPassRate),
          maxFlakyPct: toInput(g?.maxFlakyPct),
          maxFailures: toInput(g?.maxFailures),
        });
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Failed to load quality gates");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  // Build the PATCH payload, parsing numbers and dropping blanks. Returns
  // `null` if every field is blank (caller should DELETE rather than PATCH `{}`,
  // since an empty object is technically valid but stores `qualityGates: {}`
  // which is not what the user means by "no gates").
  function buildPayload() {
    const payload = {};
    if (form.minPassRate !== "") payload.minPassRate = Number(form.minPassRate);
    if (form.maxFlakyPct !== "") payload.maxFlakyPct = Number(form.maxFlakyPct);
    if (form.maxFailures !== "") payload.maxFailures = Number(form.maxFailures);
    return Object.keys(payload).length === 0 ? null : payload;
  }

  async function handleSave(e) {
    e?.preventDefault?.();
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      if (payload === null) {
        // All blank → treat save as a clear (matches user intent).
        await api.deleteQualityGates(projectId);
        setGates(null);
        showToast("Quality gates cleared", "info");
      } else {
        const res = await api.updateQualityGates(projectId, payload);
        setGates(res?.qualityGates || payload);
        showToast("Quality gates saved", "success");
      }
    } catch (err) {
      setError(err.message || "Save failed");
      showToast(err.message || "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!canEdit) return;
    if (!window.confirm("Clear all quality gates? Future runs will report gateResult: null.")) return;
    setSaving(true);
    setError(null);
    try {
      await api.deleteQualityGates(projectId);
      setGates(null);
      setForm({ minPassRate: "", maxFlakyPct: "", maxFailures: "" });
      showToast("Quality gates cleared", "info");
    } catch (err) {
      setError(err.message || "Clear failed");
      showToast(err.message || "Clear failed", "error");
    } finally {
      setSaving(false);
    }
  }

  // Disabled save when nothing changed vs server state — saves a round-trip
  // and avoids spurious "saved" toasts.
  const isDirty =
    toInput(gates?.minPassRate) !== form.minPassRate ||
    toInput(gates?.maxFlakyPct) !== form.maxFlakyPct ||
    toInput(gates?.maxFailures) !== form.maxFailures;

  if (loading) {
    return (
      <div className="card" style={{ padding: 16 }}>
        <div className="skeleton" style={{ height: 120, borderRadius: 8 }} />
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <ShieldCheck size={16} color="var(--accent)" />
        <h3 style={{ margin: 0, fontWeight: 700, fontSize: "0.95rem" }}>Quality Gates</h3>
        {gates && (
          <span className="badge badge-green" style={{ fontWeight: 600 }} title="Gates configured — runs include gateResult">
            Active
          </span>
        )}
      </div>
      <p style={{ marginTop: 0, marginBottom: 14, fontSize: "0.78rem", color: "var(--text2)", lineHeight: 1.5 }}>
        Configure thresholds that future runs must meet. The trigger response includes <code>gateResult</code> so
        CI pipelines can fail the build on violation. Leave a field blank to skip it.
      </p>

      {error && (
        <div style={{
          padding: "8px 12px", marginBottom: 12,
          background: "var(--red-bg)", border: "1px solid #fca5a5",
          borderRadius: 8, fontSize: "0.78rem", color: "var(--red)",
        }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSave}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Field
            label="Min pass rate (%)"
            help="Run fails when pass rate falls below this. 0–100."
            value={form.minPassRate}
            onChange={(v) => setForm((f) => ({ ...f, minPassRate: v }))}
            min={0} max={100} step="0.1"
            disabled={!canEdit || saving}
          />
          <Field
            label="Max flaky %"
            help="Run fails when flaky % exceeds this. 0–100."
            value={form.maxFlakyPct}
            onChange={(v) => setForm((f) => ({ ...f, maxFlakyPct: v }))}
            min={0} max={100} step="0.1"
            disabled={!canEdit || saving}
          />
          <Field
            label="Max failures"
            help="Run fails when total failures exceed this. Integer ≥ 0."
            value={form.maxFailures}
            onChange={(v) => setForm((f) => ({ ...f, maxFailures: v }))}
            min={0} step="1"
            disabled={!canEdit || saving}
          />
        </div>

        {canEdit && (
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={saving || !isDirty}
              title={isDirty ? "Save changes" : "No changes to save"}
            >
              {saving ? <RefreshCw size={12} className="spin" /> : <Save size={12} />} Save
            </button>
            {gates && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleClear}
                disabled={saving}
                style={{ color: "var(--red)" }}
              >
                <Trash2 size={12} /> Clear all
              </button>
            )}
          </div>
        )}

        {!canEdit && (
          <div style={{ marginTop: 10, fontSize: "0.73rem", color: "var(--text3)", fontStyle: "italic" }}>
            Read-only — QA Lead or Admin role required to edit gates.
          </div>
        )}
      </form>
    </div>
  );
}

function Field({ label, help, value, onChange, min, max, step, disabled }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text2)" }}>{label}</span>
      <input
        className="input"
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder="—"
        style={{ height: 32, fontSize: "0.875rem" }}
      />
      <span style={{ fontSize: "0.7rem", color: "var(--text3)", lineHeight: 1.4 }}>{help}</span>
    </label>
  );
}

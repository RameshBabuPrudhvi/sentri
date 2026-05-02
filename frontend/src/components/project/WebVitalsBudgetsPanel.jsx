/**
 * @module components/project/WebVitalsBudgetsPanel
 * @description Web Vitals budgets configuration panel for a project (AUTO-017.2).
 *
 * Mirrors `QualityGatesPanel` but for performance budgets backed by
 * `PATCH /api/v1/projects/:id/web-vitals-budgets`:
 *   - `lcp`  (ms)        — Largest Contentful Paint upper bound.
 *   - `cls`  (unitless)  — Cumulative Layout Shift upper bound (0–1 typical).
 *   - `inp`  (ms)        — Interaction to Next Paint upper bound.
 *   - `ttfb` (ms)        — Time To First Byte upper bound.
 *
 * Any subset of the four fields is valid — leave a field blank to skip it.
 * Inline reference values follow Google's official "Good" Web Vitals
 * thresholds so users have a sane default to type against.
 *
 * Loads via `api.getWebVitalsBudgets`; saves via `api.updateWebVitalsBudgets`;
 * clears via `api.deleteWebVitalsBudgets`. Mutations require `qa_lead`+ on the
 * backend, so the form is rendered read-only when `canEdit === false`.
 *
 * INP can stay `null` for tests that never trigger an interaction — the
 * evaluator skips `null` metrics, so an INP budget on an assertion-ending
 * test is silently ignored rather than falsely passing or failing.
 */

import React, { useEffect, useState } from "react";
import { Save, Trash2, RefreshCw, Gauge } from "lucide-react";
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
export default function WebVitalsBudgetsPanel({ projectId, canEdit, onToast }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [budgets, setBudgets] = useState(null); // server-side state (null when unconfigured)
  const [form, setForm] = useState({ lcp: "", cls: "", inp: "", ttfb: "" });

  const showToast = (msg, type = "info") => onToast?.(msg, type);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getWebVitalsBudgets(projectId)
      .then((res) => {
        if (cancelled) return;
        const b = res?.webVitalsBudgets || null;
        setBudgets(b);
        setForm({
          lcp:  toInput(b?.lcp),
          cls:  toInput(b?.cls),
          inp:  toInput(b?.inp),
          ttfb: toInput(b?.ttfb),
        });
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Failed to load Web Vitals budgets");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  // Build the PATCH payload, parsing numbers and dropping blanks. Returns
  // `null` if every field is blank (caller should DELETE rather than PATCH `{}`,
  // since the server rejects an empty object with "must include at least one
  // of: lcp, cls, inp, ttfb").
  function buildPayload() {
    const payload = {};
    if (form.lcp  !== "") payload.lcp  = Number(form.lcp);
    if (form.cls  !== "") payload.cls  = Number(form.cls);
    if (form.inp  !== "") payload.inp  = Number(form.inp);
    if (form.ttfb !== "") payload.ttfb = Number(form.ttfb);
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
        // All blank → treat save as a clear (matches user intent and avoids
        // the server's "must include at least one" 400).
        await api.deleteWebVitalsBudgets(projectId);
        setBudgets(null);
        showToast("Web Vitals budgets cleared", "info");
      } else {
        const res = await api.updateWebVitalsBudgets(projectId, payload);
        setBudgets(res?.webVitalsBudgets || payload);
        showToast("Web Vitals budgets saved", "success");
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
    if (!window.confirm("Clear all Web Vitals budgets? Future runs will report webVitalsResult: null.")) return;
    setSaving(true);
    setError(null);
    try {
      await api.deleteWebVitalsBudgets(projectId);
      setBudgets(null);
      setForm({ lcp: "", cls: "", inp: "", ttfb: "" });
      showToast("Web Vitals budgets cleared", "info");
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
    toInput(budgets?.lcp)  !== form.lcp  ||
    toInput(budgets?.cls)  !== form.cls  ||
    toInput(budgets?.inp)  !== form.inp  ||
    toInput(budgets?.ttfb) !== form.ttfb;

  if (loading) {
    return (
      <div className="card" style={{ padding: 16, marginTop: 12 }}>
        <div className="skeleton" style={{ height: 120, borderRadius: 8 }} />
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 20, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Gauge size={16} color="var(--accent)" />
        <h3 style={{ margin: 0, fontWeight: 700, fontSize: "0.95rem" }}>Web Vitals Budgets</h3>
        {budgets && (
          <span className="badge badge-green" style={{ fontWeight: 600 }} title="Budgets configured — runs include webVitalsResult">
            Active
          </span>
        )}
      </div>
      <p style={{ marginTop: 0, marginBottom: 14, fontSize: "0.78rem", color: "var(--text2)", lineHeight: 1.5 }}>
        Set per-page performance thresholds. The trigger response includes <code>webVitalsResult</code> so
        CI pipelines can fail the build on regressions. Leave a field blank to skip it. Reference values follow
        Google&rsquo;s &ldquo;Good&rdquo; Web Vitals thresholds.
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
            label="LCP (ms)"
            help="Largest Contentful Paint. Good ≤ 2500 · Needs-Improvement ≤ 4000."
            value={form.lcp}
            onChange={(v) => setForm((f) => ({ ...f, lcp: v }))}
            min={0} step="1"
            placeholder="2500"
            disabled={!canEdit || saving}
          />
          <Field
            label="CLS"
            help="Cumulative Layout Shift (unitless). Good ≤ 0.1 · Needs-Improvement ≤ 0.25."
            value={form.cls}
            onChange={(v) => setForm((f) => ({ ...f, cls: v }))}
            min={0} step="0.01"
            placeholder="0.1"
            disabled={!canEdit || saving}
          />
          <Field
            label="INP (ms)"
            help="Interaction to Next Paint. Good ≤ 200 · Needs-Improvement ≤ 500. Null on tests with no interaction."
            value={form.inp}
            onChange={(v) => setForm((f) => ({ ...f, inp: v }))}
            min={0} step="1"
            placeholder="200"
            disabled={!canEdit || saving}
          />
          <Field
            label="TTFB (ms)"
            help="Time To First Byte. Good ≤ 800 · Needs-Improvement ≤ 1800."
            value={form.ttfb}
            onChange={(v) => setForm((f) => ({ ...f, ttfb: v }))}
            min={0} step="1"
            placeholder="800"
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
            {budgets && (
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
            Read-only — QA Lead or Admin role required to edit budgets.
          </div>
        )}
      </form>
    </div>
  );
}

function Field({ label, help, value, onChange, min, max, step, placeholder, disabled }) {
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
        placeholder={placeholder ?? "—"}
        style={{ height: 32, fontSize: "0.875rem" }}
      />
      <span style={{ fontSize: "0.7rem", color: "var(--text3)", lineHeight: 1.4 }}>{help}</span>
    </label>
  );
}

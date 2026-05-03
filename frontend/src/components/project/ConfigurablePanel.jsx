/**
 * @module components/project/ConfigurablePanel
 * @description Shared form scaffold for "configure-this-thing-per-project"
 * panels (UI-REFACTOR-001). Extracted from `QualityGatesPanel` (AUTO-012) and
 * `WebVitalsBudgetsPanel` (AUTO-017) which had ~95% structural overlap.
 *
 * Both panels share the same shape:
 *   - Load current config on mount via a GET endpoint.
 *   - Render a grid of numeric `<Field>` inputs.
 *   - Save via a PATCH endpoint, falling back to DELETE when every field is
 *     blank (server rejects empty PATCH bodies for these resources).
 *   - "Clear all" button issues an explicit DELETE with confirm dialog.
 *   - Render read-only when `canEdit === false`.
 *
 * Future SLO / SSO / Jira-integration config UIs (SEC-005, DIF-008) drop in
 * by passing their own `fields`, `api`, and labels.
 */

import React, { useEffect, useRef, useState } from "react";
import { Save, Trash2, RefreshCw } from "lucide-react";
import { invalidateAutomationStatus } from "../../utils/automationStatus.js";

/** Map ConfigurablePanel resultKey → automation status cache kind. */
const RESULT_KEY_TO_STATUS_KIND = {
  qualityGates: "gates",
  webVitalsBudgets: "budgets",
};

/** Convert `null|undefined|""` → "" and any other value → its string form for input binding. */
function toInput(v) {
  return v === null || v === undefined || v === "" ? "" : String(v);
}

/**
 * @typedef  {Object} PanelField
 * @property {string} key
 * @property {string} label
 * @property {string} help
 * @property {number} [min]
 * @property {number} [max]
 * @property {string} [step]
 * @property {string} [placeholder]
 */

/**
 * @typedef  {Object} PanelApi
 * @property {() => Promise<Object>} load   - Resolves to `{ [resultKey]: object|null }`.
 * @property {(payload: Object) => Promise<Object>} save - PATCH with non-blank fields.
 * @property {() => Promise<void>} clear    - DELETE the resource.
 */

/**
 * @param {Object} props
 * @param {string} props.title
 * @param {React.ReactNode} props.icon
 * @param {React.ReactNode} props.description
 * @param {PanelField[]} props.fields
 * @param {PanelApi} props.api
 * @param {string} props.resultKey       - Key on the load response (e.g. `"qualityGates"`).
 * @param {string} props.activeBadgeTitle
 * @param {string} props.clearConfirm    - Confirm message for the clear-all dialog.
 * @param {{ saved: string, cleared: string }} props.toastMessages
 * @param {string} props.readOnlyHint
 * @param {boolean} props.canEdit
 * @param {(msg: string, type?: string) => void} [props.onToast]
 * @param {Object} [props.cardStyle]
 */
export default function ConfigurablePanel({
  title,
  icon,
  description,
  fields,
  api,
  resultKey,
  activeBadgeTitle,
  clearConfirm,
  toastMessages,
  readOnlyHint,
  canEdit,
  onToast,
  cardStyle,
  projectId,
}) {
  // Notify the Automation status-chip cache after any successful save/clear.
  const notifyStatus = () => {
    const kind = RESULT_KEY_TO_STATUS_KIND[resultKey];
    if (projectId && kind) invalidateAutomationStatus(projectId, kind);
  };
  const blankForm = Object.fromEntries(fields.map((f) => [f.key, ""]));

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [server, setServer] = useState(null); // server-side state (null when unconfigured)
  const [form, setForm] = useState(blankForm);

  const showToast = (msg, type = "info") => onToast?.(msg, type);

  // Keep `api` in a ref so the load effect doesn't re-fire when the parent
  // re-renders with a fresh inline `api` object. Re-loading is keyed on
  // `projectId` (the only thing that semantically changes which resource we
  // fetch); `fields` / `resultKey` / `title` are static per call site, and
  // pinning the effect to `[projectId]` removes the previous fragile
  // `[api]` + eslint-disable contract that required callers to useMemo `api`.
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiRef.current.load()
      .then((res) => {
        if (cancelled) return;
        const cfg = res?.[resultKey] || null;
        setServer(cfg);
        setForm(Object.fromEntries(fields.map((f) => [f.key, toInput(cfg?.[f.key])])));
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || `Failed to load ${title}`);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Build the PATCH payload, parsing numbers and dropping blanks. Returns
  // `null` if every field is blank (caller should DELETE rather than PATCH `{}`).
  function buildPayload() {
    const payload = {};
    for (const f of fields) {
      if (form[f.key] !== "") payload[f.key] = Number(form[f.key]);
    }
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
        await api.clear();
        setServer(null);
        showToast(toastMessages.cleared, "info");
      } else {
        const res = await api.save(payload);
        setServer(res?.[resultKey] || payload);
        showToast(toastMessages.saved, "success");
      }
      notifyStatus();
    } catch (err) {
      setError(err.message || "Save failed");
      showToast(err.message || "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!canEdit) return;
    if (!window.confirm(clearConfirm)) return;
    setSaving(true);
    setError(null);
    try {
      await api.clear();
      setServer(null);
      setForm(blankForm);
      showToast(toastMessages.cleared, "info");
      notifyStatus();
    } catch (err) {
      setError(err.message || "Clear failed");
      showToast(err.message || "Clear failed", "error");
    } finally {
      setSaving(false);
    }
  }

  const isDirty = fields.some((f) => toInput(server?.[f.key]) !== form[f.key]);

  if (loading) {
    return (
      <div className="card" style={{ padding: 16, ...(cardStyle || {}) }}>
        <div className="skeleton" style={{ height: 120, borderRadius: 8 }} />
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 20, ...(cardStyle || {}) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        {icon}
        <h3 style={{ margin: 0, fontWeight: 700, fontSize: "0.95rem" }}>{title}</h3>
        {server && (
          <span className="badge badge-green" style={{ fontWeight: 600 }} title={activeBadgeTitle}>
            Active
          </span>
        )}
      </div>
      <p style={{ marginTop: 0, marginBottom: 14, fontSize: "0.78rem", color: "var(--text2)", lineHeight: 1.5 }}>
        {description}
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
          {fields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              help={f.help}
              value={form[f.key]}
              onChange={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))}
              min={f.min}
              max={f.max}
              step={f.step}
              placeholder={f.placeholder}
              disabled={!canEdit || saving}
            />
          ))}
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
            {server && (
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
            {readOnlyHint}
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

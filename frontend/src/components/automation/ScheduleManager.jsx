/**
 * ScheduleManager — cron editor, timezone selector, and enable/disable toggle
 * for a single project's scheduled test runs (ENH-006).
 *
 * Renders inline inside ProjectAutomationCard.  On save it calls
 * api.upsertSchedule(); on delete it calls api.deleteSchedule().
 *
 * @param {{ projectId: string }} props
 */

import { useState, useEffect, useCallback } from "react";
import { Clock, Play, Trash2, ToggleLeft, ToggleRight, RefreshCw, ChevronDown } from "lucide-react";
import { api } from "../../api.js";
import { fmtFutureRelative, fmtRelativeDate } from "../../utils/formatters.js";

// ─── Common presets ────────────────────────────────────────────────────────────

const PRESETS = [
  { label: "Every hour",           cron: "0 * * * *" },
  { label: "Every 6 hours",        cron: "0 */6 * * *" },
  { label: "Daily at midnight",    cron: "0 0 * * *" },
  { label: "Daily at 9 AM",        cron: "0 9 * * *" },
  { label: "Weekdays at 9 AM",     cron: "0 9 * * 1-5" },
  { label: "Monday at 9 AM",       cron: "0 9 * * 1" },
  { label: "Every Sunday midnight",cron: "0 0 * * 0" },
];

// Build the timezone list from the Intl API when available (all modern browsers
// and Node 18+).  Falls back to a curated subset for older environments.
const TIMEZONES = (() => {
  try {
    const all = Intl.supportedValuesOf("timeZone");
    // Ensure UTC is first for convenience
    return all.includes("UTC") ? ["UTC", ...all.filter(tz => tz !== "UTC")] : all;
  } catch {
    // Fallback for environments without Intl.supportedValuesOf
    return [
      "UTC",
      "America/New_York", "America/Chicago", "America/Denver",
      "America/Los_Angeles", "America/Sao_Paulo",
      "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
      "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai",
      "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
    ];
  }
})();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Lightweight client-side cron validator.
 * Checks field count and basic syntax. Full validation (including value
 * ranges) is done server-side by node-cron — this only catches obvious
 * mistakes so the user gets instant feedback.
 *
 * @param {string} expr
 * @returns {string|null} Error message string, or null if valid.
 */
function validateCron(expr) {
  if (!expr || !expr.trim()) return "Cron expression is required.";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Must be a 5-field expression: minute hour day month weekday";
  // Each field must be: *, */N, N, N-N, N-N/N, or comma-separated combinations thereof
  const fieldRe = /^(\*|\d+(-\d+)?(\/\d+)?)(,(\*|\d+(-\d+)?(\/\d+)?))*$/;
  for (let i = 0; i < 5; i++) {
    if (!fieldRe.test(parts[i])) {
      return `Invalid cron field: "${parts[i]}"`;
    }
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScheduleManager({ projectId }) {
  const [schedule, setSchedule]       = useState(null);   // current saved schedule
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [deleting, setDeleting]       = useState(false);
  const [error, setError]             = useState(null);
  const [success, setSuccess]         = useState(null);
  const [showEditor, setShowEditor]   = useState(false);

  // Editor state
  const [cronExpr, setCronExpr]       = useState("0 9 * * 1");
  const [timezone, setTimezone]       = useState("UTC");
  const [enabled, setEnabled]         = useState(true);
  const [cronError, setCronError]     = useState(null);
  const [showPresets, setShowPresets] = useState(false);

  // ── Load schedule ───────────────────────────────────────────────────────────
  const loadSchedule = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSchedule(projectId);
      setSchedule(data.schedule);
      if (data.schedule) {
        setCronExpr(data.schedule.cronExpr);
        setTimezone(data.schedule.timezone || "UTC");
        setEnabled(data.schedule.enabled);
      }
    } catch {
      setError("Failed to load schedule.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  // ── Flash success/error messages ────────────────────────────────────────────
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 3000);
    return () => clearTimeout(t);
  }, [success]);

  // ── Save schedule ───────────────────────────────────────────────────────────
  async function handleSave() {
    const validErr = validateCron(cronExpr);
    if (validErr) { setCronError(validErr); return; }
    setCronError(null);
    setSaving(true);
    setError(null);
    try {
      const data = await api.upsertSchedule(projectId, { cronExpr, timezone, enabled });
      setSchedule(data.schedule);
      setSuccess("Schedule saved.");
      setShowEditor(false);
    } catch (err) {
      setError(err.message || "Failed to save schedule.");
    } finally {
      setSaving(false);
    }
  }

  // ── Toggle enabled ──────────────────────────────────────────────────────────
  async function handleToggle() {
    if (!schedule) return;
    setSaving(true);
    setError(null);
    try {
      const data = await api.upsertSchedule(projectId, {
        cronExpr: schedule.cronExpr,
        timezone: schedule.timezone,
        enabled: !schedule.enabled,
      });
      setSchedule(data.schedule);
      setEnabled(data.schedule.enabled);
      setSuccess(data.schedule.enabled ? "Schedule enabled." : "Schedule paused.");
    } catch (err) {
      setError(err.message || "Failed to update schedule.");
    } finally {
      setSaving(false);
    }
  }

  // ── Delete schedule ─────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!window.confirm("Remove the schedule for this project?")) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteSchedule(projectId);
      setSchedule(null);
      setShowEditor(false);
      setSuccess("Schedule removed.");
    } catch (err) {
      setError(err.message || "Failed to remove schedule.");
    } finally {
      setDeleting(false);
    }
  }

  // ── Preset picker ───────────────────────────────────────────────────────────
  function applyPreset(presetCron) {
    setCronExpr(presetCron);
    setCronError(null);
    setShowPresets(false);
  }

  // ── Open editor with current values ─────────────────────────────────────────
  function openEditor() {
    if (schedule) {
      setCronExpr(schedule.cronExpr);
      setTimezone(schedule.timezone || "UTC");
      setEnabled(schedule.enabled);
    }
    setCronError(null);
    setShowEditor(true);
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="skeleton" style={{ height: 52, borderRadius: "var(--radius)" }} />
    );
  }

  return (
    <div className="text-sm">

      {/* ── Status banner ── */}
      {success && (
        <div className="banner banner-success mb-sm" style={{ padding: "8px 12px" }}>
          {success}
        </div>
      )}
      {error && (
        <div className="banner banner-error mb-sm" style={{ padding: "8px 12px" }}>
          {error}
        </div>
      )}

      {/* ── No schedule yet ── */}
      {!schedule && !showEditor && (
        <div className="auto-sched-empty">
          <p className="text-muted" style={{ margin: "0 0 12px" }}>
            No schedule configured. Set up automated regression runs on a cron schedule.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => { setCronExpr("0 9 * * 1"); setShowEditor(true); }}>
            <Clock size={13} /> Add Schedule
          </button>
        </div>
      )}

      {/* ── Existing schedule summary ── */}
      {schedule && !showEditor && (
        <div className="auto-sched-summary">
          <div className="flex-between" style={{ gap: 10, flexWrap: "wrap" }}>
            {/* Left: cron + timezone */}
            <div className="flex-center gap-md" style={{ minWidth: 0 }}>
              <span className={`badge ${schedule.enabled ? "badge-green" : "badge-amber"}`}>
                {schedule.enabled ? "Active" : "Paused"}
              </span>
              <code className="text-sm text-mono">{schedule.cronExpr}</code>
              <span className="auto-sched-hint">{schedule.timezone}</span>
            </div>
            {/* Right: next run + actions */}
            <div className="flex-center gap-sm shrink-0">
              {schedule.enabled && schedule.nextRunAt && (
                <span className="auto-sched-hint">
                  Next: {fmtFutureRelative(schedule.nextRunAt)}
                </span>
              )}
              {schedule.lastRunAt && (
                <span className="auto-sched-hint">
                  Last: {fmtRelativeDate(schedule.lastRunAt)}
                </span>
              )}
              <button
                className="btn btn-ghost btn-xs"
                onClick={handleToggle}
                disabled={saving}
                title={schedule.enabled ? "Pause schedule" : "Enable schedule"}
                aria-label={schedule.enabled ? "Pause schedule" : "Enable schedule"}
              >
                {saving
                  ? <RefreshCw size={12} className="spin" />
                  : schedule.enabled
                    ? <ToggleRight size={15} color="var(--green)" />
                    : <ToggleLeft size={15} color="var(--text3)" />
                }
              </button>
              <button
                className="btn btn-ghost btn-xs"
                onClick={openEditor}
                title="Edit schedule"
              >
                Edit
              </button>
              <button
                className="btn btn-ghost btn-xs"
                onClick={handleDelete}
                disabled={deleting}
                title="Remove schedule"
                aria-label="Remove schedule"
                style={{ color: "var(--red)" }}
              >
                {deleting ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Inline editor ── */}
      {showEditor && (
        <div className="auto-sched-editor">

          {/* Cron expression row */}
          <div>
            <div className="flex-between mb-sm">
              <label className="auto-sched-label">
                Cron expression
              </label>
              {/* Preset picker */}
              <div style={{ position: "relative" }}>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => setShowPresets(v => !v)}
                  style={{ gap: 3 }}
                >
                  Presets <ChevronDown size={10} />
                </button>
                {showPresets && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 40 }}
                      onClick={() => setShowPresets(false)}
                    />
                    <div
                      className="auto-preset-menu"
                      role="menu"
                      aria-label="Cron presets"
                      onKeyDown={e => {
                        if (e.key === "Escape") { setShowPresets(false); return; }
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                          e.preventDefault();
                          const items = e.currentTarget.querySelectorAll("[role=menuitem]");
                          const idx = Array.from(items).indexOf(document.activeElement);
                          const next = e.key === "ArrowDown"
                            ? (idx + 1) % items.length
                            : (idx - 1 + items.length) % items.length;
                          items[next]?.focus();
                        }
                      }}
                    >
                      {PRESETS.map((p, i) => (
                        <button
                          key={p.cron}
                          className="auto-preset-item"
                          role="menuitem"
                          tabIndex={i === 0 ? 0 : -1}
                          ref={el => { if (i === 0 && el) el.focus(); }}
                          onClick={() => applyPreset(p.cron)}
                        >
                          <span className="text-mono text-muted" style={{ fontSize: "0.78rem", marginRight: 8 }}>
                            {p.cron}
                          </span>
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            <input
              className={`input${cronError ? " input-error" : ""}`}
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", width: "100%" }}
              value={cronExpr}
              onChange={e => { setCronExpr(e.target.value); setCronError(validateCron(e.target.value)); }}
              placeholder="0 9 * * 1"
              aria-label="Cron expression"
              spellCheck={false}
            />
            {cronError && (
              <div style={{ color: "var(--red)", fontSize: "0.78rem", marginTop: 4 }}>{cronError}</div>
            )}
            <div className="text-xs text-muted" style={{ marginTop: 5 }}>
              Format: <code className="text-mono">minute hour day month weekday</code>
              &nbsp;— e.g. <code className="text-mono">0 9 * * 1</code> = every Monday at 9 AM
            </div>
          </div>

          {/* Timezone row */}
          <div>
            <label className="auto-sched-label" style={{ display: "block", marginBottom: 6 }}>
              Timezone
            </label>
            <select
              className="input"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              style={{ width: "100%" }}
              aria-label="Timezone"
            >
              {TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>

          {/* Enabled toggle */}
          <div className="flex-center gap-md">
            <button
              onClick={() => setEnabled(v => !v)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center" }}
              aria-label={enabled ? "Disable schedule" : "Enable schedule"}
            >
              {enabled
                ? <ToggleRight size={22} color="var(--green)" />
                : <ToggleLeft size={22} color="var(--text3)" />
              }
            </button>
            <span className="text-sm">
              {enabled ? "Enabled — run will fire on schedule" : "Paused — schedule saved but won't run"}
            </span>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setShowEditor(false); setCronError(null); }}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving || !!cronError}
            >
              {saving ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
              Save Schedule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

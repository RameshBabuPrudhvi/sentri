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

// A curated subset of common IANA timezone names that covers most users.
// A full list would be hundreds of entries — we keep it focused.
const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format an ISO date for display using the browser locale.
 * @param {string|null} iso
 * @returns {string}
 */
function fmtNextRun(iso) {
  if (!iso) return "Not scheduled";
  const d = new Date(iso);
  const diff = d - Date.now();
  if (diff < 0) return "Soon";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(diff / 3_600_000);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(diff / 86_400_000);
  return `in ${days}d`;
}

/**
 * Lightweight client-side cron validator.
 * Returns an error message string, or null if valid.
 * @param {string} expr
 * @returns {string|null}
 */
function validateCron(expr) {
  if (!expr || !expr.trim()) return "Cron expression is required.";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Must be a 5-field expression: minute hour day month weekday";
  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day of month
    [1, 12],  // month
    [0, 6],   // day of week
  ];
  for (let i = 0; i < 5; i++) {
    const f = parts[i];
    if (f === "*") continue;
    if (/^\*\/\d+$/.test(f)) continue;
    if (/^\d+-\d+$/.test(f)) continue;
    if (/^\d+(,\d+)*$/.test(f)) continue;
    if (/^\d+$/.test(f)) {
      const v = parseInt(f, 10);
      if (v < ranges[i][0] || v > ranges[i][1]) {
        return `Field ${i + 1} value ${v} is out of range ${ranges[i][0]}–${ranges[i][1]}.`;
      }
      continue;
    }
    return `Invalid cron field: "${f}"`;
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
    <div style={{ fontSize: "0.85rem" }}>

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
        <div style={{
          padding: "16px 18px", background: "var(--bg2)", borderRadius: "var(--radius)",
          border: "1px dashed var(--border)", textAlign: "center",
        }}>
          <p style={{ color: "var(--text3)", margin: "0 0 12px" }}>
            No schedule configured. Set up automated regression runs on a cron schedule.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => { setCronExpr("0 9 * * 1"); setShowEditor(true); }}>
            <Clock size={13} /> Add Schedule
          </button>
        </div>
      )}

      {/* ── Existing schedule summary ── */}
      {schedule && !showEditor && (
        <div style={{
          padding: "12px 14px", background: "var(--bg2)", borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
        }}>
          <div className="flex-between" style={{ gap: 10, flexWrap: "wrap" }}>
            {/* Left: cron + timezone */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span className={`badge ${schedule.enabled ? "badge-green" : "badge-amber"}`}>
                {schedule.enabled ? "Active" : "Paused"}
              </span>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--text)" }}>
                {schedule.cronExpr}
              </code>
              <span style={{ color: "var(--text3)", fontSize: "0.78rem" }}>{schedule.timezone}</span>
            </div>
            {/* Right: next run + actions */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {schedule.enabled && schedule.nextRunAt && (
                <span style={{ color: "var(--text3)", fontSize: "0.78rem" }}>
                  Next: {fmtNextRun(schedule.nextRunAt)}
                </span>
              )}
              {schedule.lastRunAt && (
                <span style={{ color: "var(--text3)", fontSize: "0.78rem" }}>
                  Last: {fmtNextRun(schedule.lastRunAt).replace("in ", "")}
                  {/* Show "Xm ago" style using Date diff */}
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
        <div style={{
          padding: "16px 18px", background: "var(--bg2)", borderRadius: "var(--radius)",
          border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12,
        }}>

          {/* Cron expression row */}
          <div>
            <div className="flex-between" style={{ marginBottom: 6 }}>
              <label style={{ fontWeight: 600, color: "var(--text)", fontSize: "0.82rem" }}>
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
                    <div style={{
                      position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 50,
                      background: "var(--surface)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius)", boxShadow: "var(--shadow-md)",
                      minWidth: 200, padding: "4px 0",
                    }}>
                      {PRESETS.map(p => (
                        <button
                          key={p.cron}
                          onClick={() => applyPreset(p.cron)}
                          style={{
                            display: "block", width: "100%", textAlign: "left",
                            padding: "7px 14px", background: "none", border: "none",
                            cursor: "pointer", fontSize: "0.82rem", color: "var(--text)",
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--bg2)"}
                          onMouseLeave={e => e.currentTarget.style.background = "none"}
                        >
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--text3)", marginRight: 8 }}>
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
            <div style={{ color: "var(--text3)", fontSize: "0.75rem", marginTop: 5 }}>
              Format: <code style={{ fontFamily: "var(--font-mono)" }}>minute hour day month weekday</code>
              &nbsp;— e.g. <code style={{ fontFamily: "var(--font-mono)" }}>0 9 * * 1</code> = every Monday at 9 AM
            </div>
          </div>

          {/* Timezone row */}
          <div>
            <label style={{ fontWeight: 600, color: "var(--text)", fontSize: "0.82rem", display: "block", marginBottom: 6 }}>
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
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
            <span style={{ color: "var(--text)", fontSize: "0.82rem" }}>
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

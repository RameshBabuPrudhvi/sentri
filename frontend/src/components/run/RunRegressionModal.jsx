import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Play, X, RefreshCw, Smartphone, Globe } from "lucide-react";
import { api } from "../../api.js";
import ModalShell from "../shared/ModalShell.jsx";

// DIF-003: Curated device presets — mirrors DEVICE_PRESETS in backend/src/runner/config.js.
// Kept as a static list to avoid an extra API call. Must stay in sync with the backend.
const DEVICE_PRESETS = [
  { label: "Desktop (default)", value: "" },
  { label: "iPhone 14", value: "iPhone 14" },
  { label: "iPhone 14 Pro Max", value: "iPhone 14 Pro Max" },
  { label: "iPhone 12", value: "iPhone 12" },
  { label: "iPad (gen 7)", value: "iPad (gen 7)" },
  { label: "iPad Pro 11", value: "iPad Pro 11" },
  { label: "Galaxy S9+", value: "Galaxy S9+" },
  { label: "Pixel 7", value: "Pixel 7" },
  { label: "Pixel 5", value: "Pixel 5" },
  { label: "Galaxy Tab S4", value: "Galaxy Tab S4" },
  { label: "Desktop Chrome HiDPI", value: "Desktop Chrome HiDPI" },
  { label: "Desktop Firefox HiDPI", value: "Desktop Firefox HiDPI" },
];

// AUTO-007: Common locale + timezone presets for the run modal.
const LOCALE_PRESETS = [
  { label: "Default", value: "" },
  { label: "English (US)", value: "en-US" },
  { label: "English (UK)", value: "en-GB" },
  { label: "French", value: "fr-FR" },
  { label: "German", value: "de-DE" },
  { label: "Spanish", value: "es-ES" },
  { label: "Portuguese (BR)", value: "pt-BR" },
  { label: "Japanese", value: "ja-JP" },
  { label: "Korean", value: "ko-KR" },
  { label: "Chinese (Simplified)", value: "zh-CN" },
  { label: "Arabic", value: "ar-SA" },
  { label: "Hindi", value: "hi-IN" },
];

const TIMEZONE_PRESETS = [
  { label: "Default", value: "" },
  { label: "UTC", value: "UTC" },
  { label: "US Eastern", value: "America/New_York" },
  { label: "US Pacific", value: "America/Los_Angeles" },
  { label: "London", value: "Europe/London" },
  { label: "Paris", value: "Europe/Paris" },
  { label: "Berlin", value: "Europe/Berlin" },
  { label: "Tokyo", value: "Asia/Tokyo" },
  { label: "Shanghai", value: "Asia/Shanghai" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "São Paulo", value: "America/Sao_Paulo" },
  { label: "Dubai", value: "Asia/Dubai" },
  { label: "Mumbai", value: "Asia/Kolkata" },
];

/**
 * Shared modal for running regression tests for a project.
 * Replaces the duplicate RunAllModal (Tests.jsx) and RunModal (Runs.jsx).
 *
 * Props:
 *   projects        — array of project objects { id, name }
 *   onClose         — called when modal should close
 *   defaultProjectId — optional: pre-select this project
 */
export default function RunRegressionModal({ projects, onClose, defaultProjectId }) {
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || "");
  const [device, setDevice] = useState("");
  const [locale, setLocale] = useState("");
  const [timezoneId, setTimezoneId] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  // Sync if defaultProjectId changes after mount
  useEffect(() => {
    if (defaultProjectId) setProjectId(defaultProjectId);
  }, [defaultProjectId]);

  async function handleRun() {
    if (!projectId) { setError("Please select a project."); return; }
    setError(null);
    setRunning(true);
    try {
      const body = {};
      if (device) body.device = device;
      if (locale) body.locale = locale;
      if (timezoneId) body.timezoneId = timezoneId;
      const { runId } = await api.runTests(projectId, Object.keys(body).length > 0 ? body : undefined);
      onClose();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err.message || "Failed to start run.");
      setRunning(false);
    }
  }

  return (
    <ModalShell onClose={onClose} width="min(420px, 95vw)">
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "18px 22px 16px", borderBottom: "1px solid var(--border)",
      }}>
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 700, flex: 1 }}>
          Run Regression Tests
        </h2>
        <button className="modal-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div style={{ padding: "20px 22px 24px" }}>
        <p style={{
          fontSize: "0.82rem", color: "var(--text2)",
          marginTop: 0, marginBottom: 20, lineHeight: 1.6,
        }}>
          Select a project to run all approved tests in its regression suite.
        </p>

        {projects.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label>Project</label>
            <select
              className="input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              style={{ height: 38 }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* DIF-003: Device emulation selector */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Smartphone size={13} />
            Device
          </label>
          <select
            className="input"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            style={{ height: 38 }}
          >
            {DEVICE_PRESETS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>

        {/* AUTO-007: Locale and timezone selectors */}
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <Globe size={13} />
              Locale
            </label>
            <select
              className="input"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              style={{ height: 38 }}
            >
              {LOCALE_PRESETS.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <Globe size={13} />
              Timezone
            </label>
            <select
              className="input"
              value={timezoneId}
              onChange={(e) => setTimezoneId(e.target.value)}
              style={{ height: 38 }}
            >
              {TIMEZONE_PRESETS.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <div className="alert-error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleRun}
            disabled={running || !projectId}
          >
            {running ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
            {running ? "Starting…" : "Run Tests"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

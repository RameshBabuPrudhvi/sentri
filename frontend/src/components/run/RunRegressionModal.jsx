import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Play, X, RefreshCw, Smartphone, Globe, Monitor } from "lucide-react";
import { api } from "../../api.js";
import ModalShell from "../shared/ModalShell.jsx";
import { useToast } from "../../context/ToastContext.jsx";

// DIF-002: Browser engine presets — mirrors BROWSER_PRESETS in backend/src/runner/config.js.
// Kept as a static list to avoid an extra API call. Must stay in sync with the backend.
const BROWSER_PRESETS = [
  { label: "Chromium (default)", value: "chromium" },
  { label: "Firefox",            value: "firefox"  },
  { label: "WebKit (Safari)",    value: "webkit"   },
];

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

const NETWORK_PRESETS = [
  { label: "Fast (default)", value: "fast" },
  { label: "Slow 3G", value: "slow3g" },
  { label: "Offline", value: "offline" },
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
  const [browser, setBrowser] = useState("chromium"); // DIF-002
  const [device, setDevice] = useState("");
  const [locale, setLocale] = useState("");
  const [timezoneId, setTimezoneId] = useState("");
  const [networkCondition, setNetworkCondition] = useState("fast");
  const [shards, setShards] = useState(1);
  // DIF-012: per-project environments. Empty string means "use project.url".
  // Fetched lazily on projectId change; viewer roles get a 403 which we
  // swallow so the modal still functions for users below qa_lead.
  const [environments, setEnvironments] = useState([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();
  const { showToast } = useToast();

  // Sync if defaultProjectId changes after mount
  useEffect(() => {
    if (defaultProjectId) setProjectId(defaultProjectId);
  }, [defaultProjectId]);

  // DIF-012: load environments whenever the selected project changes. Reset
  // the selection so a stale envId from a previous project never leaks into
  // the run payload (the backend would 400 on cross-project envId anyway,
  // but failing fast in the UI is friendlier).
  useEffect(() => {
    if (!projectId) { setEnvironments([]); setEnvironmentId(""); return; }
    let cancelled = false;
    setEnvironmentId("");
    api.getProjectEnvironments(projectId)
      .then((rows) => { if (!cancelled) setEnvironments(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setEnvironments([]); }); // 403 for viewers is fine
    return () => { cancelled = true; };
  }, [projectId]);

  async function handleRun() {
    if (!projectId) { setError("Please select a project."); return; }
    setError(null);
    setRunning(true);
    try {
      const body = {};
      // DIF-002: Only include `browser` when the user picked something other
      // than the default. The backend falls back to chromium when the field
      // is absent, so we avoid writing a redundant `browser: "chromium"` onto
      // every run record.
      if (browser && browser !== "chromium") body.browser = browser;
      if (device) body.device = device;
      if (locale) body.locale = locale;
      if (timezoneId) body.timezoneId = timezoneId;
      if (Number.isFinite(Number(shards)) && Number(shards) > 1) body.shards = Math.trunc(Number(shards));
      // DIF-012: only send environmentId when the user picked a non-default
      // option — sending "" would force the backend's `invalid environmentId`
      // validator to run an extra lookup.
      if (environmentId) body.environmentId = environmentId;
      // Always send networkCondition — backend defaults to "fast" if omitted,
      // but always sending it keeps the run record explicit and avoids the
      // dead-import / undefined-vs-"fast" inconsistency in the runner path.
      body.networkCondition = networkCondition || "fast";
      const { runId } = await api.runTests(projectId, Object.keys(body).length > 0 ? body : undefined);
      showToast("Regression run started", "success");
      onClose();
      navigate(`/runs/${runId}`);
    } catch (err) {
      setError(err.message || "Failed to start run.");
      showToast(err.message || "Failed to start run.", "error");
      setRunning(false);
    }
  }

  return (
    <ModalShell onClose={onClose} width="min(420px, 95vw)" ariaLabelledBy="run-regression-modal-title">
      <div className="modal-form-header">
        <h2 id="run-regression-modal-title" className="modal-form-title">Run Regression Tests</h2>
        <button className="modal-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="modal-form-body">
        <p className="modal-form-intro">
          Select a project to run all approved tests in its regression suite.
        </p>

        {projects.length > 0 && (
          <div className="modal-form-row">
            <label>Project</label>
            <select
              className="input modal-form-input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* DIF-012: Environment selector — only shown when the project has
            at least one configured environment; otherwise the run targets
            the project's default URL and we don't clutter the modal. */}
        {environments.length > 0 && (
          <div className="modal-form-row">
            <label className="modal-form-label">
              <Globe size={13} />
              Environment
            </label>
            <select
              className="input modal-form-input"
              value={environmentId}
              onChange={(e) => setEnvironmentId(e.target.value)}
            >
              <option value="">Default (project URL)</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>{env.name} — {env.baseUrl}</option>
              ))}
            </select>
          </div>
        )}

        {/* DIF-002: Browser engine selector */}
        <div className="modal-form-row">
          <label className="modal-form-label">
            <Monitor size={13} />
            Browser
          </label>
          <select
            className="input modal-form-input"
            value={browser}
            onChange={(e) => setBrowser(e.target.value)}
          >
            {BROWSER_PRESETS.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </div>

        {/* DIF-003: Device emulation selector */}
        <div className="modal-form-row">
          <label className="modal-form-label">
            <Smartphone size={13} />
            Device
          </label>
          <select
            className="input modal-form-input"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
          >
            {DEVICE_PRESETS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>

        {/* CAP-002: Optional shard count. Server clamps to [1, MAX_WORKERS]
            and only persists a >1 shardCount when the user explicitly
            requested sharding — see backend/src/routes/runs.js (BUG-0001
            decoupling rationale). Coerce to integer on change so a blank
            input doesn't poison `Number(shards)` downstream. */}
        <div className="modal-form-row">
          <label htmlFor="run-shards-input">Shards</label>
          <input
            id="run-shards-input"
            className="input modal-form-input"
            type="number"
            min="1"
            step="1"
            value={shards}
            aria-label="Shard count — split this run across N parallel partitions"
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") { setShards(1); return; }
              const n = Math.max(1, Math.trunc(Number(raw)) || 1);
              setShards(n);
            }}
          />
        </div>

        {/* AUTO-007/AUTO-006: Locale, timezone, network selectors */}
        <div className="modal-form-row--inline">
          <div>
            <label className="modal-form-label">
              <Globe size={13} />
              Locale
            </label>
            <select
              className="input modal-form-input"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              {LOCALE_PRESETS.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="modal-form-label">
              <Globe size={13} />
              Timezone
            </label>
            <select
              className="input modal-form-input"
              value={timezoneId}
              onChange={(e) => setTimezoneId(e.target.value)}
            >
              {TIMEZONE_PRESETS.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="modal-form-row">
          <label>Network condition</label>
          <select
            className="input modal-form-input"
            value={networkCondition}
            onChange={(e) => setNetworkCondition(e.target.value)}
          >
            {NETWORK_PRESETS.map((n) => (<option key={n.value} value={n.value}>{n.label}</option>))}
          </select>
        </div>

        {error && (
          <div className="alert-error mb-md">
            {error}
          </div>
        )}

        <div className="modal-form-actions">
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

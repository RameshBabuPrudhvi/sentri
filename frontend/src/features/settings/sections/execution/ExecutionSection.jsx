import React from "react";
import {
  Activity, Clock, Cpu, Database, HardDrive, Info, RefreshCw, Server, Shield,
} from "lucide-react";
import SectionTitle from "../../shared/SectionTitle.jsx";
import { fmtUptime } from "../../shared/formatters.js";
import { useSettingsBundleQuery } from "../../../../hooks/queries/useSettingsQueries.js";

/**
 * Execution section — read-only runtime defaults + system info. Compiled
 * constants from `selfHealing.js` (timeout, retry count, retry delay,
 * browser mode, viewport) sit alongside live process telemetry (uptime,
 * Node version, Playwright version, heap memory, table counts).
 *
 * Anyone can view; mutation isn't a thing here (config edits would require
 * code changes + redeploy). Extracted from Settings.jsx (GAP-002).
 */
const RUNTIME_DEFAULTS = [
  { label: "Element Timeout", value: "5 000 ms", desc: "Max wait for each element strategy in the self-healing waterfall" },
  { label: "Retry Count",     value: "3",        desc: "Number of retries per interaction (safeClick / safeFill)" },
  { label: "Retry Delay",     value: "400 ms",   desc: "Pause between retries before re-attempting the action" },
  { label: "Browser Mode",    value: "Headless", desc: "Chromium runs without a visible window for faster execution" },
  { label: "Viewport",        value: "1280 × 720", desc: "Default browser viewport size used during test runs" },
  { label: "Self-Healing",    value: "Enabled",  desc: "Multi-strategy element finding with adaptive healing history" },
];

export default function ExecutionSection() {
  const bundleQuery = useSettingsBundleQuery();
  const sysInfo = bundleQuery.data?.sysInfo ?? null;

  const systemRows = sysInfo
    ? [
        { label: "Uptime",          value: fmtUptime(sysInfo.uptime),                                                                  icon: <Clock size={13} /> },
        { label: "Node.js",         value: sysInfo.nodeVersion,                                                                        icon: <Server size={13} /> },
        { label: "Playwright",      value: sysInfo.playwrightVersion || "—",                                                            icon: <Cpu size={13} /> },
        { label: "Heap Memory",     value: `${sysInfo.memoryMB} MB`,                                                                   icon: <HardDrive size={13} /> },
        { label: "Projects",        value: sysInfo.projects,                                                                            icon: <Database size={13} /> },
        { label: "Tests",           value: `${sysInfo.tests} (${sysInfo.approvedTests} approved, ${sysInfo.draftTests} draft)`,         icon: <Activity size={13} /> },
        { label: "Runs",            value: sysInfo.runs,                                                                                icon: <RefreshCw size={13} /> },
        { label: "Healing Entries", value: sysInfo.healingEntries,                                                                      icon: <Shield size={13} /> },
      ]
    : [];

  return (
    <>
      <SectionTitle icon={<Cpu size={16} color="var(--accent)" />} title="Test Execution" sub="Self-healing runtime defaults — applied to every test run" />
      <div className="card execution-card">
        {RUNTIME_DEFAULTS.map((item) => (
          <div key={item.label} className="kv-row">
            <div>
              <div className="kv-label">{item.label}</div>
              <div className="kv-desc">{item.desc}</div>
            </div>
            <span className={`kv-value${item.value === "Enabled" ? " execution-value--enabled" : ""}`}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
      <div className="hint execution-hint">
        <Info size={11} className="execution-hint__icon" />
        These values are compiled into the self-healing runtime. To customise, edit <span className="text-mono execution-hint__path">backend/src/selfHealing.js</span>
      </div>

      <div className="execution-gap" />

      <SectionTitle icon={<Server size={16} color="var(--green)" />} title="System" sub="Server runtime and resource information" />
      {sysInfo ? (
        <div className="card execution-card">
          {systemRows.map((item) => (
            <div key={item.label} className="info-row">
              <span className="text-muted">{item.icon}</span>
              <span className="text-sm text-sub execution-info-label">{item.label}</span>
              <span className="text-sm text-mono font-semi execution-info-value">{item.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted execution-no-info">Could not load system info.</div>
      )}
    </>
  );
}

/**
 * ProjectQualityCard — expandable accordion for a single project's
 * Quality Gates and Web Vitals Budgets configuration.
 *
 * Lives in the "Quality Gates" top-level tab on the Automation page.
 * Mirrors ProjectAutomationCard's structure but renders QualityGatesPanel
 * and WebVitalsBudgetsPanel side-by-side in an inner tab bar:
 *
 *   Gates | Web Vitals
 *
 * @param {{ project, defaultExpanded?, canEdit?, onToast? }} props
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Globe, ShieldCheck, Gauge, Bot, Database, Lock, Eye } from "lucide-react";
import QualityGatesPanel from "../project/QualityGatesPanel.jsx";
import WebVitalsBudgetsPanel from "../project/WebVitalsBudgetsPanel.jsx";
import TrendChart from "../shared/TrendChart.jsx";
import { useAutomationStatusQuery } from "../../hooks/queries/useAutomationStatusQueries.js";
import { useProjectMetricQuery } from "../../hooks/queries/useProjectMetricQuery.js";
import { api } from "../../api.js";

// AUTO-017.3: the four Web Vital metrics we render trend charts for. Each
// entry's `key` is the `metric_samples.metricKey` written by `recordMetric()`
// in `backend/src/testRunner.js`; `budgetKey` is the matching field on
// `project.webVitalsBudgets` so threshold lines come from project config
// (NEXT.md AUTO-017.3 — "Threshold lines come from the project's
// `webVitalsBudgets` so users see violations in context").
const WEB_VITAL_METRICS = [
  { key: "webVitals.lcp",  budgetKey: "lcp",  title: "LCP (ms)"   },
  { key: "webVitals.cls",  budgetKey: "cls",  title: "CLS"        },
  { key: "webVitals.inp",  budgetKey: "inp",  title: "INP (ms)"   },
  { key: "webVitals.ttfb", budgetKey: "ttfb", title: "TTFB (ms)"  },
];

function WebVitalTrend({ projectId, metricKey, title, threshold }) {
  const { data: samples } = useProjectMetricQuery(projectId, metricKey);
  return (
    <TrendChart
      title={title}
      samples={samples}
      threshold={Number.isFinite(Number(threshold)) ? Number(threshold) : null}
    />
  );
}

const INNER_TABS = [
  { id: "gates",       label: "Quality Gates",  icon: ShieldCheck },
  { id: "webvitals",   label: "Web Vitals",     icon: Gauge       },
  { id: "autoapprove", label: "Auto-Approval",  icon: Bot         },
  { id: "iterations",  label: "Iterations",     icon: Database    },
  { id: "piifirewall", label: "PII Firewall",   icon: Lock        },
  { id: "visionheal",  label: "Vision Healing", icon: Eye         },
  { id: "coverage",    label: "Coverage",       icon: Globe       },
];

function CoveragePanel({ project, canEdit, onToast }) {
  const [enabled, setEnabled] = useState(!!project.coverageEnabled);
  const [sourcemapBaseUrl, setSourcemapBaseUrl] = useState(project.sourcemapBaseUrl || "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.updateProject(project.id, { coverageEnabled: enabled, sourcemapBaseUrl: sourcemapBaseUrl.trim() || null });
      onToast?.({ type: "success", message: "Coverage settings saved." });
    } catch (err) {
      onToast?.({ type: "error", message: err?.message || "Failed to save coverage settings." });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="aap-panel">
      <label className="aap-stats">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!canEdit || saving} />
        {" "}Enable browser JS coverage capture
      </label>
      <input className="aap-input" placeholder="Optional source-map base URL" value={sourcemapBaseUrl} onChange={(e) => setSourcemapBaseUrl(e.target.value)} disabled={!canEdit || saving} />
      <button className="btn btn-primary btn-sm" onClick={save} disabled={!canEdit || saving}>{saving ? "Saving…" : "Save"}</button>
    </div>
  );
}

/**
 * CAP-001: configures `project.iterationCap` — the per-project ceiling on
 * fixture rows dispatched per data-driven test. Empty input clears the
 * column so the server-side default (10) re-applies; integers in [1, 100]
 * are validated by the backend and the runtime clamp.
 */
function IterationCapPanel({ project, canEdit, onToast }) {
  const [value, setValue] = useState(
    project.iterationCap == null ? "" : String(project.iterationCap),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    const cap = trimmed === "" ? null : Number(trimmed);
    if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 100)) {
      onToast?.({ type: "error", message: "Iteration cap must be empty or an integer between 1 and 100." });
      return;
    }
    setSaving(true);
    try {
      await api.updateProject(project.id, { iterationCap: cap });
      onToast?.({
        type: "success",
        message: cap === null
          ? "Iteration cap cleared — using default (10)."
          : `Iteration cap set to ${cap}.`,
      });
    } catch (err) {
      onToast?.({ type: "error", message: err?.message || "Failed to save iteration cap." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label">
          Iteration cap (1–100) — leave empty to use the default (10)
        </label>
        <div className="aap-field-row">
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!canEdit || saving}
            placeholder="e.g. 25"
            className="aap-input"
          />
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!canEdit || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <div className="aap-stats">
        Limits how many fixture rows a single data-driven test will run per
        execution. A per-upload override on the test fixture panel can lower
        this further; the server clamps both sources to [1, 100] regardless.
      </div>
    </div>
  );
}

/**
 * AUTO-003b: configures `project.autoApproveThreshold` and renders the
 * approval-stats calibration line. Empty input → null (feature off).
 */
function AutoApprovalPanel({ project, canEdit, onToast }) {
  const [value, setValue] = useState(
    project.autoApproveThreshold == null ? "" : String(project.autoApproveThreshold),
  );
  const [stats, setStats] = useState(null);
  // Calibration stats are trust-critical for this feature — silently hiding
  // the line on a fetch failure could lead a user to set a threshold without
  // any context for whether their current threshold is over- or under-tuned.
  // Track the load error explicitly so the panel can surface a small amber
  // note instead of rendering a blank space.
  const [statsError, setStatsError] = useState(null);
  const [saving, setSaving] = useState(false);
  // AUTO-003b: first-time-enable preview. Holds the pending threshold +
  // the last-30-tests sample so the user sees what they're about to
  // greenlight before persisting. `null` means no preview pending.
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getApprovalStats(project.id)
      .then((s) => { if (!cancelled) { setStats(s); setStatsError(null); } })
      .catch((err) => {
        // Capture the failure rather than swallowing it — the renderer below
        // turns this into a visible "Calibration stats unavailable" note so
        // users don't tune the threshold blind. Forbidden role responses
        // (viewer hitting a qa_lead-gated endpoint) get a short message;
        // everything else surfaces the underlying error.
        if (cancelled) return;
        setStats(null);
        setStatsError(err?.message || "Could not load calibration stats.");
      });
    return () => { cancelled = true; };
  }, [project.id]);

  const persist = async (threshold) => {
    setSaving(true);
    try {
      await api.updateProject(project.id, { autoApproveThreshold: threshold });
      onToast?.({ type: "success", message: threshold === null ? "Auto-approval disabled." : `Auto-approval threshold set to ${threshold}.` });
      // Re-fetch stats after the threshold change so the calibration line
      // reflects the new state. Mirror the mount-time error handling so a
      // post-save fetch failure surfaces the same visible note rather than
      // leaving the now-stale (or missing) line silently in place.
      try {
        const fresh = await api.getApprovalStats(project.id);
        setStats(fresh);
        setStatsError(null);
      } catch (err) {
        setStats(null);
        setStatsError(err?.message || "Could not load calibration stats.");
      }
    } catch (err) {
      onToast?.({ type: "error", message: err?.message || "Failed to save threshold." });
    } finally {
      setSaving(false);
    }
  };

  // AUTO-003b: first-time enablement guard. When the project goes from
  // "no threshold" → "some threshold", show a preview of which of the last
  // 30 generated tests would have been auto-approved at the proposed
  // threshold so the user can sanity-check before flipping the switch.
  // Re-enables (already had a threshold) and disables (→ null) skip the
  // preview — only the *first* enablement is the dangerous one.
  const save = async () => {
    const trimmed = value.trim();
    const threshold = trimmed === "" ? null : Number(trimmed);
    if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
      onToast?.({ type: "error", message: "Threshold must be empty or a number greater than 0 and at most 1." });
      return;
    }
    const isFirstEnable = threshold !== null && project.autoApproveThreshold == null;
    if (!isFirstEnable) {
      await persist(threshold);
      return;
    }
    try {
      const tests = await api.getTests(project.id);
      // Most-recent first, last 30. `confidenceScore` is null for
      // pre-AUTO-003 rows — those are excluded from the "would be
      // auto-approved" tally rather than counted as failures.
      const recent = [...tests]
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, 30);
      const wouldApprove = recent.filter((t) => Number.isFinite(t.confidenceScore) && t.confidenceScore >= threshold);
      setPreview({ threshold, sample: recent, wouldApprove });
    } catch {
      // If the preview fetch fails, fall through to direct persist rather
      // than block the user — the toast on persist() will surface any save error.
      await persist(threshold);
    }
  };

  const revertPct = stats && stats.autoApprovals7d > 0
    ? Math.round((stats.revertRate7d || 0) * 100)
    : null;

  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label">
          Confidence threshold (0.05–1) — leave empty to disable
        </label>
        <div className="aap-field-row">
          <input
            type="number"
            min="0.05"
            max="1"
            step="0.05"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!canEdit || saving}
            placeholder="e.g. 0.8"
            className="aap-input"
          />
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!canEdit || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {stats && (
        <div className="aap-stats">
          {stats.auto} auto-approved · {stats.human} human-approved · {stats.draft} draft
          {revertPct !== null && (
            <> · <span title={`${stats.reverts7d} of ${stats.autoApprovals7d} auto-approvals were revoked in the last 7 days`}>
              {revertPct}% revert rate (7d)
            </span></>
          )}
        </div>
      )}
      {/* Visible failure mode — when the calibration fetch errors we surface
          a short amber note instead of leaving an empty space, so a user
          can't tune the threshold without realising the stats signal is
          gone. `role="status"` flags it for screen readers without the
          alarm volume of `role="alert"`. */}
      {!stats && statsError && (
        <div className="aap-stats-error" role="status">
          ⚠ Calibration stats unavailable — {statsError}
        </div>
      )}
      {preview && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm auto-approval threshold"
          className="aap-modal-backdrop"
          onClick={() => setPreview(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="aap-modal"
          >
            <h3 className="aap-modal__title">Enable auto-approval at {preview.threshold.toFixed(2)}?</h3>
            <p className="aap-modal__desc">
              Of the last {preview.sample.length} generated test{preview.sample.length === 1 ? "" : "s"} on this project,{" "}
              <strong>{preview.wouldApprove.length}</strong> would have been auto-approved at this threshold.
              Sample these before enabling — once on, future tests bypass review automatically.
            </p>
            {preview.wouldApprove.length > 0 && (
              <ul className="aap-modal__sample">
                {preview.wouldApprove.slice(0, 10).map((t) => (
                  <li key={t.id}>
                    {t.name} <span className="aap-modal__sample-score">· {t.confidenceScore.toFixed(2)}</span>
                  </li>
                ))}
                {preview.wouldApprove.length > 10 && (
                  <li className="aap-modal__sample-overflow">…and {preview.wouldApprove.length - 10} more</li>
                )}
              </ul>
            )}
            <div className="aap-modal__actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setPreview(null)} disabled={saving}>Cancel</button>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => { const t = preview.threshold; setPreview(null); await persist(t); }}
                disabled={saving}
              >
                {saving ? "Enabling…" : "Enable auto-approval"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * SEC-006: configures `project.strictPiiFirewall` (toggle, default ON) and
 * `project.piiAllowlist` (string[] — one literal per line). When strict mode
 * is ON, the backend pipeline redacts emails, phones, SSNs, Luhn-checked
 * cards, JWTs, bearer/basic tokens, and `?token=/?code=/?access_token=` query
 * params from crawl snapshots before they reach the LLM prompt builder.
 * Allowlist entries are exact-value exceptions for demo / training data.
 */
function PiiFirewallPanel({ project, canEdit, onToast }) {
  const [strict, setStrict] = useState(project.strictPiiFirewall !== false);
  const [allowText, setAllowText] = useState(
    Array.isArray(project.piiAllowlist) ? project.piiAllowlist.join("\n") : "",
  );
  const [saving, setSaving] = useState(false);

  const initialStrict = project.strictPiiFirewall !== false;
  const initialAllow = Array.isArray(project.piiAllowlist) ? project.piiAllowlist.join("\n") : "";
  const dirty = strict !== initialStrict || allowText !== initialAllow;

  const save = async () => {
    const allowlist = allowText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      await api.updateProject(project.id, {
        strictPiiFirewall: strict,
        piiAllowlist: allowlist,
      });
      onToast?.({
        type: "success",
        message: strict
          ? `PII firewall enabled · ${allowlist.length} allowlist entr${allowlist.length === 1 ? "y" : "ies"}.`
          : "PII firewall disabled — crawl snapshots will be sent to the LLM unredacted.",
      });
    } catch (err) {
      onToast?.({ type: "error", message: err?.message || "Failed to save PII firewall settings." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aap-panel">
      <label className="aap-field-label aap-toggle-label">
        <input
          type="checkbox"
          checked={strict}
          onChange={(e) => setStrict(e.target.checked)}
          disabled={!canEdit || saving}
        />
        Strict PII firewall (recommended)
      </label>
      <div className="aap-stats aap-stats--inline">
        Redacts emails, phone numbers, SSNs, Luhn-checked credit cards, JWTs,
        Bearer/Basic auth headers, and {"`?token=` / `?code=` / `?access_token=`"} query
        params from crawl snapshots before they reach the LLM. Disable only if
        you understand the prompt-leakage risk.
      </div>

      <div className="aap-section">
        <label className="aap-field-label">
          Allowlist — one literal value per line (skip redaction for demo / training data)
        </label>
        <textarea
          value={allowText}
          onChange={(e) => setAllowText(e.target.value)}
          disabled={!canEdit || saving || !strict}
          placeholder={"demo@example.com\n555-555-0100"}
          rows={5}
          className="input aap-textarea"
        />
        <div className="aap-stats aap-stats--hint">
          Each line is an exact (case-insensitive) match against the candidate
          PII value. Enter the complete literal (full email, full token, full
          query value) — partial fragments will not match.
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

/**
 * MNT-001: configures `project.visionHealing` (tri-state: off / pixelmatch_only /
 * pixelmatch_and_llm), `visionHealMaxCallsPerDay`, and `visionHealMaxCostUsdPerMonth`.
 *
 * `pixelmatch_and_llm` is gated server-side by `aiProvider.hasVisionProvider()`;
 * the backend returns `VISION_PROVIDER_NOT_CONFIGURED` when no vision-capable
 * model is configured. We surface that as a disabled option with an inline
 * tooltip rather than letting the save fail with a generic error.
 *
 * Mirrors `PiiFirewallPanel`'s save / dirty / disabled-when-not-canEdit pattern
 * so the panel feels native alongside the other Quality tabs.
 */
function VisionHealingPanel({ project, canEdit, onToast }) {
  const initialMode = project.visionHealing || "off";
  const initialCalls = project.visionHealMaxCallsPerDay ?? 100;
  const initialCost = project.visionHealMaxCostUsdPerMonth ?? 50;

  const [mode, setMode] = useState(initialMode);
  const [callsCap, setCallsCap] = useState(String(initialCalls));
  const [costCap, setCostCap] = useState(String(initialCost));
  const [saving, setSaving] = useState(false);
  // Server-side LLM-provider availability — fetched on mount via
  // `GET /api/v1/system/vision-provider-status` so the `pixelmatch_and_llm`
  // radio renders disabled (with the tooltip) BEFORE the user tries to save,
  // fulfilling the QA.md MNT-001 acceptance criterion. The save-time
  // VISION_PROVIDER_NOT_CONFIGURED fallback below is a defence-in-depth path
  // for the case where the provider config changes between mount and save.
  //
  // Default `true` (optimistic) so the radio isn't briefly disabled during
  // the first paint before the status fetch resolves — the worst case if
  // the fetch fails is the previous behaviour (save-time error).
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

export default function ProjectQualityCard({
  project,
  defaultExpanded = false,
  canEdit = false,
  onToast,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [innerTab, setInnerTab] = useState("gates");

  // Each chip is its own query so a gates save doesn't refetch budgets.
  const { data: hasGates }   = useAutomationStatusQuery(project.id, "gates");
  const { data: hasBudgets } = useAutomationStatusQuery(project.id, "budgets");

  return (
    <div className="card auto-card">

      {/* ── Accordion header ── */}
      <button
        className="auto-card__header"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <div className="auto-card__icon">
          <Globe size={14} color="var(--purple)" />
        </div>

        <div className="auto-card__title-block">
          <div className="auto-card__name">{project.name}</div>
          <div className="auto-card__url">{project.url}</div>
        </div>

        {/* Status chips */}
        <div className="auto-card__chips">
          {hasGates !== null && (
            <span className={`auto-chip ${hasGates ? "auto-chip--green" : "auto-chip--gray"}`}>
              {hasGates ? "Gates configured" : "No gates"}
            </span>
          )}
          {hasBudgets !== null && (
            <span className={`auto-chip ${hasBudgets ? "auto-chip--blue" : "auto-chip--gray"}`}>
              {hasBudgets ? "Budgets set" : "No budgets"}
            </span>
          )}
        </div>

        <ChevronDown
          size={15}
          color="var(--text3)"
          className="auto-card__chevron"
          style={{ transform: expanded ? "rotate(180deg)" : "none" }}
        />
      </button>

      {/* ── Expanded body ── */}
      {expanded && (
        <div className="auto-card__expanded">

          {/* Inner tab bar */}
          <div className="auto-inner-tabs">
            {INNER_TABS.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  className={`auto-inner-tab ${innerTab === tab.id ? "active" : ""}`}
                  onClick={() => setInnerTab(tab.id)}
                >
                  <Icon size={12} />
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="auto-inner-content">
            {innerTab === "gates" && (
              <QualityGatesPanel
                projectId={project.id}
                canEdit={canEdit}
                onToast={onToast}
              />
            )}
            {innerTab === "autoapprove" && (
              <AutoApprovalPanel
                project={project}
                canEdit={canEdit}
                onToast={onToast}
              />
            )}
            {innerTab === "iterations" && (
              <IterationCapPanel
                project={project}
                canEdit={canEdit}
                onToast={onToast}
              />
            )}
            {innerTab === "piifirewall" && (
              <PiiFirewallPanel
                project={project}
                canEdit={canEdit}
                onToast={onToast}
              />
            )}
            {innerTab === "visionheal" && (
              <VisionHealingPanel
                project={project}
                canEdit={canEdit}
                onToast={onToast}
              />
            )}
            {innerTab === "coverage" && (
              <CoveragePanel
                project={project}
                canEdit={canEdit}
                onToast={onToast}
              />
            )}
            {innerTab === "webvitals" && (
              <>
                <WebVitalsBudgetsPanel
                  projectId={project.id}
                  canEdit={canEdit}
                  onToast={onToast}
                />
                {/* AUTO-017.3: per-metric trend charts. Threshold lines are
                    sourced from the project's `webVitalsBudgets` so users see
                    violations in context (PR checklist NEXT.md:67). */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                    gap: 12,
                    marginTop: 16,
                  }}
                >
                  {WEB_VITAL_METRICS.map((m) => (
                    <WebVitalTrend
                      key={m.key}
                      projectId={project.id}
                      metricKey={m.key}
                      title={m.title}
                      threshold={project.webVitalsBudgets?.[m.budgetKey]}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

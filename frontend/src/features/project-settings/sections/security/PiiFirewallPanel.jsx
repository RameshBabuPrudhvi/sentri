import React, { useState } from "react";
import { api } from "../../../../api.js";

/**
 * PiiFirewallPanel — configures `project.strictPiiFirewall` (default ON)
 * and `project.piiAllowlist` (string[] — one literal per line). SEC-006.
 *
 * Extracted verbatim from `components/automation/ProjectQualityCard.jsx`
 * (inline `PiiFirewallPanel` ~lines 422-505 in the legacy file).
 *
 * When strict mode is ON, the backend pipeline redacts emails, phones,
 * SSNs, Luhn-checked cards, JWTs, bearer/basic tokens, and
 * `?token=` / `?code=` / `?access_token=` query params from crawl
 * snapshots before they reach the LLM prompt builder. Allowlist entries
 * are exact-value exceptions for demo / training data.
 */
export default function PiiFirewallPanel({ project, canEdit, onToast }) {
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
      onToast?.(
        strict
          ? `PII firewall enabled · ${allowlist.length} allowlist entr${allowlist.length === 1 ? "y" : "ies"}.`
          : "PII firewall disabled — crawl snapshots will be sent to the LLM unredacted.",
        "success",
      );
    } catch (err) {
      onToast?.(err?.message || "Failed to save PII firewall settings.", "error");
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

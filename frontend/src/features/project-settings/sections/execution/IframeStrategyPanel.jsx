import React, { useState } from "react";
import { api } from "../../../../api.js";

/**
 * IframeStrategyPanel — AUDIT-ROADMAP B2.
 *
 * Configures `project.iframeStrategy` (enum: same-origin | allowlist |
 * all | none) and `project.iframeAllowlist` (URL-prefix array, max 100,
 * only consulted when strategy === "allowlist"). Backed by migration 069.
 *
 * The allowlist textarea is one prefix per line — easier to scan than a
 * comma-separated string and matches how operators paste the list out of
 * audit-log greps. Blank lines are trimmed before send.
 *
 * Server-side validation (`backend/src/routes/projects.js`) enforces the
 * enum + array shape + ≤100 entries; client-side validation here is a
 * defence-in-depth UX layer so the operator gets feedback before the
 * round-trip.
 */
export default function IframeStrategyPanel({ project, canEdit, onToast }) {
  const initialStrategy = project.iframeStrategy || "same-origin";
  const initialAllowlist = Array.isArray(project.iframeAllowlist) ? project.iframeAllowlist : [];

  const [strategy, setStrategy] = useState(initialStrategy);
  const [allowlistText, setAllowlistText] = useState(initialAllowlist.join("\n"));
  const [saving, setSaving] = useState(false);

  // Re-derive the array form for diffing — operator may have added blank
  // lines that we'd strip on save, so compute the canonical form once.
  const parsedAllowlist = allowlistText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const dirty = strategy !== initialStrategy
    || parsedAllowlist.length !== initialAllowlist.length
    || parsedAllowlist.some((v, i) => v !== initialAllowlist[i]);

  const save = async () => {
    if (parsedAllowlist.length > 100) {
      onToast?.("iframe allowlist is capped at 100 entries.", "error");
      return;
    }
    setSaving(true);
    try {
      await api.updateProject(project.id, {
        iframeStrategy: strategy,
        // Send null when the strategy doesn't need the list — keeps the
        // stored column from drifting away from the canonical empty form.
        // The backend collapses `null` to `'[]'` on the NOT NULL column.
        iframeAllowlist: strategy === "allowlist" ? parsedAllowlist : null,
      });
      const summary = strategy === "none"
        ? "iframe enumeration disabled."
        : strategy === "allowlist"
          ? `iframe strategy: allowlist (${parsedAllowlist.length} entr${parsedAllowlist.length === 1 ? "y" : "ies"}).`
          : `iframe strategy: ${strategy}.`;
      onToast?.(summary, "success");
    } catch (err) {
      onToast?.(err?.message || "Failed to save iframe settings.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aap-panel">
      <div>
        <label className="aap-field-label">Strategy</label>
        <div className="aap-stats aap-stats--inline">
          Controls which iframes the crawler walks per page. Cross-origin
          DOM access throws SecurityError under any strategy — those frames
          are silently skipped.
        </div>
        <div className="aap-field-row aap-field-row--column">
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`iframe-strategy-${project.id}`}
              checked={strategy === "same-origin"}
              onChange={() => setStrategy("same-origin")}
              disabled={!canEdit || saving}
            />
            Same-origin (default) — only frames whose origin matches the parent page
          </label>
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`iframe-strategy-${project.id}`}
              checked={strategy === "allowlist"}
              onChange={() => setStrategy("allowlist")}
              disabled={!canEdit || saving}
            />
            Allowlist — only frames whose URL starts with one of the prefixes below
          </label>
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`iframe-strategy-${project.id}`}
              checked={strategy === "all"}
              onChange={() => setStrategy("all")}
              disabled={!canEdit || saving}
            />
            All — every accessible frame (cross-origin frames still throw and are skipped)
          </label>
          <label className="aap-toggle-label">
            <input
              type="radio"
              name={`iframe-strategy-${project.id}`}
              checked={strategy === "none"}
              onChange={() => setStrategy("none")}
              disabled={!canEdit || saving}
            />
            None — disable iframe enumeration entirely
          </label>
        </div>
      </div>

      <div className="aap-section">
        <label className="aap-field-label">URL-prefix allowlist (one per line, max 100)</label>
        <div className="aap-field-row aap-field-row--column">
          <textarea
            rows={4}
            value={allowlistText}
            onChange={(e) => setAllowlistText(e.target.value)}
            disabled={!canEdit || saving || strategy !== "allowlist"}
            placeholder={"https://js.stripe.com/\nhttps://widget.intercom.io/"}
            className="aap-input"
            style={{ fontFamily: "var(--font-mono, monospace)", whiteSpace: "pre" }}
          />
        </div>
        <div className="aap-stats aap-stats--hint">
          Each line is matched as a `startsWith` prefix against the iframe's
          resolved URL. Only used when the strategy above is "Allowlist".
          {strategy === "allowlist" && (
            <> Currently {parsedAllowlist.length} entr{parsedAllowlist.length === 1 ? "y" : "ies"}.</>
          )}
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

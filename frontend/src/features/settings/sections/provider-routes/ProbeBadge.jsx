import React from "react";
import { AlertCircle, Check } from "lucide-react";

/**
 * Inline probe-result badge for a Provider Route row. Reads the row's
 * persisted `capabilities` payload + the optional `live` override (the result
 * of the current Test click before the parent has refetched). `live` wins so
 * the admin sees the click respond instantly, then the badge stabilises once
 * the row data comes back from the refetch. Extracted from Settings.jsx
 * (GAP-002).
 */
export default function ProbeBadge({ capabilities, live }) {
  const caps = live || capabilities;
  if (!caps) return <span className="st-pr-badge st-pr-badge--unprobed">Unprobed</span>;
  if (caps.reachable && caps.auth !== false && caps.model !== false) {
    return (
      <span className="st-status-ok st-pr-badge" title={`Probed at ${caps.probedAt || "unknown"}`}>
        <Check size={11} /> Reachable
      </span>
    );
  }
  const reason = caps.errorReason || "unreachable";
  return (
    <span className="st-status-err st-pr-badge" title={reason}>
      <AlertCircle size={11} /> {reason.slice(0, 24)}
    </span>
  );
}

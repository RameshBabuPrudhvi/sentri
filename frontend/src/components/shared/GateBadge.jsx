/**
 * @module components/shared/GateBadge
 * @description Per-run quality-gate pass/fail badge (AUTO-012).
 *
 * Reads `run.gateResult` (shape: `{ passed: boolean, violations: Array<{rule, threshold, actual}> } | null`)
 * and surfaces it on the Runs list and Run Detail header so CI consumers and
 * humans can see at a glance whether the configured gates passed.
 *
 * - `null` (no gates configured) → renders nothing (legacy runs unaffected).
 * - `{ passed: true }` → green "Gates ✓" pill.
 * - `{ passed: false }` → red "Gates ✗" pill with tooltip listing violations.
 */

import React from "react";
import { CheckCircle2, XCircle } from "lucide-react";

/**
 * @param {Object} props
 * @param {{passed: boolean, violations?: Array<{rule: string, threshold: number, actual: number}>} | null} [props.gateResult]
 * @param {boolean} [props.compact] - Hide the text label, icon-only.
 * @returns {JSX.Element|null}
 */
export default function GateBadge({ gateResult, compact = false }) {
  if (!gateResult) return null;
  const passed = !!gateResult.passed;
  const violations = Array.isArray(gateResult.violations) ? gateResult.violations : [];

  const tooltip = passed
    ? "All quality gates passed"
    : violations.length === 0
      ? "Quality gate failed"
      : `Quality gate failed:\n${violations.map(v => `• ${v.rule}: actual ${v.actual} vs threshold ${v.threshold}`).join("\n")}`;

  return (
    <span
      className={`badge ${passed ? "badge-green" : "badge-red"}`}
      style={{ gap: 4, fontWeight: 600 }}
      title={tooltip}
      aria-label={tooltip}
    >
      {passed ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
      {!compact && (passed ? "Gates ✓" : `Gates ✗${violations.length ? ` (${violations.length})` : ""}`)}
    </span>
  );
}

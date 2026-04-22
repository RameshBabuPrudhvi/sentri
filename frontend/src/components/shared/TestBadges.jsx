import React from "react";
import {
  CheckCircle2, XCircle, Clock, AlertCircle, Ban, AlertTriangle,
} from "lucide-react";

// ── Status badge (test run result) ───────────────────────────────────────────
// Canonical version — covers all known statuses: passed, failed, running,
// completed, aborted, and the default "Not run" fallback.
// Accepts either `result` or `s` prop for backwards compat across pages.

export function StatusBadge({ result, s }) {
  const v = result ?? s;
  if (!v)                return <span className="badge badge-gray"><Clock size={10} /> Not run</span>;
  if (v === "passed")    return <span className="badge badge-green"><CheckCircle2 size={10} /> Passing</span>;
  if (v === "failed")    return <span className="badge badge-red"><XCircle size={10} /> Failing</span>;
  if (v === "running")   return <span className="badge badge-blue pulse">● Running</span>;
  if (v === "completed") return <span className="badge badge-green">✓ Completed</span>;
  if (v === "aborted")   return <span className="badge badge-gray"><Ban size={10} /> Aborted</span>;
  return <span className="badge badge-amber">{v}</span>;
}

// ── Review badge (draft / approved / rejected) ───────────────────────────────

export function ReviewBadge({ status }) {
  if (status === "approved") return <span className="badge badge-green"><CheckCircle2 size={10} /> Approved</span>;
  if (status === "rejected") return <span className="badge badge-red"><XCircle size={10} /> Rejected</span>;
  return <span className="badge badge-amber"><AlertCircle size={10} /> Draft</span>;
}

// ── Stale badge (AUTO-013) ───────────────────────────────────────────────────
// Shown on tests that haven't been run in STALE_TEST_DAYS (default 90).

export function StaleBadge({ isStale }) {
  if (!isStale) return null;
  return <span className="badge badge-gray" style={{ fontSize: "0.65rem" }} title="Not run in 90+ days"><Clock size={10} /> Stale</span>;
}

// ── Flaky badge (DIF-004) ────────────────────────────────────────────────────
// Shown on tests with a non-zero flakyScore.

export function FlakyBadge({ flakyScore }) {
  if (!flakyScore || flakyScore <= 0) return null;
  return (
    <span
      className={`badge ${flakyScore >= 40 ? "badge-red" : "badge-amber"}`}
      style={{ fontSize: "0.65rem" }}
      title={`Flaky score: ${flakyScore}%`}
    >
      <AlertTriangle size={10} /> Flaky {flakyScore}%
    </span>
  );
}

// ── Scenario & tag badges (journey, BDD, positive/negative/edge) ─────────────
// Renders the inline badge cluster used in test list rows across pages.

export function ScenarioBadges({ test, isBddTest }) {
  return (
    <>
      {(test.generatedFrom === "api_har_capture" || test.generatedFrom === "api_user_described") && <span className="badge badge-blue" style={{ fontSize: "0.65rem" }}>🌐 API</span>}
      {test.isJourneyTest && <span className="badge badge-purple">Journey</span>}
      {isBddTest?.(test.steps) && <span className="badge badge-green" style={{ fontSize: "0.65rem" }}>BDD</span>}
      {test.scenario === "positive" && <span className="badge badge-green" style={{ fontSize: "0.65rem" }}>✓ Positive</span>}
      {test.scenario === "negative" && <span className="badge badge-red" style={{ fontSize: "0.65rem" }}>✗ Negative</span>}
      {test.scenario === "edge_case" && <span className="badge badge-amber" style={{ fontSize: "0.65rem" }}>⚡ Edge case</span>}
      <StaleBadge isStale={test.isStale} />
      <FlakyBadge flakyScore={test.flakyScore} />
    </>
  );
}

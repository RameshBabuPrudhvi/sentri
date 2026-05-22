import React from "react";
import {
  Activity, CheckCircle2, AlertTriangle, FileText, SquareCheckBig,
} from "lucide-react";
import StatCard from "./StatCard.jsx";

/**
 * DASH-003 (audit) — Worker pool telemetry surface.
 *
 * Two variants:
 *
 *   • `variant="full"` (default, used on `/system`) — the original 4-card
 *     layout (Runner Mode, Queue Depth, Active Workers, Completed Jobs).
 *     Operator-grade detail.
 *
 *   • `variant="health"` (used on `/dashboard`) — a single
 *     "Platform Health" StatCard that collapses the four signals into
 *     one green/amber/red indicator. The QA persona doesn't need to see
 *     the BullMQ queue depth on the main dashboard — they need to know
 *     "is the platform OK?" and drill into `/system` if the answer is no.
 *     This is the swap the audit explicitly recommends: move infrastructure
 *     detail off the QA-facing dashboard, keep a single health summary in
 *     its place.
 *
 * Health-tier rules (matches the per-row colour conventions in `variant=full`):
 *   • Red    — any failed jobs (`queue.failed > 0`)
 *   • Amber  — queue depth > 5 (waiting jobs piling up) OR
 *              distributed mode but no active workers (worker pool down)
 *   • Green  — everything else
 *
 * @param {Object} props
 * @param {Object} props.workerPool  - `data.workerPool` slice from the
 *                                     dashboard payload. May be null/missing
 *                                     on a fresh workspace.
 * @param {"full"|"health"} [props.variant="full"]
 */
export default function WorkerPoolPanel({ workerPool, variant = "full" }) {
  const wp = workerPool || {};
  const queue = wp.queue || {};
  const waiting   = queue.waiting   ?? 0;
  const active    = queue.active    ?? 0;
  const failed    = queue.failed    ?? 0;
  const completed = queue.completed ?? 0;
  const activeWorkers = wp.activeWorkers ?? 0;
  const idleWorkers   = wp.idleWorkers   ?? 0;
  const isDistributed = wp.mode === "distributed";

  // Tier resolution — shared between both variants so the dashboard
  // health indicator and the system page's per-row red badges agree on
  // what "unhealthy" means.
  let tier;
  let tierLabel;
  let tierSub;
  if (failed > 0) {
    tier = "red";
    tierLabel = "Degraded";
    tierSub = `${failed} failed job${failed === 1 ? "" : "s"} — investigate in System`;
  } else if (waiting > 5 || (isDistributed && activeWorkers === 0 && (waiting > 0 || active > 0))) {
    tier = "amber";
    tierLabel = "Backed up";
    tierSub = isDistributed && activeWorkers === 0
      ? "No active workers — pool may be down"
      : `${waiting} job${waiting === 1 ? "" : "s"} waiting`;
  } else {
    tier = "green";
    tierLabel = "Healthy";
    tierSub = isDistributed
      ? `${activeWorkers} worker${activeWorkers === 1 ? "" : "s"} active`
      : "Single-process mode";
  }

  if (variant === "health") {
    // DASH-003 (audit): the dashboard variant is one card that summarises
    // the same data the four-card view shows. Replaces the prior 4 BullMQ
    // stat cards that occupied dashboard real estate with operator-only
    // information.
    return (
      <StatCard
        label="Platform Health"
        value={tierLabel}
        sub={tierSub}
        color={tier === "green" ? "var(--green)" : tier === "amber" ? "var(--amber)" : "var(--red)"}
        icon={tier === "red"
          ? <AlertTriangle size={16} />
          : <Activity size={16} />}
      />
    );
  }

  // variant === "full" — Systems page rendering.
  return (
    <div className="stat-grid">
      <StatCard
        label="Runner Mode"
        value={isDistributed ? "Distributed" : "Single-process"}
        sub={isDistributed ? "Redis queue enabled" : "Redis not configured"}
        color={isDistributed ? "var(--blue)" : "var(--text3)"}
        icon={<Activity size={16} />}
      />
      <StatCard
        label="Queue Depth"
        value={waiting}
        sub={`${active} active · ${failed} failed`}
        color={failed > 0 ? "var(--red)" : waiting > 5 ? "var(--amber)" : "var(--purple)"}
        icon={<FileText size={16} />}
      />
      <StatCard
        label="Active Workers"
        value={activeWorkers}
        sub={`${idleWorkers} idle`}
        color={isDistributed && activeWorkers === 0 ? "var(--amber)" : "var(--green)"}
        icon={<CheckCircle2 size={16} />}
      />
      <StatCard
        label="Completed Jobs"
        value={completed}
        sub="BullMQ completions"
        color="var(--accent)"
        icon={<SquareCheckBig size={16} />}
      />
    </div>
  );
}

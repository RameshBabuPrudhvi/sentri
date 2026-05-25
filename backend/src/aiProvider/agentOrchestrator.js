import { emitAgentEvent, emitAgentMessage } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";
import { resolveRoute } from "./registry.js";
import { logActivity } from "../utils/activityLogger.js";
import { readSpendCaps, evaluateSpendCap } from "./quotaGuard.js";
import {
  agentThreadStepsTotal,
  agentSupervisorDecisionsTotal,
  agentThreadDurationSeconds,
  agentOrchestratorFallbackTotal,
} from "../utils/metrics.js";

export const MAX_AUTONOMOUS_STEPS = 20;
export const DEFAULT_AUTONOMOUS_TIMEOUT_MS = 10 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }

function roleEligible(workspaceId, role) {
  if (!workspaceId) return true;
  try {
    const { route } = resolveRoute({ workspaceId, agentRole: role });
    return !!route && route.capabilities?.model !== false;
  } catch {
    return false;
  }
}

/**
 * AUTO-023 B4.2 — default per-thread quota gate. Mirrors
 * `agentLoop.makeDefaultQuotaCheck`: cache the workspace's spend-cap
 * configuration ONCE for the thread's lifetime (the
 * `workspaces.dailySpendCapUsd` / `monthlySpendCapUsd` columns are
 * operator-set and don't change mid-thread in practice), and re-sum
 * the live `ai_request_log` windows on every step so mid-thread
 * accrual is detected on the very next gate check.
 *
 * Workspaces with no `workspaceId` pass through unconditionally
 * (standalone smoke-test / CLI callers without a live workspace
 * row). Workspaces with no cap configured also pass through —
 * `evaluateSpendCap` returns `{ ok: true }` when both daily and
 * monthly are unset.
 *
 * Fail-OPEN on DB errors: a hiccup on the cap read MUST NOT block a
 * running autonomous thread (same contract as `quotaGuard.checkSpendCap`).
 */
function makeDefaultQuotaCheck(workspaceId) {
  if (!workspaceId) return () => ({ ok: true });
  let cachedCaps = null;
  try { cachedCaps = readSpendCaps(workspaceId); } catch { cachedCaps = null; }
  return () => {
    try {
      const result = evaluateSpendCap(workspaceId, cachedCaps);
      if (result?.ok === false) {
        return { ok: false, reason: `spend_cap_${result.exceeded || "exceeded"}`, remainingUsd: result.remainingUsd };
      }
      return { ok: true, remainingUsd: result?.remainingUsd ?? null };
    } catch {
      return { ok: true };
    }
  };
}

/**
 * AUTO-023 B4.5 — emit an OTel span attribute set for an autonomous
 * thread step. We don't open a new span here because the dispatcher
 * (`callProvider` → `annotateAiCallSpan`) already opens one per LLM
 * call; instead, when there's an active span we tag it with the
 * thread + step metadata so traces split cleanly by `agent.thread_id`,
 * `agent.from_role`, `agent.to_role`, and `agent.step`. Best-effort:
 * no-op when OTel is unconfigured (the underlying `annotateAiCallSpan`
 * already short-circuits on `!otelApi`).
 *
 * Kept inline (not exported) because no other module needs to
 * annotate orchestrator spans — and exporting would create a second
 * surface for the same convention.
 */
function annotateThreadSpan(attrs) {
  // Reuses the existing OTel API plumbing in `utils/observability.js`
  // via a dynamic import so this module stays import-graph-clean for
  // deployments that don't enable OTel (the underlying module
  // short-circuits on `!otelApi`, so the import itself is safe).
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    import("../utils/observability.js").then(({ annotateAiCallSpan }) => {
      try { annotateAiCallSpan?.(attrs); } catch { /* best-effort */ }
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}

export async function runAutonomousThread(initialMessage, opts = {}) {
  const {
    runId = null, workspaceId = null, threadId = `THREAD-${Date.now()}`,
    maxSteps = MAX_AUTONOMOUS_STEPS, autonomousTimeoutMs = DEFAULT_AUTONOMOUS_TIMEOUT_MS,
    supervisorDecision, runAgent, onFallback,
    // AUTO-023 B4.2 — caller can inject a custom quota gate; default
    // is the workspace's spend-cap evaluator. Same shape as
    // `agentLoop.runReviewerAuthorLoop`'s `checkQuota` arg.
    checkQuota = null,
  } = opts;
  const startedAt = Date.now();
  const deadline = Date.now() + Math.min(autonomousTimeoutMs, 30 * 60 * 1000);
  const stepsLimit = Math.min(Math.max(1, maxSteps), MAX_AUTONOMOUS_STEPS);
  const thread = [{ fromRole: "supervisor", intent: "handoff", artifact: initialMessage }];
  let lastArtifact = initialMessage?.artifact || null;
  // AUTO-023 B4.2 — resolve quota gate ONCE per thread so cap reads
  // are cached across steps. `null` from caller falls back to the
  // workspace-spend-cap default.
  const effectiveQuotaCheck = typeof checkQuota === "function"
    ? checkQuota
    : makeDefaultQuotaCheck(workspaceId);
  for (let step = 0; step < stepsLimit; step += 1) {
    // AUTO-023 B4.2 — quota check fires BEFORE supervisor dispatch so
    // a spend-cap breach terminates the thread without burning a
    // supervisor LLM call. Pre-fix the orchestrator ran unbounded
    // against an already-capped workspace.
    const quota = await effectiveQuotaCheck({ step, runId, threadId, workspaceId });
    if (quota?.ok === false) {
      try { agentThreadStepsTotal.observe({ outcome: "quota_exhausted" }, Math.max(1, step)); } catch {}
      try { agentThreadDurationSeconds.observe({ outcome: "quota_exhausted" }, Math.max(0.001, (Date.now() - startedAt) / 1000)); } catch {}
      try { agentOrchestratorFallbackTotal.inc({ reason: quota.reason || "spend_cap_exceeded" }); } catch {}
      return { outcome: "quota_exhausted", artifact: lastArtifact, steps: step, reason: quota.reason || null };
    }
    if (Date.now() > deadline) {
      try { agentThreadStepsTotal.observe({ outcome: "timeout" }, Math.max(1, step)); } catch {}
      try { agentThreadDurationSeconds.observe({ outcome: "timeout" }, Math.max(0.001, (Date.now() - startedAt) / 1000)); } catch {}
      return { outcome: "timeout", artifact: lastArtifact, steps: step };
    }
    const decision = await supervisorDecision({ thread, lastArtifact, step, workspaceId, runId, threadId });
    if (decision?.terminate) {
      emitAgentEvent(runId, { step: 7, agent: "supervisor", phase: "done", message: "Supervisor terminated autonomous thread", workspaceId, data: { threadId, step } });
      // AUTO-023 B4.5 — audit-log every supervisor.terminate so admins
      // can answer "why did the orchestrator stop here?" without
      // grepping log lines. Best-effort: a logger hiccup must never
      // break the thread's return path.
      try {
        logActivity({
          type: "agent.supervisor.terminate",
          workspaceId,
          meta: { threadId, runId, steps: step, rationale: decision?.rationale || null },
        });
      } catch { /* best-effort */ }
      try { agentThreadStepsTotal.observe({ outcome: "terminate" }, Math.max(1, step + 1)); } catch {}
      try { agentThreadDurationSeconds.observe({ outcome: "terminate" }, Math.max(0.001, (Date.now() - startedAt) / 1000)); } catch {}
      return { outcome: "terminate", artifact: decision.finalArtifact ?? lastArtifact, steps: step };
    }
    const nextRole = decision?.nextRole;
    try { agentSupervisorDecisionsTotal.inc({ nextRole: String(nextRole || "unknown") }); } catch {}
    if (!roleEligible(workspaceId, nextRole)) {
      onFallback?.({ reason: "ineligible_role", nextRole, step });
      try { agentOrchestratorFallbackTotal.inc({ reason: "ineligible_role" }); } catch {}
      try { agentThreadStepsTotal.observe({ outcome: "fallback" }, Math.max(1, step + 1)); } catch {}
      try { agentThreadDurationSeconds.observe({ outcome: "fallback" }, Math.max(0.001, (Date.now() - startedAt) / 1000)); } catch {}
      if (typeof opts.runLinearFallback === "function") {
        return opts.runLinearFallback({ reason: "ineligible_role", nextRole, lastArtifact, thread, step });
      }
      return { outcome: "fallback", artifact: lastArtifact, steps: step };
    }
    // AUTO-023 B4.5 — tag the active OTel span (opened by the next
    // `generateText` call inside `runAgent`) with thread metadata so
    // traces split cleanly by thread + step + supervisor → next-role
    // edge. No-op when OTel is unconfigured.
    annotateThreadSpan({
      provider: "supervisor",
      agentRole: nextRole,
      operation: "autonomous_thread_step",
    });
    const msg = await runAgent({ role: nextRole, instruction: decision.instruction, thread, step, workspaceId, runId, threadId });
    thread.push(msg);
    lastArtifact = msg?.artifact ?? lastArtifact;
    emitAgentMessage({
      runId, workspaceId, threadId, traceId: getCurrentTraceId() || `trace-${runId || "standalone"}`,
      fromRole: "supervisor", toRole: nextRole, intent: "handoff", artifact: { instruction: decision.instruction }, rationale: decision.rationale || null, round: step, replyToId: null, createdAt: nowIso(),
    });
  }
  try { agentThreadStepsTotal.observe({ outcome: "max_steps" }, Math.max(1, stepsLimit)); } catch {}
  try { agentThreadDurationSeconds.observe({ outcome: "max_steps" }, Math.max(0.001, (Date.now() - startedAt) / 1000)); } catch {}
  return { outcome: "max_steps", artifact: lastArtifact, steps: stepsLimit };
}

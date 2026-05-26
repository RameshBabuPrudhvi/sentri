import { emitAgentEvent, emitAgentMessage } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";
import { resolveRoute } from "./registry.js";
import { logActivity } from "../utils/activityLogger.js";
import { executeToolCall, answerPeer } from "./agentTools/runtime.js";
import * as agentConfigRepo from "../database/repositories/agentConfigRepo.js";
import { readSpendCaps, evaluateSpendCap } from "./quotaGuard.js";
import {
  agentThreadStepsTotal,
  agentSupervisorDecisionsTotal,
  agentThreadDurationSeconds,
  agentOrchestratorFallbackTotal,
} from "../utils/metrics.js";

export const MAX_AUTONOMOUS_STEPS = 20;
export const DEFAULT_AUTONOMOUS_TIMEOUT_MS = 10 * 60 * 1000;

// AUTO-023 B4 — closed-set of canonical roles the supervisor LLM is
// allowed to emit. Mirrored from `frontend/src/config.js#AGENT_ROLES`
// (single source of truth for the agent-name vocabulary). Used to
// clamp the unbounded `nextRole` Prometheus label so a hallucinated
// role name from the supervisor LLM (`"analyzer"`, `"debugger"`, …)
// can't bankrupt the TSDB by minting a new time series per typo.
// `supervisor` is included because the prompt prevents self-routing
// at the LLM layer but defence-in-depth allows it in the closed set.
const KNOWN_AGENT_ROLES = new Set([
  "supervisor", "explorer", "planner", "author",
  "oracle", "reviewer", "healer", "triager",
]);

// Roles the dispatcher can actually execute (have a wired pipeline
// call site). `supervisor` self-routing wastes a step (the dispatcher
// returns `unavailable_role`); `triager`/`healer` are runtime-only
// today. Filtering here prevents the supervisor LLM from burning a
// step on a role that immediately no-ops.
const DISPATCHABLE_ROLES = new Set([
  "explorer", "planner", "author", "oracle", "reviewer",
]);

function clampRoleLabel(role) {
  return KNOWN_AGENT_ROLES.has(String(role || "")) ? String(role) : "other";
}

function nowIso() { return new Date().toISOString(); }

function roleEligible(workspaceId, role) {
  // Defence-in-depth — reject roles outside the dispatchable set.
  // `KNOWN_AGENT_ROLES` is used for Prometheus label clamping only;
  // `DISPATCHABLE_ROLES` is the subset the dispatcher can actually
  // execute. `supervisor` self-routing, `triager`, and `healer` are
  // in KNOWN but not DISPATCHABLE — they'd pass the old check but
  // the dispatcher would return `unavailable_role`, wasting a step.
  if (!DISPATCHABLE_ROLES.has(String(role || ""))) return false;
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
async function annotateThreadSpan(attrs) {
  // Reuses the existing OTel API plumbing in `utils/observability.js`
  // via a dynamic import so this module stays import-graph-clean for
  // deployments that don't enable OTel (the underlying module
  // short-circuits on `!otelApi`, so the import itself is safe).
  // Awaited so the span attributes land on the current span BEFORE
  // the next `runAgent` call opens a child span — pre-fix the
  // fire-and-forget `.then()` raced with `runAgent` and typically
  // annotated the wrong (or no) span.
  try {
    const { annotateAiCallSpan } = await import("../utils/observability.js");
    try { annotateAiCallSpan?.(attrs); } catch { /* best-effort */ }
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
    // AUTO-023 B4 — abort signal threaded into BOTH the supervisor
    // decision call AND the role dispatcher's runAgent. Without this
    // a user-cancelled run continues to burn supervisor LLM time
    // until the provider's own timeout. The orchestrator forwards
    // signal to every async step it owns; downstream callbacks pull
    // it from their args.
    signal = null,
  } = opts;
  const startedAt = Date.now();
  const deadline = Date.now() + Math.min(autonomousTimeoutMs, 30 * 60 * 1000);
  const stepsLimit = Math.min(Math.max(1, maxSteps), MAX_AUTONOMOUS_STEPS);
  const thread = [{ fromRole: "supervisor", intent: "handoff", artifact: initialMessage?.artifact ?? initialMessage }];
  // `??` not `||` so a valid falsy artifact (`0`, `false`, `""`) on
  // the seed message survives. The per-step update at line ~169
  // already uses `??`; pre-fix this initializer was the only
  // asymmetric coercion in the loop.
  let lastArtifact = initialMessage?.artifact ?? null;
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
    if (signal?.aborted) {
      return { outcome: "aborted", artifact: lastArtifact, steps: step };
    }
    const decision = await supervisorDecision({ thread, lastArtifact, step, workspaceId, runId, threadId, signal });
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
    // Clamp to canonical role set before incrementing so a hallucinated
    // `nextRole` from the supervisor LLM (`"analyzer"`, typos, etc.)
    // can't bankrupt the TSDB. Bounded label cardinality:
    // 8 roles × N outcomes = 8N series.
    try { agentSupervisorDecisionsTotal.inc({ nextRole: clampRoleLabel(nextRole) }); } catch {}
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
    await annotateThreadSpan({
      provider: "supervisor",
      agentRole: nextRole,
      operation: "autonomous_thread_step",
    });
    const msg = await runAgent({ role: nextRole, instruction: decision.instruction, thread, step, workspaceId, runId, threadId, signal });
    thread.push(msg);
    // AUTO-023 B5.3 — skip `lastArtifact` updates for tool envelopes.
    // `tool_call` artifacts carry `{tool, args}` (infrastructure metadata,
    // not work product) and `tool_result` artifacts carry `{toolCallId,
    // tool, result}` — neither is the "last meaningful artifact" the
    // thread should return. Without this guard, a reviewer that emits a
    // tool_call after the author produced `{tests: [...]}` would overwrite
    // the tests with tool metadata, and any subsequent terminate /
    // timeout / max_steps return would surface tool noise as the final
    // artifact (the original lifeguard finding).
    if (msg?.intent !== "tool_call" && msg?.intent !== "tool_result") {
      lastArtifact = msg?.artifact ?? lastArtifact;
    }

    if (msg?.intent === "tool_call" && msg?.artifact?.tool) {
      const cfg = workspaceId ? agentConfigRepo.getByRole(workspaceId, nextRole) : null;
      const toolCallId = msg?.id || `tool-${Date.now()}`;
      // AUTO-023 B5.3 — persist the `tool_call` envelope BEFORE
      // dispatch so the SSE snapshot + UI timeline see the request
      // even if the tool throws synchronously. `emitAgentMessage` is
      // best-effort: a missing `runId`/`workspaceId` (standalone
      // smoke-test path) degrades to a logged warn + null return.
      if (runId && workspaceId) {
        emitAgentMessage({
          id: toolCallId, runId, workspaceId, threadId,
          traceId: getCurrentTraceId() || `trace-${runId}`,
          fromRole: nextRole, toRole: nextRole, intent: "tool_call",
          artifact: { tool: msg.artifact.tool, args: msg.artifact.args || {} },
          rationale: msg.rationale || null, round: step, replyToId: null, createdAt: nowIso(),
        });
      }
      let resultMsg;
      try {
        const out = await executeToolCall({
          tool: msg.artifact.tool,
          args: msg.artifact.args || {},
          role: nextRole,
          allowedTools: Array.isArray(cfg?.allowedTools) ? cfg.allowedTools : null,
          context: { workspaceId, threadId, runId, fromRole: nextRole },
        });
        resultMsg = {
          fromRole: nextRole, toRole: nextRole, intent: "tool_result",
          artifact: { toolCallId, tool: msg.artifact.tool, result: out.result }, rationale: "tool_executed",
        };
      } catch (err) {
        resultMsg = {
          fromRole: nextRole, toRole: nextRole, intent: "tool_result",
          artifact: { toolCallId, tool: msg.artifact.tool, error: err?.message || "tool_error", code: err?.code || null }, rationale: "tool_error",
        };
      }
      thread.push(resultMsg);
      // AUTO-023 B5.3 — deliberately do NOT update `lastArtifact` with
      // the tool_result envelope. The `tool_result` is infrastructure
      // metadata (`{toolCallId, tool, result|error}`) that the supervisor
      // reads off `thread[last]` for routing decisions, not a meaningful
      // work product for the thread's terminal return value. Keeping
      // `lastArtifact` pinned to the most recent author/oracle/reviewer
      // handoff means a subsequent timeout / max_steps / quota_exhausted
      // return surfaces the actual tests, not tool noise.
      // AUTO-023 B5.3 — persist the matching `tool_result` so the
      // `tool_call` → `tool_result` pair shows up as a single
      // round-trip in the UI timeline (replyToId chains them).
      if (runId && workspaceId) {
        emitAgentMessage({
          runId, workspaceId, threadId,
          traceId: getCurrentTraceId() || `trace-${runId}`,
          fromRole: resultMsg.fromRole, toRole: resultMsg.toRole, intent: "tool_result",
          artifact: resultMsg.artifact, rationale: resultMsg.rationale, round: step,
          replyToId: toolCallId, createdAt: nowIso(),
        });
      }
    }

    // AUTO-023 B5.4 — peer Q&A: route an `answer` envelope back to the
    // waiting `thread.askPeer` caller. Pre-fix `answerPeer` had no
    // production caller — only unit tests invoked it directly, so the
    // round-trip only worked under test. Now any agent that emits
    // `intent: "answer"` with `{ toolCallId, answer }` resolves the
    // peer's pending Promise and the askPeer caller continues.
    if (msg?.intent === "answer" && msg?.artifact?.toolCallId) {
      try {
        answerPeer({
          toolCallId: msg.artifact.toolCallId,
          answer: msg.artifact.answer ?? msg.artifact,
          runId, workspaceId, threadId,
          fromRole: nextRole,
          toRole: msg.toRole || null,
        });
      } catch { /* best-effort — answerPeer is decorative, never break the thread */ }
    }
    emitAgentMessage({
      runId, workspaceId, threadId, traceId: getCurrentTraceId() || `trace-${runId || "standalone"}`,
      fromRole: "supervisor", toRole: nextRole, intent: "handoff", artifact: { instruction: decision.instruction }, rationale: decision.rationale || null, round: step, replyToId: null, createdAt: nowIso(),
    });
  }
  try { agentThreadStepsTotal.observe({ outcome: "max_steps" }, Math.max(1, stepsLimit)); } catch {}
  try { agentThreadDurationSeconds.observe({ outcome: "max_steps" }, Math.max(0.001, (Date.now() - startedAt) / 1000)); } catch {}
  return { outcome: "max_steps", artifact: lastArtifact, steps: stepsLimit };
}

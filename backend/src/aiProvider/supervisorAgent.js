/**
 * @module aiProvider/supervisorAgent
 * @description AUTO-023 Bundle 4 — real supervisor LLM bridge for the
 * autonomous orchestrator (`agentOrchestrator.runAutonomousThread`).
 *
 * The orchestrator is pure plumbing: it takes a `supervisorDecision`
 * callback that says "who speaks next, or terminate". This module is
 * the production implementation of that callback — it serialises the
 * thread into the supervisor prompt, dispatches a single
 * `generateText({ agentRole: "supervisor" })` call, parses the
 * strict-JSON response, and normalises it through
 * `supervisorPrompt.normalizeSupervisorDecision`.
 *
 * ### Parse-failure contract
 *
 * A supervisor that returns malformed JSON or unparseable content MUST
 * terminate the thread (`{ terminate: true, rationale:
 * "supervisor_parse_error" }`) — anything else risks an infinite loop
 * where the LLM keeps emitting garbage and the orchestrator keeps
 * re-prompting. Mirrors the `normalizeReviewerVerdict` "downgrade
 * unknown to accept" safety downgrade in `prompts/reviewerPrompt.js`.
 *
 * ### B4.1 weak-model warning
 *
 * One-shot per thread: if the resolved supervisor route points at a
 * model in `WEAK_SUPERVISOR_MODEL_TOKENS`, emit an `agent_event`
 * `phase: "finding"` with `data.kind: "supervisor_weak_model"` so the
 * run-detail page renders the advisory on the same channel as the
 * AI-005c single-agent-collapse warning. Idempotent + best-effort.
 */

import { generateText as defaultGenerateText, parseJSON } from "./index.js";
import { resolveRoute } from "./registry.js";
import { emitAgentEvent } from "./agentEventEmitter.js";
import { buildSupervisorPrompt, normalizeSupervisorDecision } from "../prompts/supervisorPrompt.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { PIPELINE_STEPS } from "../utils/pipelineState.js";

// AUTO-023 B4.1 — substring-matched (case-insensitive) against
// `route.model` so vendor model-id variants
// (`gpt-4o-mini-2024-07-18`, `claude-3-5-haiku-20241022`,
// `gemini-1.5-flash-002`) all trip the warning without needing a new
// entry per release. Closed set so cardinality stays bounded.
const WEAK_SUPERVISOR_MODEL_TOKENS = Object.freeze([
  "haiku",
  "mini",   // gpt-4o-mini, gpt-4.1-mini
  "flash",  // gemini-*-flash
  "nano",   // gpt-4.1-nano if/when it ships
  "8b",     // llama-3.1-8b, mistral-8b
  "7b",     // mistral-7b, llama-2-7b
]);

function isWeakSupervisorModel(modelId) {
  if (!modelId) return false;
  const m = String(modelId).toLowerCase();
  return WEAK_SUPERVISOR_MODEL_TOKENS.some((tok) => m.includes(tok));
}

// Per-thread one-shot warning latch.
//
// Bounded LRU (10k entries) — autonomous threads are 10-min-cap each,
// so even at 100 concurrent threads the working set is ~600/hour. The
// 10k bound covers ~16h of peak load before eviction; eviction is
// silently fine since the LRU only governs whether the operator gets
// a SECOND advisory for a re-warned thread (which is harmless — the
// advisory is informational, not an action gate).
//
// Object-keyed threads use a WeakSet so they don't anchor GC. The
// LRU only applies to the string-keyed path (typical case).
const WEAK_WARNING_LRU_MAX = 10_000;
const weakWarningFiredByString = new Map(); // Map for insertion-order LRU
const weakWarningFired = new WeakSet();

function markWeakWarningFired(threadKey) {
  if (typeof threadKey === "object" && threadKey !== null) {
    weakWarningFired.add(threadKey);
    return;
  }
  if (!threadKey) return;
  // Map preserves insertion order. Note: `Map.set()` on an existing
  // key does NOT move it to the end — but this code path is only
  // reached when `hasWeakWarningFired` returned false, so the same
  // key is never re-set. Eviction uses FIFO (oldest insertion first)
  // which is equivalent to LRU for write-once keys.
  weakWarningFiredByString.set(threadKey, true);
  if (weakWarningFiredByString.size > WEAK_WARNING_LRU_MAX) {
    const oldest = weakWarningFiredByString.keys().next().value;
    if (oldest !== undefined) weakWarningFiredByString.delete(oldest);
  }
}

function hasWeakWarningFired(threadKey) {
  if (typeof threadKey === "object" && threadKey !== null) return weakWarningFired.has(threadKey);
  return weakWarningFiredByString.has(threadKey);
}

/**
 * Test-only — clear per-thread warning latches so a fresh test starts
 * from a clean slate. Never call from product code; the warning is
 * deliberately one-shot per thread lifetime.
 * @internal
 */
export function _resetSupervisorWarningsForTests() {
  weakWarningFiredByString.clear();
}

/**
 * One-shot weak-supervisor-model advisory. Idempotent + best-effort.
 *
 * AI-005c interaction: single-agent workspaces (no `agent_configs`
 * row) running an autonomous thread on a Haiku-tier default IS the
 * weak-supervisor scenario this warning targets, so we fire even when
 * `resolveRoute` returns `effectiveAgentRole: null`. The collapse
 * rule applies to breaker / sticky / metrics keying, not to operator
 * UX advisories.
 */
function maybeWarnWeakSupervisorModel({ runId, workspaceId, threadId }) {
  if (!runId || !threadId) return;
  if (hasWeakWarningFired(threadId)) return;
  try {
    const { route } = resolveRoute({ agentRole: "supervisor", workspaceId });
    const model = route?.model || null;
    if (!isWeakSupervisorModel(model)) return;
    markWeakWarningFired(threadId);
    emitAgentEvent(runId, {
      step: PIPELINE_STEPS?.REVIEW ?? 7,
      agent: "supervisor",
      phase: "finding",
      message: `Supervisor is routed to a low-reasoning model (${model}). Autonomous orchestration accuracy degrades on weak supervisors — consider Claude Sonnet, GPT-4o, or Gemini Pro for this role.`,
      data: {
        kind: "supervisor_weak_model",
        model,
        routeId: route?.id || null,
        threadId,
      },
      workspaceId,
    });
  } catch { /* best-effort — never break the thread on observability failure */ }
}

/**
 * Production `supervisorDecision` callback for `runAutonomousThread`.
 *
 * Dispatches a single `generateText({ agentRole: "supervisor", … })`
 * call. `responseFormat: { type: "json_object" }` asks the provider
 * for strict JSON; providers that don't honour the hint still
 * typically comply with the prompt's "Return STRICT JSON only"
 * preamble. Parse failures and dispatch failures both terminate the
 * thread with a distinct `rationale` so the orchestrator's caller
 * can branch on the cause.
 *
 * @param {Object} args
 * @param {Array}  args.thread       Full envelope thread from the orchestrator.
 * @param {Object|null} args.lastArtifact
 * @param {number} args.step
 * @param {string|null} args.workspaceId
 * @param {string|null} args.runId
 * @param {string|null} args.threadId
 * @param {AbortSignal} [args.signal]
 * @param {Object} [args.policy]
 * @returns {Promise<Object>} Normalised supervisor decision.
 */
export async function supervisorDecisionFromLLM({
  thread = [],
  lastArtifact = null,
  step = 0,
  workspaceId = null,
  runId = null,
  threadId = null,
  signal,
  policy = {},
  // AUTO-023 B4 — dependency-injection seam for `generateText`. The
  // production caller in `crawler.js` doesn't pass this; tests pass
  // a stub. Accepting it as an arg sidesteps the ESM-namespace mock
  // problem in Node 20+ (`mock.method(import * as ns, "generateText")`
  // throws `Cannot redefine property` because module-namespace
  // bindings are non-configurable per the ECMAScript spec). Same
  // pattern `agentLoop.runReviewerAuthorLoop` uses for `runAuthor`
  // / `runReviewer` so the orchestrator stays testable in isolation.
  generateText = defaultGenerateText,
} = {}) {
  maybeWarnWeakSupervisorModel({ runId, workspaceId, threadId });

  const prompt = buildSupervisorPrompt({
    transcript: thread,
    lastArtifact,
    policy: { ...policy, step },
  });

  let raw;
  try {
    raw = await generateText(prompt, {
      agentRole: "supervisor",
      workspaceId,
      signal,
      // String-shape responseFormat to match the codebase convention
      // (`dispatcher.js#buildAdapterOpts` defaults to the string
      // `"json_object"`; the health-check probe + agentLoop reviewer
      // call all pass strings). Object-shape `{ type: "json_object" }`
      // worked but inconsistent and risks future-adapter pattern-match
      // breakage if a downstream adapter does `=== "json_object"`.
      responseFormat: "json_object",
    });
  } catch (err) {
    // Dispatch failure (rate limit, auth, network) — terminate safely.
    // Throwing here would crash the entire autonomous thread before
    // the orchestrator's `runLinearFallback` hook ever runs.
    console.warn(formatLogLine("warn", runId,
      `[supervisorAgent] generateText failed (${err?.message || "unknown"}); terminating thread`));
    return {
      terminate: true,
      finalArtifact: lastArtifact,
      rationale: "supervisor_dispatch_error",
    };
  }

  let parsed;
  try {
    parsed = parseJSON(raw);
  } catch (err) {
    // Strict-JSON contract violated — terminate. Same rationale as
    // `normalizeReviewerVerdict`'s downgrade-unknown safety net.
    console.warn(formatLogLine("warn", runId,
      `[supervisorAgent] parse failed (${err?.message || "unknown"}); terminating thread. raw=${String(raw).slice(0, 120)}`));
    return {
      terminate: true,
      finalArtifact: lastArtifact,
      rationale: "supervisor_parse_error",
    };
  }

  return normalizeSupervisorDecision(parsed);
}

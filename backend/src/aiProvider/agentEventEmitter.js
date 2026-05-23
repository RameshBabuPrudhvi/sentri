/**
 * @module aiProvider/agentEventEmitter
 * @description Per-agent SSE event emitter (Task 2 — backend agent events).
 *
 * Bridges the pipeline LLM call sites and the SSE delivery layer:
 *
 *   pipeline call site            agentEventEmitter            SSE layer
 *   ──────────────────            ─────────────────            ─────────
 *   emitAgentEvent(runId, {…}) → persist via repo       →     run_agent_events
 *                              → broadcast via emitRunEvent → "agent_event"
 *
 * Persistence is best-effort — a DB failure must never break the originating
 * LLM call. The pattern mirrors `runLogger.log()` which also swallows
 * `appendLog` failures so a broken logs table can't take down a run.
 *
 * ### Event shape
 *
 *   { step, agent, phase, message, data, nextAgent, model, createdAt }
 *
 * Every field except `step` / `agent` / `phase` / `createdAt` is nullable.
 * The five legal phase values are constrained by the migration 057
 * CHECK clause (start | progress | finding | handoff | done) — passing an
 * invalid phase throws at INSERT time, which is the intended fail-fast.
 *
 * ### Frontend contract
 *
 *   useRunSSE dispatches `{ type: "agent_event", … }` to consumers.
 *   The NarrativeFeed component (frontend/src/pages/TestLab.jsx) reads
 *   `runData.agentEvents[]` from the SSE snapshot hydration and appends
 *   incrementally on every live `agent_event` push.
 */

import * as repo from "../database/repositories/runAgentEventRepo.js";
import { emitRunEvent } from "../routes/sse.js";

/**
 * Persist + broadcast one per-agent event.
 *
 * No-op when `runId` is null/empty so single-test eval-harness paths and
 * standalone CLI helpers (which call `generateText` without a run context)
 * don't trip an INSERT against an invalid foreign key.
 *
 * @param {string|null} runId
 * @param {Object} event
 * @param {number}      event.step       - Pipeline step (1–8).
 * @param {string}      event.agent      - AGENT_ROLES value.
 * @param {string}      event.phase      - start | progress | finding | handoff | done.
 * @param {string|null} [event.message]
 * @param {Object|string|null} [event.data]    - Structured payload (serialised before persist).
 * @param {string|null} [event.nextAgent]
 * @param {string|null} [event.model]
 */
export function emitAgentEvent(runId, { step, agent, phase, message, data, nextAgent, model } = {}) {
  if (!runId) return;
  const evt = {
    step,
    agent,
    phase,
    message: message ?? null,
    // Serialise here so both the DB and the SSE payload carry the same
    // canonical shape — the snapshot hydration parses it back on read.
    data: data == null
      ? null
      : (typeof data === "string" ? data : JSON.stringify(data)),
    nextAgent: nextAgent ?? null,
    model: model ?? null,
    createdAt: new Date().toISOString(),
  };
  // Persistence is best-effort. A failure here must NEVER break the
  // originating LLM call — the run continues and the operator just
  // misses a narrative line in the replay.
  try { repo.append(runId, evt); } catch { /* non-fatal */ }
  emitRunEvent(runId, "agent_event", evt);
}

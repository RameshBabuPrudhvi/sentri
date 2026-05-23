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

  // ── `data` shape on the wire ─────────────────────────────────────────────
  // Live SSE pushes AND the snapshot hydration MUST deliver `data` in the
  // same shape — pre-fix the live event delivered it as a JSON string while
  // `routes/sse.js` parsed it back to an object on the snapshot. A frontend
  // consumer that seeds its buffer from `snapshot.run.agentEvents` (objects)
  // and then appends live `agent_event` pushes (strings) ended up with mixed
  // types in the same array (devin-ai-integration review thread).
  //
  // The contract is now: `data` is the **structured object** on every wire
  // delivery. The DB column is TEXT-only, so we keep a separate stringified
  // shape (`dataForPersist`) for the repo write only; `repo.append` also
  // serialises defensively if a future caller bypasses this helper.
  const createdAt = new Date().toISOString();
  const dataForPersist = data == null
    ? null
    : (typeof data === "string" ? data : JSON.stringify(data));
  // The broadcast/payload version: structured object (or pre-parsed when the
  // caller already supplied a string — best-effort parse, fall back to the
  // raw string on malformed input rather than dropping the event).
  let dataForBroadcast = data ?? null;
  if (typeof data === "string") {
    try { dataForBroadcast = JSON.parse(data); }
    catch { dataForBroadcast = data; }
  }

  // Persistence is best-effort. A failure here must NEVER break the
  // originating LLM call — the run continues and the operator just
  // misses a narrative line in the replay.
  try {
    repo.append(runId, {
      step, agent, phase,
      message: message ?? null,
      data: dataForPersist,
      nextAgent: nextAgent ?? null,
      model: model ?? null,
      createdAt,
    });
  } catch { /* non-fatal */ }

  // Broadcast carries the structured `data` so live consumers and snapshot
  // consumers see the identical shape. Matches the parsed-back form
  // `routes/sse.js` builds for the snapshot's `agentEvents[]` hydration.
  emitRunEvent(runId, "agent_event", {
    step,
    agent,
    phase,
    message: message ?? null,
    data: dataForBroadcast,
    nextAgent: nextAgent ?? null,
    model: model ?? null,
    createdAt,
  });
}

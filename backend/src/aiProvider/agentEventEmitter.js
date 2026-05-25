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
 * LLM call. We're MORE defensive than `runLogger.log()` (which calls
 * `runLogRepo.appendLog` directly without a try/catch and would propagate
 * a DB outage up to every pipeline `log(...)` call site) because the
 * agent-event surface is decorative — silently degraded narrative replay
 * is the correct fallback, whereas log-write failures arguably should
 * surface. Errors are caught + logged to stdout via `formatLogLine` so a
 * sustained DB outage is observable in ops dashboards without breaking
 * the run.
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
import * as agentMessageRepo from "../database/repositories/agentMessageRepo.js";
import { validateEnvelope } from "./agentEnvelope.js";
import { randomUUID } from "crypto";
import { emitRunEvent } from "../routes/sse.js";
import { formatLogLine } from "../utils/logFormatter.js";
// Task 2 — `model` resolution. `resolveRoute({ agentRole, workspaceId })`
// returns the same route the pipeline's `generateText(...)` call will use
// at dispatch time, so reading `route.model` here gives the operator
// per-event attribution that matches what actually ran. Resolution is
// best-effort + lazy: callers pass `workspaceId` (no extra field added at
// every emit site) and we only invoke the resolver when both `workspaceId`
// + `agent` are known. Mirrors the resolution path
// `agentHealthCheck.js#probeRole` uses for its provider-id surfacing.
import { resolveRoute } from "./registry.js";

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
 * @param {string|null} [event.model]      - Explicit override; if omitted and
 *   `workspaceId` is provided, the emitter resolves the model via
 *   `resolveRoute({ agentRole: agent, workspaceId })` so the persisted +
 *   broadcast event carries the same model id that `generateText` will
 *   actually dispatch against. Pass `null` to suppress resolution.
 * @param {string|null} [event.workspaceId] - Used for `model` resolution
 *   when `event.model` is not explicitly set. Same workspace scope the
 *   pipeline call site already passes to `generateText` — no extra plumbing
 *   needed at the emit site.
 */
export function emitAgentEvent(runId, { step, agent, phase, message, data, nextAgent, model, workspaceId } = {}) {
  if (!runId) return;

  // ── `model` resolution ──────────────────────────────────────────────────
  // Operator attribution surface: every persisted + broadcast event carries
  // the model that the matching `generateText` call will actually dispatch
  // against. Pre-fix the column was always null because no call site passed
  // `model` explicitly. Resolving here (rather than at every call site)
  // keeps the emit invocation lean — call sites just add `workspaceId` to
  // the event payload, mirroring the `workspaceId` they already thread
  // through `generateText`. Best-effort: resolver failures degrade to null
  // (the column is nullable) and are logged the same way as persist
  // failures so a sustained registry outage is observable.
  let resolvedModel = model ?? null;
  if (resolvedModel == null && workspaceId && agent) {
    try {
      const { route } = resolveRoute({ agentRole: agent, workspaceId });
      resolvedModel = route?.model || null;
    } catch (err) {
      // Same observability contract as the persist + broadcast paths
      // below — log once, degrade to null, don't break the LLM call.
      console.warn(formatLogLine("warn", runId,
        `[agentEventEmitter] model resolution failed (${agent}): ${err?.message || err}`));
    }
  }

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
  // misses a narrative line in the replay. We log the error to stdout
  // via `formatLogLine` so a sustained DB outage (disk full, WAL
  // corruption, CHECK-constraint typo) shows up in ops dashboards —
  // pre-fix the empty catch silently dropped every event, leaving
  // operators to wonder why the NarrativeFeed went blank.
  try {
    repo.append(runId, {
      step, agent, phase,
      message: message ?? null,
      data: dataForPersist,
      nextAgent: nextAgent ?? null,
      model: resolvedModel,
      createdAt,
    });
  } catch (err) {
    console.warn(formatLogLine("warn", runId,
      `[agentEventEmitter] persist failed (${agent}/${phase}): ${err?.message || err}`));
  }

  // Broadcast carries the structured `data` so live consumers and snapshot
  // consumers see the identical shape. Matches the parsed-back form
  // `routes/sse.js` builds for the snapshot's `agentEvents[]` hydration.
  //
  // Wrapped in try/catch for the same reason persistence is — the docblock
  // contract promises this helper "must NEVER break the originating LLM
  // call". `emitRunEvent` is unlikely to throw (JSON.stringify on this
  // shape always succeeds, Redis publish has `.catch(() => {})`, and the
  // local-fanout wraps each `res.write` in try/catch), but a single
  // unexpected error here would propagate up to call sites like
  // `journeyGenerator.generateFromDescription` which has no outer
  // try/catch — crashing the whole user-initiated run.
  try {
    emitRunEvent(runId, "agent_event", {
      step,
      agent,
      phase,
      message: message ?? null,
      data: dataForBroadcast,
      nextAgent: nextAgent ?? null,
      model: resolvedModel,
      createdAt,
    });
  } catch (err) {
    // Non-fatal — broadcast failure must never break the LLM call. Logged
    // so a misbehaving SSE layer (e.g. JSON.stringify reject on a cyclic
    // `data` payload from a future caller) is observable in ops dashboards.
    console.warn(formatLogLine("warn", runId,
      `[agentEventEmitter] broadcast failed (${agent}/${phase}): ${err?.message || err}`));
  }
}


export function emitAgentMessage(envelope = {}) {
  // Spread `envelope` FIRST, then layer the computed defaults on top so the
  // `||` / `??` fallbacks actually win when the caller passed a falsy /
  // nullish value (or omitted the field entirely). Pre-fix the spread came
  // last and clobbered the auto-generated `id` / `createdAt` / `round` with
  // whatever the caller had on the source object — including `undefined`,
  // which then tripped `ERR_AGENT_ENVELOPE_INVALID` instead of falling
  // back to the generated default (lifeguard finding).
  const withDefaults = {
    ...envelope,
    id: envelope.id || `am-${randomUUID()}`,
    createdAt: envelope.createdAt || new Date().toISOString(),
    round: envelope.round ?? 0,
  };

  // Validation is wrapped in its own try/catch so a malformed envelope
  // (`ERR_AGENT_ENVELOPE_INVALID` from `validateEnvelope`) degrades to a
  // logged warning + `null` return — same defensive posture the sibling
  // `emitAgentEvent` already uses for persist + broadcast. The module
  // docblock above promises this helper "must NEVER break the originating
  // LLM call"; without this guard, the eventual Bundle 2 / 3 pipeline
  // call sites that hand-build envelopes would propagate a Zod failure
  // up through the LLM call stack and crash the user-initiated run
  // (lifeguard finding).
  let valid;
  try {
    valid = validateEnvelope(withDefaults);
  } catch (err) {
    console.warn(formatLogLine("warn", envelope?.runId || null,
      `[agentEventEmitter] agent_message validation failed (${envelope?.fromRole || "?"}/${envelope?.intent || "?"}): ${err?.message || err}`));
    return null;
  }

  try {
    agentMessageRepo.append(valid);
  } catch (err) {
    console.warn(formatLogLine("warn", valid.runId || null,
      `[agentEventEmitter] agent_message persist failed (${valid.fromRole}/${valid.intent}): ${err?.message || err}`));
  }

  try {
    emitRunEvent(valid.runId, "agent_message", valid);
  } catch (err) {
    console.warn(formatLogLine("warn", valid.runId || null,
      `[agentEventEmitter] agent_message broadcast failed (${valid.fromRole}/${valid.intent}): ${err?.message || err}`));
  }

  return valid;
}

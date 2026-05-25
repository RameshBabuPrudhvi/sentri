/**
 * @module aiProvider/agentHandoff
 * @description Envelope-mediated handoff helpers (AUTO-023 Bundle 2).
 *
 * Central read/write seam every pipeline stage uses to participate in the
 * `agent_messages` thread. Exposes:
 *
 *   - `mainThreadId(runId)` / `healingThreadId(runId, testId)` — canonical
 *     thread id formatters so pipeline + self-healing call sites agree on
 *     where to read and write envelopes.
 *   - `readLatestEnvelope({ threadId, workspaceId, toRole })` — resolve the
 *     latest envelope addressed to a role; short-circuits in `pipeline` mode
 *     via `isEnvelopeReadEnabled()` (B2.4 writes-on / reads-off shim).
 *   - `emitHandoffEnvelope({ ... })` — best-effort wrapper around
 *     `emitAgentMessage` with `intent: "handoff"`. No-ops on missing required
 *     fields so callers without a `runId` (eval harness, CLI) don't trip an
 *     insert against a null FK.
 *
 * Test seam: `_setReadsSpyForTests(spy)` is consumed by
 * `backend/tests/agent-pipeline-envelope.test.js` to capture every
 * `readLatestEnvelope` invocation from inside real pipeline functions so the
 * B2.2 wiring contract can be asserted on the BEFORE-side (read fires with
 * the right args) and not just the AFTER-side (envelope row landed in DB).
 */

import * as agentMessageRepo from "../database/repositories/agentMessageRepo.js";
import { emitAgentMessage } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";
import { isEnvelopeReadEnabled } from "./agentMode.js";

/**
 * Format the canonical thread id for a pipeline run's main author/reviewer
 * thread.
 *
 * @param {string} runId  Originating run id.
 * @returns {string}      Thread id of the form `${runId}-main`.
 */
export function mainThreadId(runId) {
  return `${runId}-main`;
}

/**
 * Format the canonical thread id for a self-healing roundtrip on a specific
 * test. Keyed by testId so multiple tests healing in the same run carry
 * independent threads.
 *
 * @param {string} runId   Originating run id.
 * @param {string} testId  Test id (versioned ids like `${id}@v${codeVersion}` round-trip cleanly).
 * @returns {string}       Thread id of the form `${runId}-heal-${testId}`.
 */
export function healingThreadId(runId, testId) {
  return `${runId}-heal-${testId}`;
}

// AUTO-023 Bundle 2 — test seam. Production code never enables this; the
// B2.6 envelope-pipeline parity test in `backend/tests/agent-pipeline-envelope.test.js`
// flips `_readsSpy` on to capture every `readLatestEnvelope` invocation
// (request args + the resolved row's id, or null) so it can prove that
// real pipeline functions — `generateApiTests`, `generateJourneyTest`,
// `generateIntentTests`, `feedbackLoop.regenerateFailingTest` — actually
// call `readLatestEnvelope` at stage entry per the B2.2 contract, NOT
// just trust that the wrapper was wired correctly. Without this seam the
// pipeline-driven test can only assert AFTER-side effects (envelope rows
// in the DB), which the helper-level test already covers; the spy adds
// the BEFORE-side contract assertion (read fires with the right args)
// the B2.2 wiring needs.
let _readsSpy = null;
export function _setReadsSpyForTests(spy) { _readsSpy = spy; }

/**
 * Resolve the most recent envelope on `threadId` addressed to `toRole`,
 * scoped to `workspaceId`.
 *
 * Returns `null` (without touching the DB) when any guard arg is missing
 * or when the current `SENTRI_AGENT_MODE` is `pipeline` — this is the
 * B2.4 writes-on / reads-off shim that lets envelope writes build an
 * audit trail before any consumer flips to envelope-mode reads.
 *
 * @param {Object} args
 * @param {string} args.threadId     Thread id (typically from `mainThreadId` / `healingThreadId`).
 * @param {string} args.workspaceId  Workspace scope for the read.
 * @param {string} args.toRole       Recipient role filter (`"planner"`, `"author"`, `"reviewer"`, …).
 * @returns {Object|null}            The latest matching envelope row, or `null` when gated/empty/missing args.
 */
export function readLatestEnvelope({ threadId, workspaceId, toRole }) {
  if (!threadId || !workspaceId || !toRole || !isEnvelopeReadEnabled()) {
    if (_readsSpy) _readsSpy({ threadId, workspaceId, toRole, result: null, gated: !isEnvelopeReadEnabled() });
    return null;
  }
  const rows = agentMessageRepo.listByThread(threadId, workspaceId, toRole);
  const result = rows[rows.length - 1] || null;
  if (_readsSpy) _readsSpy({ threadId, workspaceId, toRole, result, gated: false });
  return result;
}

/**
 * Best-effort wrapper around `emitAgentMessage` that stamps `intent: "handoff"`
 * and the current trace id, then persists the envelope.
 *
 * Returns `null` (no DB write) when any required field is missing — pipeline
 * call sites without a run context (eval harness, CLI) get a safe no-op
 * instead of an insert against a null FK.
 *
 * @param {Object} args
 * @param {string} args.runId         Originating run id (or `CHAT-${uuid}` for chat threads).
 * @param {string} args.threadId      Thread id (`mainThreadId` / `healingThreadId`).
 * @param {string} args.workspaceId   Workspace scope.
 * @param {string} args.fromRole      Sender role (closed-set per `agentEnvelope.ROLES`).
 * @param {string} [args.toRole]      Recipient role (or null for broadcast).
 * @param {Object} [args.artifact]    Stage artifact payload (validated downstream).
 * @param {string} [args.rationale]   Free-text rationale surfaced in the UI.
 * @param {number} [args.round=0]     Round counter (0 for pipeline single-pass, ≥0 for loops).
 * @param {string} [args.replyToId]   Id of the envelope this one replies to, threading the chain.
 * @returns {Object|null}             The persisted envelope row, or `null` on guard short-circuit.
 */
export function emitHandoffEnvelope({ runId, threadId, workspaceId, fromRole, toRole, artifact = null, rationale = null, round = 0, replyToId = null }) {
  if (!runId || !threadId || !workspaceId || !fromRole) return null;
  return emitAgentMessage({
    runId,
    threadId,
    traceId: getCurrentTraceId() || `trace-${runId}`,
    fromRole,
    toRole: toRole || null,
    replyToId,
    intent: "handoff",
    artifact,
    rationale,
    round,
    workspaceId,
  });
}

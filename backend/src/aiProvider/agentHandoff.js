import * as agentMessageRepo from "../database/repositories/agentMessageRepo.js";
import { emitAgentMessage } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";
import { isEnvelopeReadEnabled } from "./agentMode.js";

export function mainThreadId(runId) {
  return `${runId}-main`;
}

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

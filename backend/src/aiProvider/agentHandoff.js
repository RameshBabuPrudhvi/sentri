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

export function readLatestEnvelope({ threadId, workspaceId, toRole }) {
  if (!threadId || !workspaceId || !toRole || !isEnvelopeReadEnabled()) return null;
  const rows = agentMessageRepo.listByThread(threadId, workspaceId, toRole);
  return rows[rows.length - 1] || null;
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

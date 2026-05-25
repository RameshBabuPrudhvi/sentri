import { emitAgentMessage } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";
import { randomUUID } from "crypto";

const HARD_MAX_REVIEW_ROUNDS = 10;
const DEFAULT_MAX_REVIEW_ROUNDS = 3;

export class ReviewRejection extends Error {
  constructor(message = "Reviewer rejected final artifact") {
    super(message);
    this.name = "ReviewRejection";
    this.code = "ERR_REVIEW_REJECT_FINAL";
  }
}

function clampReviewRounds(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_MAX_REVIEW_ROUNDS), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_REVIEW_ROUNDS;
  return Math.min(parsed, HARD_MAX_REVIEW_ROUNDS);
}

function nowIso() {
  return new Date().toISOString();
}

function toMessage({ runId, threadId, workspaceId, fromRole, toRole, intent, artifact, rationale, round, replyToId }) {
  return emitAgentMessage({
    id: `am-${randomUUID()}`,
    runId,
    threadId,
    traceId: getCurrentTraceId() || `trace-${runId || "standalone"}`,
    fromRole,
    toRole: toRole ?? null,
    replyToId: replyToId ?? null,
    intent,
    artifact: artifact ?? null,
    rationale: rationale ?? null,
    round,
    workspaceId,
    createdAt: nowIso(),
  });
}

/**
 * Bundle 3 loop substrate: author/reviewer roundtrip with bounded termination.
 * Callers inject `runAuthor` and `runReviewer` wrappers around existing
 * pipeline/prompt call-sites so this module stays orchestration-only.
 */
export async function runReviewerAuthorLoop(initialArtifact, {
  runAuthor,
  runReviewer,
  runId = null,
  threadId = null,
  workspaceId = null,
  maxReviewRounds = DEFAULT_MAX_REVIEW_ROUNDS,
} = {}) {
  if (typeof runAuthor !== "function" || typeof runReviewer !== "function") {
    throw new Error("runReviewerAuthorLoop requires runAuthor + runReviewer functions");
  }
  const maxRounds = clampReviewRounds(maxReviewRounds);
  let round = 0;
  let currentArtifact = initialArtifact;
  let prevReviewerFeedback = null;
  let lastAuthorArtifact = initialArtifact;
  let lastReviewerMsgId = null;

  while (round < maxRounds) {
    const authorArtifact = await runAuthor({
      round,
      artifact: currentArtifact,
      reviewerIssues: prevReviewerFeedback,
    });
    lastAuthorArtifact = authorArtifact;
    toMessage({
      runId, threadId, workspaceId,
      fromRole: "author", toRole: "reviewer",
      intent: "handoff", artifact: authorArtifact,
      rationale: "Author revision handoff",
      round,
      replyToId: lastReviewerMsgId,
    });

    const reviewer = await runReviewer({ round, artifact: authorArtifact });
    const intent = reviewer?.intent || "accept";
    const artifact = reviewer?.artifact ?? null;
    const reviewerMsg = toMessage({
      runId, threadId, workspaceId,
      fromRole: "reviewer",
      toRole: intent === "request_revision" ? "author" : "supervisor",
      intent,
      artifact,
      rationale: reviewer?.rationale || null,
      round,
    });
    lastReviewerMsgId = reviewerMsg?.id || null;

    if (intent === "accept") {
      return { outcome: "accept", round, artifact: authorArtifact };
    }
    if (intent === "reject_final") {
      throw new ReviewRejection();
    }
    prevReviewerFeedback = artifact?.issues || [];
    currentArtifact = authorArtifact;
    round += 1;
  }

  return { outcome: "max_rounds", round: maxRounds - 1, artifact: lastAuthorArtifact };
}


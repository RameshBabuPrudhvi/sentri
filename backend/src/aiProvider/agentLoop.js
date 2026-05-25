import { emitAgentMessage } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";
import { randomUUID } from "crypto";

const HARD_MAX_REVIEW_ROUNDS = 10;
const DEFAULT_MAX_REVIEW_ROUNDS = 3;
const DEFAULT_LOOP_TIMEOUT_MS = 5 * 60 * 1000;
const HARD_MAX_LOOP_TIMEOUT_MS = 30 * 60 * 1000;

export class ReviewRejection extends Error {
  constructor(message = "Reviewer rejected final artifact") {
    super(message);
    this.name = "ReviewRejection";
    this.code = "ERR_REVIEW_REJECT_FINAL";
  }
}

function normalizeVerdict(reviewer) {
  if (!reviewer) return "accept";
  if (reviewer.intent) return reviewer.intent;
  const verdict = String(reviewer.verdict || "").toLowerCase();
  if (verdict === "accept") return "accept";
  if (verdict === "revise") return "request_revision";
  if (verdict === "reject") return "reject_final";
  return "accept";
}

function validateRevisionIssues(issues, authorArtifact) {
  const list = Array.isArray(issues) ? issues : [];
  const tests = Array.isArray(authorArtifact?.tests) ? authorArtifact.tests : [];
  if (list.length === 0) return [];
  const validIds = new Set(tests.map((t) => t?.id).filter(Boolean));
  return list.filter((i) => validIds.has(i?.testId));
}

function clampReviewRounds(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_MAX_REVIEW_ROUNDS), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_REVIEW_ROUNDS;
  return Math.min(parsed, HARD_MAX_REVIEW_ROUNDS);
}

function clampLoopTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_LOOP_TIMEOUT_MS), 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_LOOP_TIMEOUT_MS;
  return Math.min(parsed, HARD_MAX_LOOP_TIMEOUT_MS);
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
  loopTimeoutMs = DEFAULT_LOOP_TIMEOUT_MS,
} = {}) {
  if (typeof runAuthor !== "function" || typeof runReviewer !== "function") {
    throw new Error("runReviewerAuthorLoop requires runAuthor + runReviewer functions");
  }
  const maxRounds = clampReviewRounds(maxReviewRounds);
  const maxElapsedMs = clampLoopTimeoutMs(loopTimeoutMs);
  const deadline = Date.now() + maxElapsedMs;
  const maxReplyChainDepth = maxRounds * 2;
  let round = 0;
  let currentArtifact = initialArtifact;
  let prevReviewerFeedback = null;
  let lastAuthorArtifact = initialArtifact;
  let lastReviewerMsgId = null;
  let replyDepth = 0;

  while (round < maxRounds) {
    if (Date.now() > deadline) {
      return { outcome: "timeout", round: Math.max(0, round - 1), artifact: lastAuthorArtifact };
    }
    const authorArtifact = await runAuthor({
      round,
      artifact: currentArtifact,
      reviewerIssues: prevReviewerFeedback,
    });
    lastAuthorArtifact = authorArtifact;
    // Capture the author envelope's id so the reviewer's reply below can
    // thread `replyToId` back to it — completes the bidirectional chain
    // (devin-ai-integration review thread #2). Pre-fix the return value was
    // discarded and the reviewer envelope persisted `replyToId: null`,
    // breaking thread reconstruction in the UI.
    const authorMsg = toMessage({
      runId, threadId, workspaceId,
      fromRole: "author", toRole: "reviewer",
      intent: "handoff", artifact: authorArtifact,
      rationale: "Author revision handoff",
      round,
      replyToId: lastReviewerMsgId,
    });
    replyDepth += 1;
    if (replyDepth > maxReplyChainDepth) {
      const err = new Error("Reply chain depth exceeded safety bound");
      err.code = "ERR_REVIEW_CYCLE_PROTECTION";
      throw err;
    }

    const reviewer = await runReviewer({ round, artifact: authorArtifact });
    const intent = normalizeVerdict(reviewer);
    let artifact = reviewer?.artifact ?? null;
    if (intent === "request_revision") {
      const safeIssues = validateRevisionIssues(artifact?.issues, authorArtifact);
      artifact = { ...(artifact || {}), issues: safeIssues };
    }
    const reviewerMsg = toMessage({
      runId, threadId, workspaceId,
      fromRole: "reviewer",
      toRole: intent === "request_revision" ? "author" : "supervisor",
      intent,
      artifact,
      rationale: reviewer?.rationale || null,
      round,
      replyToId: authorMsg?.id || null,
    });
    lastReviewerMsgId = reviewerMsg?.id || null;
    replyDepth += 1;
    if (replyDepth > maxReplyChainDepth) {
      const err = new Error("Reply chain depth exceeded safety bound");
      err.code = "ERR_REVIEW_CYCLE_PROTECTION";
      throw err;
    }

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

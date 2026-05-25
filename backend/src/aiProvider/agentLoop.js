import { emitAgentMessage } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";

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
  if (reviewer.intent) {
    // `reject` is a valid envelope INTENT value but, in the loop's
    // verdict vocabulary, it means "unrecoverable final rejection" —
    // i.e. `reject_final`. Without this remap a reviewer callback
    // returning `{ intent: "reject" }` would silently fall through to
    // the revision/continue path (neither `accept` nor `reject_final`
    // matched the terminal checks at lines 195–200), looping until
    // `maxRounds`. Map it explicitly so the terminal check fires.
    if (reviewer.intent === "reject") return "reject_final";
    return reviewer.intent;
  }
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
  // Omit `id` — `emitAgentMessage` assigns a monotonic id via its internal
  // sequence so `(createdAt ASC, id ASC)` tiebreaks preserve insertion
  // order when multiple envelopes share the same millisecond.
  return emitAgentMessage({
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
 *
 * ### Result contract
 *
 * Every successful outcome returns `{ outcome, round, roundsCompleted, artifact }`.
 * `reject_final` throws `ReviewRejection` and is never an outcome value.
 *
 * - `round`: 0-indexed index of the final round the loop reached.
 *   `accept` → the round the reviewer accepted on.
 *   `max_rounds` → `maxRounds - 1` (last attempted round).
 *   `timeout` → 0-indexed last fully-completed round, or `-1` if the
 *   deadline fired before round 0 completed.
 * - `roundsCompleted`: 1-based count of fully-completed author↔reviewer
 *   round-trips. **This is the field operators / metrics should read**;
 *   `round` is preserved for backward-compat with pre-existing consumers.
 *   `accept` on round 0 → `1`. `max_rounds` with `maxRounds=3` → `3`.
 *   `timeout` before round 0 completes → `0`.
 *
 * ### Termination guarantees
 *
 * The deadline is checked at TWO points per iteration: top of loop (before
 * `runAuthor`) and immediately after `runReviewer`. The post-reviewer
 * check catches "single long reviewer call exceeds the budget" — without
 * it, `maxReviewRounds: 1` could never timeout because the top-of-loop
 * check on iteration 0 sees `Date.now() < deadline`. Belt-and-braces:
 * with both checks, any caller-set `loopTimeoutMs` is honoured regardless
 * of `maxReviewRounds`.
 */
export async function runReviewerAuthorLoop(initialArtifact, {
  runAuthor,
  runReviewer,
  checkQuota = null,
  onOutcome = null,
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
  let roundsCompleted = 0;
  let currentArtifact = initialArtifact;
  let prevReviewerFeedback = null;
  let lastAuthorArtifact = initialArtifact;
  let lastReviewerMsgId = null;
  let replyDepth = 0;

  while (round < maxRounds) {
    if (typeof checkQuota === "function") {
      const quota = await checkQuota({ round, runId, threadId, workspaceId });
      if (quota?.ok === false) {
        const out = {
          outcome: "quota_exhausted",
          round: roundsCompleted === 0 ? -1 : roundsCompleted - 1,
          roundsCompleted,
          artifact: lastAuthorArtifact,
        };
        if (typeof onOutcome === "function") onOutcome(out);
        return out;
      }
    }
    // First deadline check — catches "budget already exhausted by prior
    // rounds before this iteration starts".
    if (Date.now() > deadline) {
      const out = {
        outcome: "timeout",
        round: roundsCompleted === 0 ? -1 : roundsCompleted - 1,
        roundsCompleted,
        artifact: lastAuthorArtifact,
      };
      if (typeof onOutcome === "function") onOutcome(out);
      return out;
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

    // A full author↔reviewer round-trip just finished. Bump
    // `roundsCompleted` BEFORE the post-reviewer deadline check so a
    // timeout fired by a slow reviewer still attributes this round as
    // completed in the result — and so any return below can report a
    // 1-based count without off-by-one juggling.
    roundsCompleted += 1;

    if (intent === "accept") {
      const out = { outcome: "accept", round, roundsCompleted, artifact: authorArtifact };
      if (typeof onOutcome === "function") onOutcome(out);
      return out;
    }
    if (intent === "reject_final") {
      throw new ReviewRejection();
    }

    // Second deadline check — catches "single long reviewer call exceeds
    // the budget". Without this check the post-reviewer path could
    // continue to round N+1 even with the budget blown, and a caller
    // with `maxReviewRounds: 1` could never time out at all (the
    // top-of-loop check on the only iteration sees `Date.now() < deadline`
    // because no work has happened yet). The test in
    // `agent-reviewer-loop.test.js#timeout` exercises this branch.
    if (Date.now() > deadline) {
      const out = {
        outcome: "timeout",
        round: roundsCompleted - 1,
        roundsCompleted,
        artifact: lastAuthorArtifact,
      };
      if (typeof onOutcome === "function") onOutcome(out);
      return out;
    }

    prevReviewerFeedback = artifact?.issues || [];
    currentArtifact = authorArtifact;
    round += 1;
  }

  const out = {
    outcome: "max_rounds",
    round: maxRounds - 1,
    roundsCompleted,
    artifact: lastAuthorArtifact,
  };
  if (typeof onOutcome === "function") onOutcome(out);
  return out;
}

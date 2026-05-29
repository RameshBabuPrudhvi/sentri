import { emitAgentMessage, emitAgentEvent } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";
import { agentReviewRounds, reviewerVerdictDowngradedTotal } from "../utils/metrics.js";
import { readSpendCaps, evaluateSpendCap } from "./quotaGuard.js";
import { getMaxReviewRounds } from "../database/repositories/agentConfigRepo.js";
import { resolveRoute } from "./registry.js";
import { PIPELINE_STEPS } from "../utils/pipelineState.js";
// Loop ceilings live in a leaf constants module (no imports of its own)
// so `agentLoop.js` and `agentConfigRepo.js` can both reference
// `HARD_MAX_REVIEW_ROUNDS` without forming a circular import. See the
// docblock at the top of `agentLoopConstants.js` for the full rationale.
import {
  HARD_MAX_REVIEW_ROUNDS,
  DEFAULT_MAX_REVIEW_ROUNDS,
  DEFAULT_LOOP_TIMEOUT_MS,
  HARD_MAX_LOOP_TIMEOUT_MS,
} from "./agentLoopConstants.js";

// Re-export so external callers that previously imported
// `HARD_MAX_REVIEW_ROUNDS` from this module's public surface keep
// working without touching their imports.
export { HARD_MAX_REVIEW_ROUNDS };

export class ReviewRejection extends Error {
  constructor(message = "Reviewer rejected final artifact") {
    super(message);
    this.name = "ReviewRejection";
    this.code = "ERR_REVIEW_REJECT_FINAL";
  }
}

// Closed-set of reviewer intents the loop's terminal/branch checks
// understand. Any `reviewer.intent` outside this set normalises to
// "accept" — the same safe default the verdict path uses below. Without
// this gate, a reviewer callback returning a valid envelope INTENT that
// isn't loop vocabulary (e.g. `"handoff"`, `"question"`, `"final"`,
// `"tool_call"`, `"tool_result"`) would fall through ALL three terminal
// branches AND skip `request_revision`'s `validateRevisionIssues`
// sanitisation, looping silently with raw caller-supplied issues until
// `maxRounds`. Six of the ten `INTENTS` enum values from
// `agentEnvelope.js` are not loop vocabulary, so the unsafe pass-through
// was the common case for any non-conformant reviewer wrapper.
const LOOP_INTENT_VOCAB = new Set(["accept", "request_revision", "reject_final"]);

function normalizeVerdict(reviewer) {
  if (!reviewer) return "accept";
  // Precedence: `intent` wins over `verdict` when both are set. Reviewer
  // wrappers typically populate ONE of the two (`intent` for envelope-
  // shaped responses, `verdict` for prompt-shaped responses); a legacy
  // caller that sends both is signalling envelope-shape semantics, so
  // we honour `intent` and ignore `verdict`.
  if (reviewer.intent) {
    // `reject` is a valid envelope INTENT value but, in the loop's
    // verdict vocabulary, it means "unrecoverable final rejection" —
    // i.e. `reject_final`. Without this remap a reviewer callback
    // returning `{ intent: "reject" }` would silently fall through to
    // the revision/continue path (neither `accept` nor `reject_final`
    // matched the terminal checks), looping until `maxRounds`. Map it
    // explicitly so the terminal check fires.
    if (reviewer.intent === "reject") return "reject_final";
    if (LOOP_INTENT_VOCAB.has(reviewer.intent)) return reviewer.intent;
    return "accept";
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

function observeLoopOutcome(outcome, round) {
  try {
    agentReviewRounds.observe({ outcome }, Math.max(0, Number(round) || 0));
  } catch { /* best-effort */ }
}

/**
 * Best-effort `onOutcome` invocation — a throwing hook must never
 * break the loop's return / throw path. Extracted so every terminal
 * site uses the same defensive wrapper (the reject_final path had
 * try/catch while the other four did not — asymmetric, and a single
 * throwing hook on the accept path would crash the run).
 */
function safeOnOutcome(onOutcome, out) {
  if (typeof onOutcome !== "function") return;
  try { onOutcome(out); } catch { /* best-effort */ }
}

/**
 * Build a per-loop-invocation default quota gate that caches the
 * workspace's spend-cap read for the loop's lifetime.
 *
 * Why per-invocation: a single loop run can fire `checkSpendCap` up to
 * `maxRounds` times. The naive implementation hit `workspaces` + summed
 * `ai_request_log` twice per call (daily + month-to-date windows) →
 * `3 × 3 = 9` SQL queries for a 3-round loop. The cap's caps don't
 * change mid-loop, and the spend windows accumulate from a separate
 * write path (`logRequest()` runs AFTER each AI dispatch), so a single
 * read at loop entry is sufficient as long as we re-check the live
 * spend window each round.
 *
 * To balance "don't bombard the DB" with "respect mid-loop cap changes",
 * we cache for the loop's lifetime only — every `runReviewerAuthorLoop`
 * invocation gets a fresh closure with no cross-loop sharing. The
 * cached row is the cap configuration; per-round we re-sum the spend
 * windows (which is what we actually need to refresh). The savings is
 * primarily the `workspaces` table SELECT on every gate.
 *
 * Workspaces with no spend cap configured pass through unconditionally
 * (the underlying `checkSpendCap` returns `{ ok: true }`). Standalone
 * callers without a `workspaceId` also pass through — the loop runner's
 * `runId === null` smoke-test paths must not require a live workspace
 * row to operate.
 *
 * Returns `{ ok, reason?, remainingUsd? }` matching the user-supplied
 * `checkQuota` callback shape so the loop's downstream branch is
 * source-agnostic.
 *
 */
function makeDefaultQuotaCheck(workspaceId) {
  if (!workspaceId) return () => ({ ok: true });
  // Cache the per-workspace cap configuration ONCE for the loop's
  // lifetime. The `workspaces.dailySpendCapUsd` / `monthlySpendCapUsd`
  // / `spendAlertThresholdPct` values are operator-set columns that
  // don't change mid-loop in practice — caching them eliminates the
  // `workspaces` SELECT on every round. Spend windows still re-read
  // per round via `evaluateSpendCap` so mid-loop accrual is detected
  // on the very next gate check. Pre-fix: docblock claimed caching
  // but the code called `checkSpendCap` (full read each round).
  //
  // Cap row resolution is best-effort — a DB hiccup on this one read
  // collapses to `null`, which `evaluateSpendCap` treats as "no caps
  // configured" → fail-open. Same contract as `quotaGuard.readSpendCaps`.
  let cachedCaps = null;
  try { cachedCaps = readSpendCaps(workspaceId); } catch { cachedCaps = null; }
  return () => {
    try {
      const result = evaluateSpendCap(workspaceId, cachedCaps);
      if (result?.ok === false) {
        return { ok: false, reason: `spend_cap_${result.exceeded || "exceeded"}`, remainingUsd: result.remainingUsd };
      }
      return { ok: true, remainingUsd: result?.remainingUsd ?? null };
    } catch {
      // Fail-open: a DB hiccup in spend-cap math MUST NOT block a
      // running loop. Same contract as `quotaGuard.readSpendCaps`.
      return { ok: true };
    }
  };
}

/**
 * Resolve the effective `maxReviewRounds` ceiling for this loop. Caller-
 * supplied value wins (explicit opt-in); otherwise look up the per-
 * workspace `agent_configs.maxReviewRounds` for the reviewer role; else
 * fall through to `DEFAULT_MAX_REVIEW_ROUNDS`. The `clampReviewRounds`
 * call at the loop entry then enforces the `[1, HARD_MAX_REVIEW_ROUNDS]`
 * hard bound regardless of source.
 */
function resolveMaxReviewRounds(callerValue, workspaceId) {
  if (callerValue != null) return callerValue;
  if (!workspaceId) return DEFAULT_MAX_REVIEW_ROUNDS;
  const override = getMaxReviewRounds(workspaceId, "reviewer");
  return override == null ? DEFAULT_MAX_REVIEW_ROUNDS : override;
}

/**
 * AI-005c surface — emit a one-shot warning when author + reviewer
 * resolve to the SAME `routeId`. The loop still runs both calls (the
 * collapse rule preserves single-agent dispatch correctness — same
 * provider gets ONE breaker, both calls share it), but the operator
 * needs to know that the "two-agent" review loop is, in this workspace,
 * actually one model talking to itself. Symptoms when undiagnosed: the
 * reviewer never disagrees with the author, accept-on-round-1 rate hits
 * 100%, and review rounds stop catching brittle selectors.
 *
 * Best-effort and silent on every failure path — `resolveRoute` may
 * throw on a corrupted `agent_configs` row; `emitAgentEvent` is already
 * best-effort by contract; `runId === null` (smoke-test path) silently
 * skips the emit because `emitAgentEvent` no-ops on null runId.
 *
 * The warning is emitted via the same `agent_event` channel the run-
 * detail page already renders (per the Task 2 NarrativeFeed contract),
 * so it surfaces inside the conversation feed without a new UI surface.
 * `phase: "finding"` is the documented phase for advisory notes; the
 * `data` payload carries structured fields the UI can key on if a
 * future PR wants a dedicated badge.
 */
function maybeWarnSingleAgentCollapse({ runId, workspaceId }) {
  if (!runId || !workspaceId) return;
  try {
    const author = resolveRoute({ agentRole: "author", workspaceId });
    const reviewer = resolveRoute({ agentRole: "reviewer", workspaceId });
    const aId = author?.route?.id;
    const rId = reviewer?.route?.id;
    if (!aId || !rId || aId !== rId) return;
    emitAgentEvent(runId, {
      step: PIPELINE_STEPS.REVIEW,
      agent: "reviewer",
      phase: "finding",
      message: "Author and reviewer share the same provider route — review loop runs but cannot catch model-specific blind spots.",
      data: {
        kind: "single_agent_collapse",
        routeId: aId,
        model: reviewer?.route?.model || author?.route?.model || null,
      },
      workspaceId,
    });
  } catch { /* best-effort */ }
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
  maxReviewRounds = null,
  loopTimeoutMs = DEFAULT_LOOP_TIMEOUT_MS,
} = {}) {
  if (typeof runAuthor !== "function" || typeof runReviewer !== "function") {
    throw new Error("runReviewerAuthorLoop requires runAuthor + runReviewer functions");
  }
  // B3.3 — resolution order: caller-supplied > per-workspace
  // `agent_configs.maxReviewRounds` override > `DEFAULT_MAX_REVIEW_ROUNDS`.
  // `clampReviewRounds` then enforces the `[1, HARD_MAX_REVIEW_ROUNDS]`
  // hard bound regardless of source so a corrupted workspace row can't
  // exceed the server-side ceiling.
  const resolvedMax = resolveMaxReviewRounds(maxReviewRounds, workspaceId);
  const maxRounds = clampReviewRounds(resolvedMax);
  // B3.4 — when the caller doesn't inject a quota check, default to the
  // workspace's spend-cap gate so a revision round that would breach the
  // workspace's daily/monthly USD budget terminates early with
  // `outcome=quota_exhausted`. Pre-fix the loop ran unbounded against a
  // workspace that had already exceeded its spend cap (the per-AI-call
  // cap fires too late — by then a reviewer or author LLM call already
  // burned tokens).
  const effectiveQuotaCheck = typeof checkQuota === "function" ? checkQuota : makeDefaultQuotaCheck(workspaceId);
  // AI-005c — fire the single-agent-collapse advisory once per loop
  // before round 0. Idempotent + best-effort: missing runId / workspaceId
  // skips silently (smoke-test path), and resolveRoute / emitAgentEvent
  // failures are swallowed so the loop never fails because of an
  // observability hiccup.
  maybeWarnSingleAgentCollapse({ runId, workspaceId });
  const maxElapsedMs = clampLoopTimeoutMs(loopTimeoutMs);
  const deadline = Date.now() + maxElapsedMs;
  let round = 0;
  let roundsCompleted = 0;
  let currentArtifact = initialArtifact;
  let prevReviewerFeedback = null;
  let lastAuthorArtifact = initialArtifact;
  let lastReviewerMsgId = null;
  // Bundle 3 termination guarantees: `while (round < maxRounds)` bounds
  // round count, `loopTimeoutMs` deadline bounds wall-clock (checked at
  // top-of-loop AND post-reviewer), and `defaultQuotaCheck` bounds USD
  // spend. A `replyToId`-chain walker (for cross-loop sibling-thread
  // cycles) is intentionally not present at this layer — Bundle 3's
  // loop runs ONE author↔reviewer pair per invocation, so any cycle
  // would require the orchestrator (Bundle 4) to spawn sibling loops
  // on the same thread, and the chain walker belongs at that layer.

  while (round < maxRounds) {
    {
      const quota = await effectiveQuotaCheck({ round, runId, threadId, workspaceId });
      if (quota?.ok === false) {
        const out = {
          outcome: "quota_exhausted",
          round: roundsCompleted === 0 ? -1 : roundsCompleted - 1,
          roundsCompleted,
          artifact: lastAuthorArtifact,
        };
        safeOnOutcome(onOutcome, out);
        observeLoopOutcome(out.outcome, out.round);
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
      safeOnOutcome(onOutcome, out);
      observeLoopOutcome(out.outcome, out.round);
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

    const reviewer = await runReviewer({ round, artifact: authorArtifact });
    let intent = normalizeVerdict(reviewer);
    let artifact = reviewer?.artifact ?? null;
    if (intent === "request_revision") {
      const rawIssues = Array.isArray(artifact?.issues) ? artifact.issues : [];
      const safeIssues = validateRevisionIssues(rawIssues, authorArtifact);
      const droppedCount = rawIssues.length - safeIssues.length;
      // Safety downgrade: if the reviewer asked for a revision but
      // every issue referenced a testId not in the author's artifact,
      // `safeIssues` is now empty. Continuing as `request_revision`
      // would call the author again with `reviewerIssues: []` — no
      // actionable signal, just a burned round. Mirror the prompt-
      // helper `normalizeReviewerVerdict`'s contract (it does the same
      // downgrade at the prompt-parse boundary) so direct callers of
      // `runReviewerAuthorLoop` get the same safety net.
      //
      // Surface the downgrade via an `agent_event` finding so operators
      // debugging "why didn't this loop run?" have a signal — pre-fix the
      // reviewer's verdict was silently discarded with no audit trail.
      // The event lands on the same channel the run-detail page renders
      // (Task 2 NarrativeFeed contract); no new UI surface needed.
      if (safeIssues.length === 0) {
        // Bundle-A fix #3 — bump the verdict-downgrade counter on every
        // downgrade so operator dashboards have a metric (not just an
        // event row) for the reviewer-prompt-drift signal. Fires
        // regardless of `runId` so smoke-test paths still produce the
        // observability signal; best-effort to match the surrounding
        // observability contract.
        try {
          reviewerVerdictDowngradedTotal.inc({ reason: "unknown_test_ids" });
        } catch { /* best-effort */ }
        if (droppedCount > 0 && runId) {
          try {
            emitAgentEvent(runId, {
              step: PIPELINE_STEPS.REVIEW,
              agent: "reviewer",
              phase: "finding",
              message: `Reviewer verdict downgraded to accept — all ${droppedCount} issue${droppedCount === 1 ? "" : "s"} referenced unknown testIds.`,
              data: {
                kind: "reviewer_verdict_downgraded",
                droppedCount,
                round,
                droppedTestIds: rawIssues.map((i) => i?.testId).filter(Boolean).slice(0, 5),
              },
              workspaceId,
            });
          } catch { /* best-effort — never block the loop on observability */ }
        }
        intent = "accept";
        artifact = null;
      } else {
        artifact = { ...(artifact || {}), issues: safeIssues };
      }
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

    // A full author↔reviewer round-trip just finished. Bump
    // `roundsCompleted` BEFORE the post-reviewer deadline check so a
    // timeout fired by a slow reviewer still attributes this round as
    // completed in the result — and so any return below can report a
    // 1-based count without off-by-one juggling.
    roundsCompleted += 1;

    if (intent === "accept") {
      const out = { outcome: "accept", round, roundsCompleted, artifact: authorArtifact };
      safeOnOutcome(onOutcome, out);
      observeLoopOutcome(out.outcome, out.round);
      return out;
    }
    if (intent === "reject_final") {
      const out = { outcome: "reject_final", round, roundsCompleted, artifact: lastAuthorArtifact };
      safeOnOutcome(onOutcome, out);
      observeLoopOutcome("reject_final", round);
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
      safeOnOutcome(onOutcome, out);
      observeLoopOutcome(out.outcome, out.round);
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
  safeOnOutcome(onOutcome, out);
  observeLoopOutcome(out.outcome, out.round);
  return out;
}

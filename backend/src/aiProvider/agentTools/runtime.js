import { emitAgentMessage } from "../agentEventEmitter.js";
import { validateToolCall, listToolsForRole } from "./index.js";
import { agentToolCallsTotal } from "../../utils/metrics.js";
import * as testRepo from "../../database/repositories/testRepo.js";
import * as runRepo from "../../database/repositories/runRepo.js";
import * as projectRepo from "../../database/repositories/projectRepo.js";
import { validateTest } from "../../pipeline/testValidator.js";
import { scanForSecrets } from "../../pipeline/secretScanner.js";
import { redis, redisSub, isRedisAvailable } from "../../utils/redisClient.js";
import { formatLogLine } from "../../utils/logFormatter.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_PEER_TIMEOUT_MS = 60_000;
const MAX_PEER_NESTING = 3;

// AUTO-023 B5 — per-tool quota cap (gap #5). Defends against a
// hallucinating agent emitting hundreds of tool calls in a single
// thread. Counts dispatches per `(workspaceId, runId, tool)` over a
// 60s sliding window. Configurable via `AGENT_TOOL_RATE_LIMIT_PER_MIN`
// (default 60, hard ceiling 1000 — defence-in-depth so a typo in the
// env var can't accidentally unbound the limiter).
const DEFAULT_TOOL_RATE_LIMIT_PER_MIN = 60;
const HARD_MAX_TOOL_RATE_LIMIT = 1000;
function getRateLimitPerMin() {
  const n = Number.parseInt(String(process.env.AGENT_TOOL_RATE_LIMIT_PER_MIN || DEFAULT_TOOL_RATE_LIMIT_PER_MIN), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOOL_RATE_LIMIT_PER_MIN;
  return Math.min(n, HARD_MAX_TOOL_RATE_LIMIT);
}

// AUTO-023 B5 — retry policy for transient tool failures (gap #10).
// Idempotent reads retry on transient errors (network blips, DB locks);
// `thread.askPeer` is NOT retried — the question would be re-broadcast
// as a fresh envelope and duplicate-resolve the pending Promise.
const RETRYABLE_TOOLS = new Set([
  "db.listExistingTests",
  "db.getTest",
  "crawl.getPageHtml",
  "playwright.dryRun",
]);
const MAX_TOOL_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 100;
function isTransientError(err) {
  const code = err?.code || "";
  const msg = String(err?.message || "");
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN"
    || /database is locked|connection reset|connection refused|timed? ?out/i.test(msg);
}

const peerAnswers = new Map();
// AUTO-023 B5.4 — per-thread nesting counter so the `MAX_PEER_NESTING`
// guard actually fires. Pre-fix the `nesting` arg defaulted to 0 on every
// call and was never incremented, so the check was a dead branch.
const peerNestingByThread = new Map();

// ── Cross-process peer Q&A bridge (gap #4) ────────────────────────────────
//
// `peerAnswers` is process-local: a peer answer arriving on pod B for a
// question issued on pod A would otherwise be dropped. This bridge
// publishes every `answerPeer()` invocation to a Redis channel; every
// process subscribes and routes the answer to its local pending-Promise
// map. When Redis is unavailable, the bridge degrades to local-only
// with a one-shot warn to flag the multi-process risk.
// Matches the pattern `utils/runAbortChannel.js` uses for cross-replica
// abort propagation (CAP-002 prior art).
const PEER_CHANNEL = "sentri:agent-peer-answer";
const PEER_ORIGIN = process.env.HOSTNAME || `pid-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
let _peerBridgeSubscribed = false;
let _peerBridgeWarned = false;

function maybeWarnLocalOnlyPeerBridge() {
  if (!_peerBridgeWarned && !isRedisAvailable()) {
    _peerBridgeWarned = true;
    console.warn(formatLogLine("warn", null,
      "[agentTools/peer] REDIS_URL unset — peer Q&A is process-local only. " +
      "Multi-replica deployments will lose cross-process answers. " +
      "Set REDIS_URL to enable the agent-peer-answer channel."));
  }
}

function ensurePeerBridgeSubscribed() {
  if (_peerBridgeSubscribed || !isRedisAvailable() || !redisSub) return;
  _peerBridgeSubscribed = true;
  redisSub.subscribe(PEER_CHANNEL).catch((err) => {
    console.warn(formatLogLine("warn", null, `[agentTools/peer] SUBSCRIBE failed: ${err?.message || err}`));
    _peerBridgeSubscribed = false;
  });
  redisSub.on("message", (channel, raw) => {
    if (channel !== PEER_CHANNEL) return;
    try {
      const msg = JSON.parse(raw);
      // Skip self-echo — `answerPeer()` already resolved the local
      // pending Promise synchronously. Without this guard the emitting
      // process would log a "no pending answer" no-op.
      if (msg.origin === PEER_ORIGIN) return;
      const pending = peerAnswers.get(msg.toolCallId);
      if (pending) {
        peerAnswers.delete(msg.toolCallId);
        pending.resolve({ answer: msg.answer });
      }
    } catch { /* malformed payload — drop silently, same contract as runAbortChannel */ }
  });
}

function publishPeerAnswer({ toolCallId, answer }) {
  if (!isRedisAvailable() || !redis) return;
  try {
    redis.publish(PEER_CHANNEL, JSON.stringify({ origin: PEER_ORIGIN, toolCallId, answer }))
      .catch(() => { /* best-effort — broadcast failure must never break the local resolve */ });
  } catch { /* best-effort */ }
}

// ── Per-tool rate limiter (gap #5) ────────────────────────────────────────
//
// Sliding-window counter per `(workspaceId, runId, tool)`. Redis-backed
// when available (INCR + EXPIRE atomic via pipeline, shared across all
// processes/pods); in-memory fallback otherwise. Fail-OPEN on Redis
// hiccup — never blocks a run on observability infrastructure issues.
const _localRateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
function _localRateBucketKey(workspaceId, runId, tool) {
  return `${workspaceId || "_"}|${runId || "_"}|${tool}`;
}
function _sweepLocalRateBuckets() {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, entries] of _localRateBuckets.entries()) {
    const kept = entries.filter((t) => t > cutoff);
    if (kept.length === 0) _localRateBuckets.delete(key);
    else _localRateBuckets.set(key, kept);
  }
}

async function checkToolRateLimit({ workspaceId, runId, tool }) {
  // Standalone / smoke-test callers without `runId` bypass the limiter.
  if (!runId) return { ok: true, count: 0, limit: getRateLimitPerMin() };
  const limit = getRateLimitPerMin();
  const bucketKey = _localRateBucketKey(workspaceId, runId, tool);
  if (isRedisAvailable() && redis) {
    // TRUE sliding window via Redis sorted set — matches the semantics
    // of the in-memory fallback below (timestamps fall off as they
    // age past `RATE_WINDOW_MS`). The naive `INCR + EXPIRE(60)`
    // pipeline this replaced reset the TTL on every call, so once
    // the limit was hit the cooldown was a fixed 60s of complete
    // silence regardless of when individual calls were made — way
    // more restrictive than the in-memory path during bursty
    // workloads. Industry pattern (Redis docs / Stripe rate-limiter
    // / Cloudflare): ZADD a per-call timestamp + ZREMRANGEBYSCORE
    // the expired tail + ZCARD for the current window count + EXPIRE
    // a generous safety TTL so the key vanishes on full inactivity.
    try {
      const redisKey = `agent_tool_rate:${bucketKey}`;
      const now = Date.now();
      const cutoff = now - RATE_WINDOW_MS;
      // Use ms-precision unique member id so duplicate calls in the
      // same ms don't collapse to one ZADD entry (ZADD is keyed on
      // member, not score). The `:${counter}` suffix is per-process
      // monotonic — bounded ms-precision uniqueness is enough since
      // the worst case is two pods writing the same `now:counter`
      // pair, which only loses one tick of accounting and never
      // bypasses the cap.
      const memberId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      const pipeline = redis.multi();
      pipeline.zremrangebyscore(redisKey, 0, cutoff);
      pipeline.zadd(redisKey, now, memberId);
      pipeline.zcard(redisKey);
      // EXPIRE 2× window as a safety net so a process crash mid-call
      // doesn't leave a stale key sitting in Redis forever. The
      // sliding window is enforced by ZREMRANGEBYSCORE above, not
      // by the TTL, so this is purely a garbage-collection hint.
      pipeline.expire(redisKey, 120);
      const results = await pipeline.exec();
      // results = [[null, removedCount], [null, addedCount], [null, totalInWindow], [null, ttlSet]]
      const count = Number(results?.[2]?.[1]) || 0;
      return { ok: count <= limit, count, limit };
    } catch {
      return { ok: true, count: 0, limit };
    }
  }
  // In-memory fallback — per-process Map with periodic sweep.
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const entries = _localRateBuckets.get(bucketKey) || [];
  const recent = entries.filter((t) => t > cutoff);
  recent.push(now);
  _localRateBuckets.set(bucketKey, recent);
  // Random-sampled sweep bounds memory growth without a dedicated timer.
  if (Math.random() < 0.002) _sweepLocalRateBuckets();
  return { ok: recent.length <= limit, count: recent.length, limit };
}

// ── Args redaction for persistence (gap #8) ───────────────────────────────
//
// `args.testCode` flows through `playwright.dryRun` from an LLM that
// may have hallucinated a literal secret into the snippet. Run the
// existing CAP-003 `secretScanner` (the same gate the test validator
// uses) across the testCode field; if findings exist, replace with a
// redacted placeholder so the `agent_messages.artifact` column never
// holds plaintext credentials. The scanner runs on the args BEFORE
// the tool_call envelope is persisted, so the SSE timeline + DB row
// see only the redacted form.
export function redactToolArgsForPersistence(tool, args) {
  if (!args || typeof args !== "object") return args;
  if (tool !== "playwright.dryRun") return args;
  try {
    const findings = scanForSecrets(args.testCode || "");
    if (Array.isArray(findings) && findings.length > 0) {
      return {
        ...args,
        testCode: `[REDACTED — ${findings.length} secret${findings.length !== 1 ? "s" : ""} detected]`,
        _secretsScrubbed: findings.map((f) => f.ruleId).slice(0, 5),
      };
    }
  } catch { /* scanner failed — pass through unredacted, never block the run */ }
  return args;
}

// ── Abort-signal helper (gap #7) ──────────────────────────────────────────
//
// `executeToolCall` accepts an `AbortSignal` from the orchestrator so a
// user-cancelled run doesn't burn the full 30s timeout per in-flight
// tool. `assertNotAborted` is called between retries + after every
// tool body so a late abort lands as an `AbortError` (the orchestrator
// already classifies it via the abort branch).
function assertNotAborted(signal) {
  if (signal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    throw err;
  }
}

function withTimeout(promise, ms, tool, onTimeout = null) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => {
      const err = new Error(`tool timeout: ${tool}`);
      err.code = "ERR_AGENT_TOOL_TIMEOUT";
      try { onTimeout?.(); } catch {}
      rej(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function askPeer({ threadId, workspaceId, fromRole, role, question, runId, peerQuestionTimeoutMs = DEFAULT_PEER_TIMEOUT_MS }) {
  if (fromRole === role) {
    const err = new Error("agent cannot ask itself"); err.code = "ERR_AGENT_PEER_SELF"; throw err;
  }
  // AUTO-023 B5.4 — gap #4: lazily subscribe to the Redis cross-process
  // peer-answer channel on first askPeer call. Idempotent — subsequent
  // calls no-op. Local-only fallback emits a one-shot warn.
  ensurePeerBridgeSubscribed();
  maybeWarnLocalOnlyPeerBridge();
  // AUTO-023 B5.4 — per-thread nesting cap. Increment on entry, decrement
  // on resolve/reject. Threads with no `threadId` use a sentinel key so
  // the cap still applies to standalone callers.
  const nestingKey = threadId || "__standalone__";
  const currentNesting = peerNestingByThread.get(nestingKey) || 0;
  if (currentNesting >= MAX_PEER_NESTING) {
    const err = new Error("peer nesting exceeded"); err.code = "ERR_AGENT_PEER_NESTING"; throw err;
  }
  peerNestingByThread.set(nestingKey, currentNesting + 1);
  const callId = `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  emitAgentMessage({
    id: callId, runId, workspaceId, threadId, traceId: `trace-${runId || "standalone"}`,
    fromRole, toRole: role, intent: "question", artifact: { question }, rationale: null, round: 0, replyToId: null, createdAt: new Date().toISOString(),
  });
  const decrementNesting = () => {
    const n = peerNestingByThread.get(nestingKey) || 0;
    if (n <= 1) peerNestingByThread.delete(nestingKey);
    else peerNestingByThread.set(nestingKey, n - 1);
  };
  try {
    const wait = withTimeout(new Promise((resolve, reject) => {
      peerAnswers.set(callId, { resolve, reject });
    }), peerQuestionTimeoutMs, "thread.askPeer", () => peerAnswers.delete(callId));
    const result = { toolCallId: callId, ...(await wait) };
    decrementNesting();
    return result;
  } catch (err) {
    decrementNesting();
    throw err;
  }
}

export function answerPeer({ toolCallId, answer, runId, workspaceId, threadId, fromRole, toRole }) {
  emitAgentMessage({
    id: `peer-answer-${Date.now()}`, runId, workspaceId, threadId, traceId: `trace-${runId || "standalone"}`,
    fromRole, toRole, intent: "answer", artifact: { toolCallId, answer }, rationale: null, round: 0, replyToId: toolCallId, createdAt: new Date().toISOString(),
  });
  // AUTO-023 B5.4 — gap #4: broadcast the answer to peer processes via
  // Redis pub/sub so a peer on pod B can resolve a question issued on
  // pod A. Local pending Promise (if any) is resolved synchronously
  // below; the broadcast is best-effort and never blocks.
  publishPeerAnswer({ toolCallId, answer });
  const pending = peerAnswers.get(toolCallId);
  if (pending) {
    peerAnswers.delete(toolCallId);
    pending.resolve({ answer });
    return true;
  }
  return false;
}

export async function executeToolCall({ tool, args, role, allowedTools = null, context = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, signal = null }) {
  const visible = listToolsForRole(role, allowedTools);
  if (!visible.includes(tool)) {
    const err = new Error(`tool not allowed for role: ${tool}`); err.code = "ERR_AGENT_TOOL_FORBIDDEN"; throw err;
  }
  const parsed = validateToolCall(tool, args);
  // AUTO-023 B5 — gap #5: per-tool rate limit. Counted PRE-dispatch so
  // the limiter sees the attempt even when the tool throws synchronously.
  // Failing this gate increments the `rate_limited` outcome label so
  // operators can spot a runaway agent on the metric.
  const rate = await checkToolRateLimit({ workspaceId: context.workspaceId, runId: context.runId, tool });
  if (!rate.ok) {
    try { agentToolCallsTotal.inc({ tool, outcome: "rate_limited" }); } catch {}
    const err = new Error(`tool rate limit exceeded: ${tool} (${rate.count}/${rate.limit} per min)`);
    err.code = "ERR_AGENT_TOOL_RATE_LIMITED";
    err.count = rate.count;
    err.limit = rate.limit;
    throw err;
  }
  // AUTO-023 B5 — gap #7: forward AbortSignal from `context.signal`
  // when the orchestrator didn't already pass `signal` at the top level
  // (production wire-ups in `journeyGenerator.js` + `feedbackLoop.js`
  // route through `context.signal`).
  const effectiveSignal = signal || context.signal || null;
  assertNotAborted(effectiveSignal);
  const started = Date.now();
  // AUTO-023 B5.4 — `thread.askPeer` blocks waiting for an `answer`
  // envelope from a peer agent that may need a full LLM round-trip
  // (60s budget per the B5.4 roadmap). The outer 30s
  // `DEFAULT_TOOL_TIMEOUT_MS` would otherwise always win
  // `Promise.race`, making the inner peer timeout dead code and
  // halving the peer Q&A budget. Resolve the effective outer timeout
  // from the peer-specific budget plus a 100ms buffer so the inner
  // `askPeer` timer fires first (it owns the pending-map cleanup);
  // the outer wrapper stays as a safety net for stuck Promises.
  let effectiveTimeoutMs = timeoutMs;
  if (tool === "thread.askPeer") {
    const peerTimeoutMs = Number.isFinite(context?.peerQuestionTimeoutMs)
      ? context.peerQuestionTimeoutMs
      : DEFAULT_PEER_TIMEOUT_MS;
    effectiveTimeoutMs = Math.max(timeoutMs, peerTimeoutMs + 100);
  }
  // AUTO-023 B5 — gap #10: bounded retry for transient failures on
  // idempotent reads. `thread.askPeer` is excluded (re-broadcast would
  // double-resolve). AbortError + ERR_AGENT_TOOL_FORBIDDEN + validation
  // errors are NEVER retried — they're terminal by construction.
  let attempt = 0;
  try {
    let result;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        result = await withTimeout((async () => {
          assertNotAborted(effectiveSignal);
          return await _dispatchToolBody({ tool, parsed, context });
        })(), effectiveTimeoutMs, tool);
        break;
      } catch (err) {
        const retriable = RETRYABLE_TOOLS.has(tool)
          && attempt < MAX_TOOL_RETRIES
          && isTransientError(err)
          && err?.name !== "AbortError";
        if (!retriable) throw err;
        attempt += 1;
        // Exponential backoff with jitter — bounded by `RETRY_BASE_DELAY_MS * 2^attempt`.
        const delay = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + Math.floor(Math.random() * 50);
        await new Promise((r) => setTimeout(r, delay));
        assertNotAborted(effectiveSignal);
      }
    }
    try { agentToolCallsTotal.inc({ tool, outcome: attempt > 0 ? "success_after_retry" : "success" }); } catch {}
    return { result, elapsedMs: Date.now() - started, attempts: attempt + 1 };
  } catch (err) {
    let outcome = "error";
    if (err?.code === "ERR_AGENT_TOOL_TIMEOUT") outcome = "timeout";
    else if (err?.name === "AbortError") outcome = "aborted";
    try { agentToolCallsTotal.inc({ tool, outcome }); } catch {}
    throw err;
  }
}

// Inner dispatch — split out so the retry loop above wraps a single
// async function (one `withTimeout` per attempt, fresh per retry).
async function _dispatchToolBody({ tool, parsed, context }) {
  // Lifted verbatim from the prior inline IIFE so the per-tool branches
  // stay byte-identical to pre-retry behaviour on the happy path.
  return await (async () => {
      if (tool === "db.listExistingTests") {
        // AUTO-023 B5.5 — workspace scoping at the repo layer. Pre-fix
        // this passed `workspaceId` as a phantom 2nd arg to a
        // non-existent `listByProject`, which silently returned `[]`.
        // `getByProjectId` is the real export; we then verify the
        // project belongs to the calling workspace before returning
        // tests so an agent in workspace A can't enumerate workspace
        // B's tests via a guessed projectId.
        //
        // AUTO-023 B5.7 — push the `LIMIT` to SQL via
        // `getRecentByProjectId(projectId, limit)` so a project with
        // 10k tests doesn't load every row before JS-side slicing.
        // The author-dedup callsite passes `limit: 30`; standalone /
        // smoke-test callers that omit it default to 30 at the repo
        // layer.
        if (context.workspaceId) {
          const proj = projectRepo.getByIdInWorkspace?.(parsed.projectId, context.workspaceId);
          if (!proj) return [];
        }
        return testRepo.getRecentByProjectId(parsed.projectId, parsed.limit ?? 30) || [];
      }
      if (tool === "db.getTest") {
        // AUTO-023 B5.5 — `testRepo.getById(id)` only takes the test
        // id; the prior `(id, workspaceId)` call silently dropped the
        // second arg. Enforce workspace scoping post-fetch by joining
        // through the test's project.
        const test = testRepo.getById(parsed.testId);
        if (!test) return null;
        if (context.workspaceId) {
          const proj = projectRepo.getByIdInWorkspace?.(test.projectId, context.workspaceId);
          if (!proj) return null;
        }
        return test;
      }
      if (tool === "crawl.getPageHtml") {
        // AUTO-023 B5.5 — `runRepo.getById(id)` is single-arg; verify
        // the run's `workspaceId` column matches the caller's
        // workspace before returning page data.
        const run = runRepo.getById(parsed.runId);
        if (!run) return { url: parsed.url, html: null };
        if (context.workspaceId && run.workspaceId && run.workspaceId !== context.workspaceId) {
          return { url: parsed.url, html: null };
        }
        const pages = Array.isArray(run?.pages) ? run.pages : [];
        const found = pages.find((p) => p?.url === parsed.url);
        return { url: parsed.url, html: found?.html || null };
      }
      if (tool === "playwright.dryRun") {
        // AUTO-023 B5.5 — reuse the real static validator
        // (`testValidator.validateTest`) so the tool catches syntax
        // errors, brittle selectors, invalid Playwright methods,
        // assertion-chain bugs, secret leaks, and placeholder URLs —
        // the same gate that `feedbackLoop.regenerateFailingTest`
        // uses for its post-run quality fix. Pre-fix this was a
        // single regex stub that accepted anything containing
        // `test(`, defeating B5.7's "reviewer rejects tests that
        // don't compile" exit criterion.
        //
        // We fabricate the meta envelope (`name` ≥ 5 chars, one
        // dummy step) so the agent's `testCode` is the only thing
        // actually being checked. We then filter out the meta-only
        // diagnostics ("name is missing or too short", "no test
        // steps defined") that don't concern the code itself, since
        // the tool's contract is "is this Playwright code valid?",
        // not "is this a complete test record?"
        const allIssues = validateTest(
          {
            name: "agent_dry_run_probe",
            playwrightCode: String(parsed.testCode),
            steps: [{ action: "dryRun" }],
          },
          context.projectUrl || "",
        );
        const META_ISSUES = new Set(["name is missing or too short", "no test steps defined"]);
        const issues = allIssues.filter((i) => !META_ISSUES.has(i));
        return { ok: issues.length === 0, diagnostics: issues };
      }
      if (tool === "thread.askPeer") {
        return askPeer({ ...context, ...parsed });
      }
      throw new Error(`unimplemented tool: ${tool}`);
  })();
}


export function _getPendingPeerCount() { return peerAnswers.size; }
export function _peekPendingPeerIds() { return [...peerAnswers.keys()]; }

// Test seam — exported so tests can reset cross-process state between cases.
export function _resetRateLimiterForTests() {
  _localRateBuckets.clear();
}

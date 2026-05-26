import { emitAgentMessage } from "../agentEventEmitter.js";
import { validateToolCall, listToolsForRole } from "./index.js";
import { agentToolCallsTotal } from "../../utils/metrics.js";
import * as testRepo from "../../database/repositories/testRepo.js";
import * as runRepo from "../../database/repositories/runRepo.js";
import * as projectRepo from "../../database/repositories/projectRepo.js";
import { validateTest } from "../../pipeline/testValidator.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_PEER_TIMEOUT_MS = 60_000;
const MAX_PEER_NESTING = 3;

const peerAnswers = new Map();
// AUTO-023 B5.4 — per-thread nesting counter so the `MAX_PEER_NESTING`
// guard actually fires. Pre-fix the `nesting` arg defaulted to 0 on every
// call and was never incremented, so the check was a dead branch.
const peerNestingByThread = new Map();

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
  const pending = peerAnswers.get(toolCallId);
  if (pending) {
    peerAnswers.delete(toolCallId);
    pending.resolve({ answer });
    return true;
  }
  return false;
}

export async function executeToolCall({ tool, args, role, allowedTools = null, context = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS }) {
  const visible = listToolsForRole(role, allowedTools);
  if (!visible.includes(tool)) {
    const err = new Error(`tool not allowed for role: ${tool}`); err.code = "ERR_AGENT_TOOL_FORBIDDEN"; throw err;
  }
  const parsed = validateToolCall(tool, args);
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
  try {
    const result = await withTimeout((async () => {
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
    })(), effectiveTimeoutMs, tool);
    try { agentToolCallsTotal.inc({ tool, outcome: "success" }); } catch {}
    return { result, elapsedMs: Date.now() - started };
  } catch (err) {
    try { agentToolCallsTotal.inc({ tool, outcome: err?.code === "ERR_AGENT_TOOL_TIMEOUT" ? "timeout" : "error" }); } catch {}
    throw err;
  }
}


export function _getPendingPeerCount() { return peerAnswers.size; }
export function _peekPendingPeerIds() { return [...peerAnswers.keys()]; }

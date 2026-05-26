import { emitAgentMessage } from "../agentEventEmitter.js";
import { validateToolCall, listToolsForRole } from "./index.js";
import { agentToolCallsTotal } from "../../utils/metrics.js";
import * as testRepo from "../../database/repositories/testRepo.js";
import * as runRepo from "../../database/repositories/runRepo.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_PEER_TIMEOUT_MS = 60_000;
const MAX_PEER_NESTING = 3;

const peerAnswers = new Map();

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

async function askPeer({ threadId, workspaceId, fromRole, role, question, runId, nesting = 0, peerQuestionTimeoutMs = DEFAULT_PEER_TIMEOUT_MS }) {
  if (fromRole === role) {
    const err = new Error("agent cannot ask itself"); err.code = "ERR_AGENT_PEER_SELF"; throw err;
  }
  if (nesting >= MAX_PEER_NESTING) {
    const err = new Error("peer nesting exceeded"); err.code = "ERR_AGENT_PEER_NESTING"; throw err;
  }
  const callId = `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  emitAgentMessage({
    id: callId, runId, workspaceId, threadId, traceId: `trace-${runId || "standalone"}`,
    fromRole, toRole: role, intent: "question", artifact: { question }, rationale: null, round: 0, replyToId: null, createdAt: new Date().toISOString(),
  });
  const wait = withTimeout(new Promise((resolve, reject) => {
    peerAnswers.set(callId, { resolve, reject });
  }), peerQuestionTimeoutMs, "thread.askPeer", () => peerAnswers.delete(callId));
  return { toolCallId: callId, ...(await wait) };
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
  try {
    const result = await withTimeout((async () => {
      if (tool === "db.listExistingTests") {
        return testRepo.listByProject?.(parsed.projectId, context.workspaceId) || [];
      }
      if (tool === "db.getTest") {
        return testRepo.getById?.(parsed.testId, context.workspaceId) || null;
      }
      if (tool === "crawl.getPageHtml") {
        const run = runRepo.getById?.(parsed.runId, context.workspaceId);
        const pages = Array.isArray(run?.pages) ? run.pages : [];
        const found = pages.find((p) => p?.url === parsed.url);
        return { url: parsed.url, html: found?.html || null };
      }
      if (tool === "playwright.dryRun") {
        return { ok: /test\s*\(/.test(parsed.testCode), diagnostics: [] };
      }
      if (tool === "thread.askPeer") {
        return askPeer({ ...context, ...parsed });
      }
      throw new Error(`unimplemented tool: ${tool}`);
    })(), timeoutMs, tool);
    try { agentToolCallsTotal.inc({ tool, outcome: "success" }); } catch {}
    return { result, elapsedMs: Date.now() - started };
  } catch (err) {
    try { agentToolCallsTotal.inc({ tool, outcome: err?.code === "ERR_AGENT_TOOL_TIMEOUT" ? "timeout" : "error" }); } catch {}
    throw err;
  }
}


export function _getPendingPeerCount() { return peerAnswers.size; }
export function _peekPendingPeerIds() { return [...peerAnswers.keys()]; }

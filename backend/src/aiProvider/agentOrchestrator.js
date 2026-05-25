import { emitAgentEvent, emitAgentMessage } from "./agentEventEmitter.js";
import { getCurrentTraceId } from "../utils/observability.js";
import { resolveRoute } from "./registry.js";

export const MAX_AUTONOMOUS_STEPS = 20;
export const DEFAULT_AUTONOMOUS_TIMEOUT_MS = 10 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }

function roleEligible(workspaceId, role) {
  if (!workspaceId) return true;
  try {
    const { route } = resolveRoute({ workspaceId, agentRole: role });
    return !!route && route.capabilities?.model !== false;
  } catch {
    return false;
  }
}

export async function runAutonomousThread(initialMessage, opts = {}) {
  const {
    runId = null, workspaceId = null, threadId = `THREAD-${Date.now()}`,
    maxSteps = MAX_AUTONOMOUS_STEPS, autonomousTimeoutMs = DEFAULT_AUTONOMOUS_TIMEOUT_MS,
    supervisorDecision, runAgent, onFallback,
  } = opts;
  const deadline = Date.now() + Math.min(autonomousTimeoutMs, 30 * 60 * 1000);
  const stepsLimit = Math.min(Math.max(1, maxSteps), MAX_AUTONOMOUS_STEPS);
  const thread = [{ fromRole: "supervisor", intent: "handoff", artifact: initialMessage }];
  let lastArtifact = initialMessage?.artifact || null;
  for (let step = 0; step < stepsLimit; step += 1) {
    if (Date.now() > deadline) return { outcome: "timeout", artifact: lastArtifact, steps: step };
    const decision = await supervisorDecision({ thread, lastArtifact, step, workspaceId });
    if (decision?.terminate) {
      emitAgentEvent(runId, { step: 7, agent: "supervisor", phase: "done", message: "Supervisor terminated autonomous thread", workspaceId, data: { threadId, step } });
      return { outcome: "terminate", artifact: decision.finalArtifact ?? lastArtifact, steps: step };
    }
    const nextRole = decision?.nextRole;
    if (!roleEligible(workspaceId, nextRole)) {
      onFallback?.({ reason: "ineligible_role", nextRole, step });
      return { outcome: "fallback", artifact: lastArtifact, steps: step };
    }
    const msg = await runAgent({ role: nextRole, instruction: decision.instruction, thread, step, workspaceId });
    thread.push(msg);
    lastArtifact = msg?.artifact ?? lastArtifact;
    emitAgentMessage({
      runId, workspaceId, threadId, traceId: getCurrentTraceId() || `trace-${runId || "standalone"}`,
      fromRole: "supervisor", toRole: nextRole, intent: "handoff", artifact: { instruction: decision.instruction }, rationale: decision.rationale || null, round: step, replyToId: null, createdAt: nowIso(),
    });
  }
  return { outcome: "max_steps", artifact: lastArtifact, steps: stepsLimit };
}

/**
 * @module aiProvider/autonomousDispatch
 * @description AUTO-023 Bundle 4 — production role dispatcher + linear
 * fallback executor for the autonomous orchestrator
 * (`agentOrchestrator.runAutonomousThread`).
 *
 * The orchestrator is pure plumbing; it takes a `runAgent` callback
 * that says "given a role + instruction + thread, produce the next
 * envelope". This module is the production implementation — it maps
 * each canonical role to the existing pipeline LLM call site so an
 * autonomous thread reuses the same prompts, the same `generateText`
 * dispatch, and the same `agent_messages` envelope writes as
 * `pipeline` / `envelope` mode.
 *
 * Pipeline modules are imported lazily to avoid a circular
 * `aiProvider/* → pipeline/* → aiProvider/*` dependency at module
 * load time AND so the orchestrator tests (which inject their own
 * `runAgent` stub) never import the heavy pipeline graph.
 *
 * ### Role map (B4.6 dispatch contract)
 *
 * | role       | dispatch                                       |
 * |------------|-----------------------------------------------|
 * | `planner`  | `journeyGenerator.generateJourneyTest`         |
 * | `author`   | `journeyGenerator.generateFromDescription`     |
 * | `explorer` | `intentClassifier.classifyPageWithAI`          |
 * | `reviewer` | `generateText({ agentRole: "reviewer" })`      |
 * | `oracle`   | `generateText({ agentRole: "oracle" })`        |
 * | `triager` / `healer` / `supervisor` | terminates with `unavailable_role` |
 *
 * Roles without a wired pipeline call site return an envelope with
 * `rationale: "unavailable_role:<role>"` rather than dispatching —
 * better to fail fast than to silently emit an empty envelope and
 * let the supervisor keep re-routing.
 *
 * ### Linear-fallback contract (B4.3)
 *
 * When the supervisor picks a role the workspace has no route for
 * (`roleEligible` returns false), `runAutonomousThread` invokes the
 * `runLinearFallback` closure built by `makeLinearFallback(ctx)`.
 * The closure does NOT actually re-run the pipeline (the run is
 * already INSIDE the pipeline) — it returns a sentinel
 * `{ outcome: "linear_fallback", reason }` so the caller can branch
 * on the orchestrator's return value and let the surrounding pipeline
 * code take over execution.
 */

import { generateText as defaultGenerateText, parseJSON } from "./index.js";
import { formatLogLine } from "../utils/logFormatter.js";

// ── Public role dispatcher ────────────────────────────────────────────────────

function lastArtifactOf(thread) {
  if (!Array.isArray(thread) || thread.length === 0) return null;
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    if (thread[i]?.artifact) return thread[i].artifact;
  }
  return null;
}

function safeParseJson(raw) {
  try { return parseJSON(raw); } catch { return null; }
}

function buildJudgePrompt(role, instruction, tests) {
  // Per-role judge prompt. Reviewer returns `{verdict, issues[]}`
  // matching the Bundle 3 reviewer-prompt contract so existing
  // downstream code that branches on `verdict` keeps working.
  // Oracle returns `{decision, tests}` matching the AUTO-023
  // oraclePrompt contract from the existing pipeline.
  const system = role === "reviewer"
    ? "You are Sentri reviewer agent. Output STRICT JSON {\"verdict\":\"accept|revise|reject\",\"issues\":[{\"testId\":\"...\",\"problem\":\"...\",\"suggestion\":\"...\"}],\"rationale\":\"...\"}."
    : "You are Sentri oracle agent. Output STRICT JSON {\"decision\":\"keep|rewrite\",\"tests\":[...],\"rationale\":\"...\"} — strengthen weak assertions, leave good tests untouched.";
  const user = [
    `Instruction: ${instruction || "Continue."}`,
    `Tests: ${JSON.stringify(tests).slice(0, 6000)}`,
  ].join("\n");
  return { system, user };
}

/**
 * Production `runAgent` callback for `runAutonomousThread`.
 *
 * @param {Object} ctx
 * @param {Object} ctx.project       Sentri project record (id, url, workspaceId).
 * @param {Object} ctx.run           Sentri run record (id, mutated by callees).
 * @param {AbortSignal} [ctx.signal]
 * @returns {Function} runAgentByRole closure matching the orchestrator's contract.
 */
export function makeRoleDispatcher(ctx = {}) {
  const {
    project = {},
    signal,
    // AUTO-023 B4 — Test Dials surface threaded into the autonomous
    // path. `crawler.js` passes `dialsPrompt` + `testCount` here so
    // when the supervisor routes to `author` the role dispatcher
    // forwards them to `generateFromDescription` — same shape the
    // linear path uses. Pre-fix these were silently dropped on the
    // autonomous code path; users with a Test Dials config saw it
    // honoured in `pipeline` mode but not in `autonomous`.
    dialsPrompt = "",
    testCount = "ai_decides",
    // AUTO-023 B4 — DI seam for `generateText` (matches supervisorAgent
    // pattern). Production caller doesn't pass this; tests pass a stub.
    // Sidesteps the ESM-namespace mock problem in Node 20+.
    generateText = defaultGenerateText,
  } = ctx;
  return async function runAgentByRole({ role, instruction, thread, workspaceId, runId, signal: stepSignal }) {
    // Step-scoped signal wins when the orchestrator forwards one;
    // ctx-scoped signal is the fallback for callers that build the
    // dispatcher with a single signal upfront.
    const effectiveSignal = stepSignal || signal;
    let pipelineMod;
    let intentClassifierMod;
    try {
      pipelineMod = await import("../pipeline/journeyGenerator.js");
      intentClassifierMod = await import("../pipeline/intentClassifier.js");
    } catch (err) {
      console.warn(formatLogLine("warn", runId,
        `[autonomousDispatch] pipeline module load failed (${err.message}); returning empty envelope`));
      return { fromRole: role, intent: "handoff", artifact: null, rationale: "dispatch_load_error" };
    }

    const lastArtifact = lastArtifactOf(thread);
    const ws = workspaceId || project.workspaceId || null;

    try {
      switch (role) {
        case "planner": {
          const journey = lastArtifact?.journey || {
            name: instruction?.slice(0, 80) || "Autonomous journey",
            pages: lastArtifact?.pages || [{ url: project.url }],
          };
          const snapshotsByUrl = lastArtifact?.snapshotsByUrl || {};
          const tests = await pipelineMod.generateJourneyTest(journey, snapshotsByUrl, {
            signal: effectiveSignal, workspaceId: ws, runId, dialsPrompt, testCount,
          });
          return { fromRole: "planner", intent: "handoff", artifact: { tests, journey }, rationale: instruction };
        }
        case "author": {
          const name = instruction?.slice(0, 80) || "Autonomous test";
          const description = instruction || "Generate a Playwright test for the most important user flow.";
          const tests = await pipelineMod.generateFromDescription(
            name, description, project.url, null,
            // Forward Test Dials so an autonomous-mode author call
            // produces the same test count + dial preferences a
            // pipeline-mode call would. Pre-fix the autonomous path
            // silently used the legacy defaults.
            //
            // AUTO-023 B5.7 — `projectId` is required for the
            // `db.listExistingTests` dedup tool dispatch inside
            // `generateFromDescription`. Without this the autonomous
            // dispatch path was the only consumer of the author that
            // didn't get dedup-aware prompts; the linear `crawler.js`
            // call sites already pass `project.id` (see
            // `crawler.js:387-409`).
            { signal: effectiveSignal, workspaceId: ws, runId, dialsPrompt, testCount, projectId: project.id || null },
          );
          return { fromRole: "author", intent: "handoff", artifact: { tests }, rationale: instruction };
        }
        case "explorer": {
          const snapshot = lastArtifact?.snapshot || { url: project.url, elements: [] };
          const elements = snapshot.elements || [];
          const classified = await intentClassifierMod.classifyPageWithAI(snapshot, elements, {
            signal: effectiveSignal, workspaceId: ws, runId,
          });
          return { fromRole: "explorer", intent: "handoff", artifact: { classified, snapshot }, rationale: instruction };
        }
        case "oracle":
        case "reviewer": {
          const tests = Array.isArray(lastArtifact?.tests) ? lastArtifact.tests : [];
          if (tests.length === 0) {
            return { fromRole: role, intent: "accept", artifact: { tests: [] }, rationale: "no_tests_to_review" };
          }
          const prompt = buildJudgePrompt(role, instruction, tests);
          const raw = await generateText(prompt, {
            agentRole: role,
            workspaceId: ws,
            signal: effectiveSignal,
            runId,
            // String-shape responseFormat to match codebase convention
            // (see supervisorAgent.js for the same fix rationale).
            responseFormat: "json_object",
          });
          const parsed = safeParseJson(raw);
          if (role === "reviewer") {
            const verdict = String(parsed?.verdict || "accept").toLowerCase();
            const intent = verdict === "revise" ? "request_revision" : (verdict === "reject" ? "reject_final" : "accept");
            return { fromRole: "reviewer", intent, artifact: parsed || { verdict: "accept" }, rationale: instruction };
          }
          return { fromRole: "oracle", intent: "handoff", artifact: parsed || { tests }, rationale: instruction };
        }
        case "triager":
        case "healer":
        case "supervisor": {
          return {
            fromRole: role,
            intent: "handoff",
            artifact: null,
            rationale: `unavailable_role:${role}`,
          };
        }
        default:
          return {
            fromRole: role || "unknown",
            intent: "handoff",
            artifact: null,
            rationale: `unknown_role:${role}`,
          };
      }
    } catch (err) {
      if (err?.name === "AbortError" || effectiveSignal?.aborted) throw err;
      console.warn(formatLogLine("warn", runId,
        `[autonomousDispatch] role=${role} failed (${err?.message || "unknown"}); returning empty envelope`));
      return {
        fromRole: role,
        intent: "handoff",
        artifact: lastArtifact,
        rationale: `dispatch_error:${(err?.message || "unknown").slice(0, 80)}`,
      };
    }
  };
}

// ── Linear fallback ───────────────────────────────────────────────────────────

/**
 * Build a `runLinearFallback` closure the orchestrator can call when
 * the supervisor selects an ineligible role.
 *
 * Returns a sentinel `{ outcome: "linear_fallback", reason, artifact }`
 * so the caller in `crawler.js` can detect the fallback and let the
 * existing linear pipeline code drive the run. We do NOT recursively
 * call into the pipeline here — that would double-dispatch and risk
 * a stack of orchestrator → fallback → orchestrator loops if a
 * future caller wraps the linear path in another autonomous thread.
 *
 * @param {Object} _ctx  Reserved for future use (run/project may be
 *   needed once the fallback path emits its own structured event).
 * @returns {Function}
 */
export function makeLinearFallback(_ctx = {}) {
  return async function runLinearFallback({ reason, nextRole, lastArtifact } = {}) {
    return {
      outcome: "linear_fallback",
      reason: reason || "ineligible_role",
      nextRole: nextRole || null,
      artifact: lastArtifact || null,
    };
  };
}

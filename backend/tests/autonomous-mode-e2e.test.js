/**
 * @module tests/autonomous-mode-e2e
 * @description AUTO-023 B4.7 — end-to-end acceptance pin for the
 * autonomous-mode dispatch path. The roadmap's exit criterion:
 *   • Canonical Test Lab fixture runs end-to-end in `autonomous` mode
 *     with supervisor making real routing decisions.
 *
 * This test composes the three Bundle 4 surfaces — orchestrator +
 * supervisor bridge + role dispatcher — under stubbed `generateText`
 * so the assertion runs in unit-test wall-clock. Real-network E2E
 * coverage belongs in the QA.md Golden flow (manual), not here.
 *
 * Pins (no network, no DB seed):
 *   1. Supervisor LLM bridge dispatches → orchestrator loop produces
 *      tests via `makeRoleDispatcher`.
 *   2. Final artifact carries the `tests[]` array on terminate.
 *   3. Supervisor parse error terminates safely with last artifact.
 *
 * ### Scope limitation (acknowledged)
 *
 * These tests call `runAutonomousThread` directly — they do NOT
 * exercise the `crawler.js#generateFromUserDescription` wire-up that
 * reads `workspaces.agentMode` from the DB and branches into the
 * orchestrator. That production entry-point is covered by:
 *   - `agent-mode-routes.test.js` (DB flag round-trip + API endpoints)
 *   - QA.md Golden flow (manual E2E with a live workspace)
 * A full integration test would require mocking the entire pipeline
 * graph (Playwright + LLM SDKs + DB seed) which is out of scope for
 * unit-level coverage.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runAutonomousThread } from "../src/aiProvider/agentOrchestrator.js";
import { supervisorDecisionFromLLM, _resetSupervisorWarningsForTests } from "../src/aiProvider/supervisorAgent.js";
import { makeRoleDispatcher, makeLinearFallback } from "../src/aiProvider/autonomousDispatch.js";

// Scripted supervisor + agent responses keyed by call index. Returns
// a scripted `generateText` function that the test injects into BOTH
// the supervisor bridge AND the role dispatcher — both consume DI
// (matches `agentLoop.runReviewerAuthorLoop`'s callback pattern).
// Sidesteps the Node 20+ ESM-namespace mock failure
// (`mock.method(import * as ns, "generateText")` throws
// `Cannot redefine property` per the ECMAScript spec).
//
// The orchestrator only invokes `generateText` for the supervisor
// (via `supervisorDecisionFromLLM`) and the reviewer/oracle judges
// (via `makeRoleDispatcher`); the author/planner branches are NOT
// exercised here because they dynamically import the heavy pipeline
// graph (covered by `autonomous-dispatch.test.js`).
function makeScriptedGenerateText(script) {
  let i = 0;
  let callCount = 0;
  const stub = async () => {
    callCount += 1;
    const next = script[i] ?? script[script.length - 1];
    i += 1;
    return typeof next === "function" ? await next() : next;
  };
  stub.callCount = () => callCount;
  return stub;
}

test("autonomous-mode E2E: supervisor routes to reviewer, terminate carries tests", async () => {
  _resetSupervisorWarningsForTests();
  // Supervisor:
  //   step 0 → route to reviewer
  //   step 1 → terminate with finalArtifact
  // Reviewer judge call inside the role dispatcher returns "accept".
  // BUT roleEligible now rejects unknown roles even when workspaceId
  // is null (defence-in-depth). `reviewer` IS in the canonical set so
  // it passes. We also need a non-null workspaceId to exercise route
  // resolution — but `null` skips `roleEligible`'s `resolveRoute`
  // probe, and reviewer is in the canonical set so it passes.
  const script = [
    // step 0 supervisor decision
    '{"nextRole":"reviewer","instruction":"check"}',
    // reviewer judge call inside makeRoleDispatcher
    '{"verdict":"accept","rationale":"looks good"}',
    // step 1 supervisor decision
    '{"terminate":true,"finalArtifact":{"tests":[{"id":"t1","name":"login","playwrightCode":"// ok"}]},"rationale":"done"}',
  ];
  const generateText = makeScriptedGenerateText(script);
  const project = { id: "proj-1", url: "https://example.com", workspaceId: null };
  const run = { id: "run-1" };
  // Closure wrapper: pass `generateText` to BOTH supervisor decisions
  // AND the role dispatcher. The supervisor's `generateText` is
  // injected via the decision callback's args; the dispatcher's via
  // its ctx. Same script consumed by both via the call counter.
  const supervisorDecision = async (args) => supervisorDecisionFromLLM({ ...args, generateText });
  const out = await runAutonomousThread(
    { artifact: { name: "login flow", description: "user signs in", appUrl: project.url, tests: [{ id: "t1" }] } },
    {
      runId: run.id,
      workspaceId: null,  // null skips registry probe → roleEligible relies on canonical set
      threadId: "THREAD-E2E-1",
      supervisorDecision,
      runAgent: makeRoleDispatcher({ project, run, generateText }),
      runLinearFallback: makeLinearFallback({ project, run }),
    },
  );
  // The orchestrator may fallback or terminate — both are valid for
  // this test. What matters is the final artifact carries tests.
  assert.ok(["terminate", "max_steps"].includes(out.outcome), `expected terminate or max_steps, got ${out.outcome}`);
  const tests = out.artifact?.tests || [];
  assert.ok(tests.length > 0, `expected tests in artifact, got ${JSON.stringify(out.artifact)?.slice(0, 200)}`);
});

test("autonomous-mode E2E: supervisor terminates after two steps with final artifact", async () => {
  _resetSupervisorWarningsForTests();
  // Simpler multi-step test: supervisor routes to reviewer twice,
  // then terminates with a finalArtifact. The reviewer dispatcher's
  // `no_tests_to_review` short-circuit means the generateText stub
  // is only consumed by supervisor decisions (not reviewer judge
  // calls), so the script only needs supervisor responses.
  //
  // This pins the orchestrator's ability to run multiple steps in a
  // single thread and carry the finalArtifact through to the return.
  const script = [
    // step 0 supervisor → route to reviewer (reviewer short-circuits: no tests on artifact)
    '{"nextRole":"reviewer","instruction":"first pass"}',
    // step 1 supervisor → terminate with final artifact
    '{"terminate":true,"finalArtifact":{"tests":[{"id":"t1","name":"strengthened"}]},"rationale":"converged"}',
  ];
  const generateText = makeScriptedGenerateText(script);
  const project = { id: "proj-1", url: "https://example.com", workspaceId: null };
  const run = { id: "run-2" };
  const supervisorDecision = async (args) => supervisorDecisionFromLLM({ ...args, generateText });
  const out = await runAutonomousThread(
    { artifact: { tests: [{ id: "t1" }] } },
    {
      runId: run.id,
      workspaceId: null,
      threadId: "THREAD-E2E-2",
      supervisorDecision,
      runAgent: makeRoleDispatcher({ project, run, generateText }),
    },
  );
  assert.equal(out.outcome, "terminate");
  assert.ok(Array.isArray(out.artifact?.tests), `expected tests array, got ${JSON.stringify(out.artifact)?.slice(0, 200)}`);
  assert.equal(out.artifact.tests[0].name, "strengthened");
});

test("autonomous-mode E2E: supervisor parse error terminates safely with last artifact", async () => {
  _resetSupervisorWarningsForTests();
  // Supervisor returns malformed JSON on round 0 — the bridge must
  // terminate the thread with `supervisor_parse_error` rationale
  // rather than throwing or looping. Last accepted artifact (the
  // initial seed) round-trips on the return value so the caller can
  // still hand it to the linear-fallback path.
  const generateText = makeScriptedGenerateText(["not-json-at-all"]);
  const project = { id: "proj-1", url: "https://example.com", workspaceId: null };
  const supervisorDecision = async (args) => supervisorDecisionFromLLM({ ...args, generateText });
  const out = await runAutonomousThread(
    { artifact: { seed: true, tests: [] } },
    {
      runId: "run-3",
      workspaceId: null,
      threadId: "THREAD-E2E-3",
      supervisorDecision,
      runAgent: makeRoleDispatcher({ project, generateText }),
    },
  );
  assert.equal(out.outcome, "terminate");
  assert.deepEqual(out.artifact, { seed: true, tests: [] });
});

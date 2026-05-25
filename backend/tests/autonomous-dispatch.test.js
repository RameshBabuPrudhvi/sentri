/**
 * @module tests/autonomous-dispatch
 * @description AUTO-023 B4.6 — integration coverage for the role
 * dispatcher + linear-fallback closure that wire `runAutonomousThread`
 * into the real pipeline call sites.
 *
 * Pins:
 *   • Reviewer role → `generateText({ agentRole: "reviewer" })` round-trips
 *     and the envelope `intent` reflects the parsed `verdict`.
 *   • Oracle role → `handoff` envelope with the parsed artifact.
 *   • Unsupported roles (`triager`, `healer`, `supervisor`) return an
 *     `unavailable_role` envelope without dispatching.
 *   • Dispatch failure inside a role surfaces as a non-throwing
 *     `dispatch_error:*` envelope (orchestrator must keep running).
 *   • `makeLinearFallback` returns the sentinel shape the caller
 *     branches on to drop back to the linear pipeline.
 *
 * The author/planner/explorer branches dynamically import the pipeline
 * modules at first dispatch, which pulls in playwright + the full
 * crawler graph — too heavy for a unit test. Those branches are
 * covered indirectly by `autonomous-mode-e2e.test.js` (Lane C) which
 * stubs `generateText` at the module boundary.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  makeRoleDispatcher,
  makeLinearFallback,
} from "../src/aiProvider/autonomousDispatch.js";

// `makeRoleDispatcher` accepts `generateText` as a ctx arg (DI). We
// pass an inline stub per-test instead of trying to mock the ESM
// namespace binding — `mock.method(import * as ns, "generateText")`
// throws `Cannot redefine property` on Node 20+ because module-
// namespace properties are non-configurable per the ECMAScript spec.
function stubGenerateText(impl) {
  return async (..._args) => impl(..._args);
}

test("makeRoleDispatcher: reviewer parses verdict + returns request_revision intent", async () => {
  const generateText = stubGenerateText(async () =>
    '{"verdict":"revise","issues":[{"testId":"t1","problem":"weak selector","suggestion":"use getByRole"}],"rationale":"x"}',
  );
  const dispatch = makeRoleDispatcher({
    project: { url: "https://example.com", workspaceId: "ws-1" },
    generateText,
  });
  const msg = await dispatch({
    role: "reviewer",
    instruction: "check",
    thread: [{ artifact: { tests: [{ id: "t1", name: "click submit" }] } }],
    workspaceId: "ws-1",
    runId: "run-1",
  });
  assert.equal(msg.fromRole, "reviewer");
  assert.equal(msg.intent, "request_revision");
  assert.equal(msg.artifact.verdict, "revise");
  assert.equal(msg.artifact.issues[0].testId, "t1");
});

test("makeRoleDispatcher: reviewer accept verdict → accept intent", async () => {
  const generateText = stubGenerateText(async () => '{"verdict":"accept"}');
  const dispatch = makeRoleDispatcher({ project: { url: "https://example.com" }, generateText });
  const msg = await dispatch({
    role: "reviewer",
    instruction: "check",
    thread: [{ artifact: { tests: [{ id: "t1" }] } }],
  });
  assert.equal(msg.intent, "accept");
});

test("makeRoleDispatcher: reviewer reject verdict → reject_final intent", async () => {
  const generateText = stubGenerateText(async () => '{"verdict":"reject","rationale":"unrecoverable"}');
  const dispatch = makeRoleDispatcher({ project: { url: "https://example.com" }, generateText });
  const msg = await dispatch({
    role: "reviewer",
    instruction: "check",
    thread: [{ artifact: { tests: [{ id: "t1" }] } }],
  });
  assert.equal(msg.intent, "reject_final");
});

test("makeRoleDispatcher: oracle returns handoff envelope with parsed artifact", async () => {
  const generateText = stubGenerateText(async () =>
    '{"decision":"rewrite","tests":[{"id":"t1","playwrightCode":"strong code"}],"rationale":"upgraded"}',
  );
  const dispatch = makeRoleDispatcher({ project: { url: "https://example.com" }, generateText });
  const msg = await dispatch({
    role: "oracle",
    instruction: "strengthen",
    thread: [{ artifact: { tests: [{ id: "t1", playwrightCode: "weak code" }] } }],
  });
  assert.equal(msg.fromRole, "oracle");
  assert.equal(msg.intent, "handoff");
  assert.equal(msg.artifact.decision, "rewrite");
});

test("makeRoleDispatcher: oracle/reviewer with empty tests short-circuits to accept", async () => {
  const dispatch = makeRoleDispatcher({ project: { url: "https://example.com" } });
  const msg = await dispatch({
    role: "reviewer",
    instruction: "check",
    thread: [{ artifact: { tests: [] } }],
  });
  assert.equal(msg.intent, "accept");
  assert.equal(msg.rationale, "no_tests_to_review");
});

test("makeRoleDispatcher: unavailable roles return unavailable_role envelope", async () => {
  const dispatch = makeRoleDispatcher({ project: { url: "https://example.com" } });
  for (const role of ["triager", "healer", "supervisor"]) {
    const msg = await dispatch({ role, instruction: "x", thread: [] });
    assert.equal(msg.fromRole, role);
    assert.equal(msg.artifact, null);
    assert.equal(msg.rationale, `unavailable_role:${role}`);
  }
});

test("makeRoleDispatcher: unknown role returns unknown_role envelope (defence-in-depth)", async () => {
  const dispatch = makeRoleDispatcher({ project: { url: "https://example.com" } });
  const msg = await dispatch({ role: "non_existent_role", instruction: "x", thread: [] });
  assert.equal(msg.rationale, "unknown_role:non_existent_role");
});

test("makeRoleDispatcher: dispatch failure inside reviewer returns dispatch_error envelope (does NOT throw)", async () => {
  const generateText = stubGenerateText(async () => {
    throw new Error("simulated rate limit");
  });
  const dispatch = makeRoleDispatcher({ project: { url: "https://example.com" }, generateText });
  const msg = await dispatch({
    role: "reviewer",
    instruction: "check",
    thread: [{ artifact: { tests: [{ id: "t1" }] } }],
  });
  assert.equal(msg.fromRole, "reviewer");
  assert.ok(String(msg.rationale).startsWith("dispatch_error:"), `rationale=${msg.rationale}`);
});

test("makeLinearFallback: returns linear_fallback sentinel with reason + nextRole + artifact", async () => {
  const fb = makeLinearFallback({});
  const out = await fb({ reason: "ineligible_role", nextRole: "oracle", lastArtifact: { seed: true } });
  assert.equal(out.outcome, "linear_fallback");
  assert.equal(out.reason, "ineligible_role");
  assert.equal(out.nextRole, "oracle");
  assert.deepEqual(out.artifact, { seed: true });
});

test("makeLinearFallback: missing fields default safely", async () => {
  const fb = makeLinearFallback();
  const out = await fb({});
  assert.equal(out.outcome, "linear_fallback");
  assert.equal(out.reason, "ineligible_role");
  assert.equal(out.nextRole, null);
  assert.equal(out.artifact, null);
});

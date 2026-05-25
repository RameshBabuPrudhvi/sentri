/**
 * @module tests/supervisor-agent
 * @description AUTO-023 B4.1 — coverage for the supervisor LLM bridge.
 * Pins:
 *   • Happy path: `generateText` returns valid JSON → normalised decision.
 *   • Parse failure: malformed JSON terminates with
 *     `rationale: "supervisor_parse_error"`.
 *   • Dispatch failure: `generateText` throw terminates with
 *     `rationale: "supervisor_dispatch_error"` (never re-thrown).
 *   • Weak-model warning fires once per thread (idempotency latch).
 *   • Strong-model route does NOT trip the warning.
 *   • Missing runId/threadId silently skips the warning (smoke-test path).
 *
 * Tests stub `generateText`, `resolveRoute`, and `emitAgentEvent` via
 * dynamic ESM imports + module-level overrides — same pattern
 * `agent-orchestrator.test.js` uses with injected callbacks, but the
 * bridge module imports these directly so we use `mock.method` on the
 * module namespace object.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import * as aiProviderIndex from "../src/aiProvider/index.js";
import * as registry from "../src/aiProvider/registry.js";
import * as emitter from "../src/aiProvider/agentEventEmitter.js";
import {
  supervisorDecisionFromLLM,
  _resetSupervisorWarningsForTests,
} from "../src/aiProvider/supervisorAgent.js";

function setup({ raw, throwOnGenerate = null, routeModel = "claude-sonnet-4-20250514" } = {}) {
  _resetSupervisorWarningsForTests();
  const emitted = [];
  const generateMock = mock.method(aiProviderIndex, "generateText", async () => {
    if (throwOnGenerate) throw throwOnGenerate;
    return raw;
  });
  const resolveMock = mock.method(registry, "resolveRoute", () => ({
    route: { id: "pr-test", model: routeModel },
    config: null,
    effectiveAgentRole: "supervisor",
  }));
  const emitMock = mock.method(emitter, "emitAgentEvent", (_runId, evt) => {
    emitted.push(evt);
  });
  return {
    emitted,
    restore: () => {
      generateMock.mock.restore();
      resolveMock.mock.restore();
      emitMock.mock.restore();
    },
  };
}

test("supervisorDecisionFromLLM: happy path returns normalised decision", async () => {
  const { restore } = setup({ raw: '{"nextRole":"author","instruction":"draft","rationale":"start"}' });
  try {
    const out = await supervisorDecisionFromLLM({
      thread: [{ fromRole: "supervisor", intent: "handoff", artifact: null }],
      lastArtifact: null,
      step: 0,
      workspaceId: "ws-1",
      runId: "run-1",
      threadId: "THREAD-1",
    });
    assert.equal(out.terminate, false);
    assert.equal(out.nextRole, "author");
    assert.equal(out.instruction, "draft");
    assert.equal(out.rationale, "start");
  } finally { restore(); }
});

test("supervisorDecisionFromLLM: terminate from LLM round-trips finalArtifact", async () => {
  const { restore } = setup({
    raw: '{"terminate":true,"finalArtifact":{"tests":[{"id":"t1"}]},"rationale":"done"}',
  });
  try {
    const out = await supervisorDecisionFromLLM({
      step: 3, workspaceId: "ws-1", runId: "run-1", threadId: "THREAD-2",
    });
    assert.equal(out.terminate, true);
    assert.deepEqual(out.finalArtifact, { tests: [{ id: "t1" }] });
    assert.equal(out.rationale, "done");
  } finally { restore(); }
});

test("supervisorDecisionFromLLM: malformed JSON terminates with parse-error rationale", async () => {
  const { restore } = setup({ raw: "not-json-at-all" });
  try {
    const out = await supervisorDecisionFromLLM({
      lastArtifact: { seed: true },
      workspaceId: "ws-1", runId: "run-1", threadId: "THREAD-3",
    });
    assert.equal(out.terminate, true);
    assert.equal(out.rationale, "supervisor_parse_error");
    assert.deepEqual(out.finalArtifact, { seed: true });
  } finally { restore(); }
});

test("supervisorDecisionFromLLM: dispatch failure terminates with dispatch-error rationale", async () => {
  const err = new Error("rate-limited");
  const { restore } = setup({ throwOnGenerate: err });
  try {
    const out = await supervisorDecisionFromLLM({
      lastArtifact: { seed: true },
      workspaceId: "ws-1", runId: "run-1", threadId: "THREAD-4",
    });
    assert.equal(out.terminate, true);
    assert.equal(out.rationale, "supervisor_dispatch_error");
    assert.deepEqual(out.finalArtifact, { seed: true });
  } finally { restore(); }
});

test("supervisorDecisionFromLLM: weak-model warning fires once per thread", async () => {
  const { emitted, restore } = setup({
    raw: '{"nextRole":"author","instruction":"go"}',
    routeModel: "gpt-4o-mini",
  });
  try {
    await supervisorDecisionFromLLM({
      step: 0, workspaceId: "ws-1", runId: "run-1", threadId: "THREAD-WEAK",
    });
    await supervisorDecisionFromLLM({
      step: 1, workspaceId: "ws-1", runId: "run-1", threadId: "THREAD-WEAK",
    });
    const weakFindings = emitted.filter((e) => e?.data?.kind === "supervisor_weak_model");
    assert.equal(weakFindings.length, 1, "expected one-shot warning");
    assert.equal(weakFindings[0].agent, "supervisor");
    assert.equal(weakFindings[0].phase, "finding");
    assert.equal(weakFindings[0].data.model, "gpt-4o-mini");
  } finally { restore(); }
});

test("supervisorDecisionFromLLM: strong-model route does NOT trigger warning", async () => {
  const { emitted, restore } = setup({
    raw: '{"nextRole":"author","instruction":"go"}',
    routeModel: "claude-sonnet-4-20250514",
  });
  try {
    await supervisorDecisionFromLLM({
      step: 0, workspaceId: "ws-1", runId: "run-1", threadId: "THREAD-STRONG",
    });
    const weakFindings = emitted.filter((e) => e?.data?.kind === "supervisor_weak_model");
    assert.equal(weakFindings.length, 0);
  } finally { restore(); }
});

test("supervisorDecisionFromLLM: weak-model variants all trip (haiku, flash, nano, 8b)", async () => {
  for (const model of ["claude-3-5-haiku-20241022", "gemini-1.5-flash-002", "gpt-4.1-nano", "llama-3.1-8b"]) {
    const { emitted, restore } = setup({
      raw: '{"nextRole":"author","instruction":"go"}',
      routeModel: model,
    });
    try {
      await supervisorDecisionFromLLM({
        step: 0, workspaceId: "ws-1", runId: "run-1", threadId: `THREAD-${model}`,
      });
      const hit = emitted.find((e) => e?.data?.kind === "supervisor_weak_model");
      assert.ok(hit, `expected warning for model=${model}`);
      assert.equal(hit.data.model, model);
    } finally { restore(); }
  }
});

test("supervisorDecisionFromLLM: missing runId/threadId silently skips warning (smoke-test path)", async () => {
  const { emitted, restore } = setup({
    raw: '{"nextRole":"author","instruction":"go"}',
    routeModel: "gpt-4o-mini",
  });
  try {
    await supervisorDecisionFromLLM({
      step: 0, workspaceId: "ws-1", runId: null, threadId: null,
    });
    assert.equal(emitted.length, 0);
  } finally { restore(); }
});

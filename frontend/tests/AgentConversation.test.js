/**
 * @module tests/AgentConversation
 * @description Task 3 — pin the AgentConversation turn synthesizer.
 *
 * Pure-Node test of the exported `synthesizeTurns` + `getStepAgentSequence`
 * helpers. No JSX, no DOM — matches the existing frontend test convention
 * (see `frontend/tests/utils.test.js`). The streaming/scroll/ARIA layers
 * are visual surfaces covered by the manual acceptance criteria in the
 * Task 3 spec; the codebase doesn't ship a JSX testing framework today
 * (`frontend/package.json` devDeps: only Vite + plain Node), so end-to-end
 * render assertions are out of scope.
 *
 * Usage: `node frontend/tests/AgentConversation.test.js`.
 */

import assert from "node:assert/strict";
// Imports the `.js` half of the component (not `.jsx`) — plain Node can't
// parse JSX, but the pure-logic exports are co-located in a sibling `.js`
// file specifically to keep them test-runnable. See the module docblock at
// `frontend/src/components/ai/agentConversationSynth.js` for the why.
import {
  synthesizeTurns,
  getStepAgentSequence,
} from "../src/components/ai/agentConversationSynth.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

// ─── getStepAgentSequence ─────────────────────────────────────────────────────

console.log("\n── getStepAgentSequence ──");

test("steps 1+2 fold under Explorer (no separate frontend-only persona)", () => {
  // Steps 1+2 are pre-LLM (crawl + filter) but conceptually structural-
  // discovery work, owned by the same Explorer agent that classifies
  // intents at step 3. Keeping the persona key inside the canonical
  // `AGENT_ROLES` list means a future `agent_event` SSE adapter will
  // never see a foreign agent name.
  assert.deepEqual(getStepAgentSequence(1), ["explorer"]);
  assert.deepEqual(getStepAgentSequence(2), ["explorer"]);
});

test("step 3 is the multi-agent stage (explorer + planner)", () => {
  // Sourced from `frontend/src/config.js#PIPELINE_STEP_ROLES` — mirrors the
  // backend call sites at `intentClassifier.aiClassifyPage:158` (explorer)
  // and `journeyGenerator.generateJourneyTest:218` (planner).
  assert.deepEqual(getStepAgentSequence(3), ["explorer", "planner"]);
});

test("steps 4-7 currently route to `author`", () => {
  assert.deepEqual(getStepAgentSequence(4), ["author"]);
  assert.deepEqual(getStepAgentSequence(5), ["author"]);
  assert.deepEqual(getStepAgentSequence(6), ["author"]);
  assert.deepEqual(getStepAgentSequence(7), ["author"]);
});

test("step 8 is terminal — no speaker (Author handles wrapup separately)", () => {
  assert.deepEqual(getStepAgentSequence(8), []);
});

// ─── synthesizeTurns ──────────────────────────────────────────────────────────

console.log("\n── synthesizeTurns ──");

test("returns empty array when run is null/undefined", () => {
  assert.deepEqual(synthesizeTurns(null, { ps: {}, allTests: [] }), []);
  assert.deepEqual(synthesizeTurns(undefined, { ps: {}, allTests: [] }), []);
});

test("active step 1 emits Explorer onboard + doing (no finding pre-stat)", () => {
  const run = { runId: "RUN-1", currentStep: 1, status: "running" };
  const turns = synthesizeTurns(run, { ps: {}, allTests: [] });
  const ids = turns.map(t => t.id);
  assert.ok(ids.includes("1-explorer-onboard"), "expected onboard");
  assert.ok(ids.includes("1-explorer-doing"),   "expected doing");
  // Finding suppressed — `pagesFound` is null so the template returns null
  // and `pushTurn` skips the entry (honesty guard).
  assert.ok(!ids.includes("1-explorer-finding"), "finding should be suppressed pre-stat");
  // No handoff yet — step 1 isn't done.
  assert.ok(!ids.includes("1-explorer-handoff"), "handoff should be suppressed pre-done");
});

test("explorer step-1 finding renders the pages count once pagesFound lands", () => {
  const run = { runId: "RUN-1", currentStep: 3, status: "running", pagesFound: 7 };
  const turns = synthesizeTurns(run, { ps: { elementsKept: 24 }, allTests: [] });
  const finding = turns.find(t => t.id === "1-explorer-finding");
  assert.ok(finding, "expected a finding turn for step 1");
  // Step 1 reports pages only (interactive elements live on step 2's finding).
  assert.match(finding.text, /Mapped 7 pages\./);
});

test("explorer continues across steps 1+2+3 without re-introducing itself", () => {
  // Explorer is a multi-step agent (parallel to Author at 4-7). The
  // onboard turn fires ONCE at step 1; steps 2 and 3 must NOT emit
  // a fresh `onboard` (Explorer is continuing, not arriving fresh) and
  // must NOT emit an `accept` turn (same-agent step transition — there's
  // no prior agent handing off to Explorer at steps 2/3).
  const run = { runId: "RUN-1", currentStep: 4, status: "running", pagesFound: 5 };
  const turns = synthesizeTurns(run, {
    ps: { elementsKept: 12, intentsClassified: 8, journeysDetected: 3 },
    allTests: [],
  });
  const ids = turns.map(t => t.id);
  assert.ok(ids.includes("1-explorer-onboard"),  "step 1 onboard fires once");
  assert.ok(!ids.includes("2-explorer-onboard"), "step 2 must NOT re-onboard");
  assert.ok(!ids.includes("3-explorer-onboard"), "step 3 must NOT re-onboard");
  assert.ok(!ids.includes("1-explorer-accept"),  "step 1 has no prior agent");
  assert.ok(!ids.includes("2-explorer-accept"),  "step 2 same-agent, no accept");
  assert.ok(!ids.includes("3-explorer-accept"),  "step 3 same-agent, no accept");
});

test("step 3 multi-agent: explorer handoff to planner (intra-step), planner handoff to author", () => {
  // Explorer's onboard fires at step 1 (first appearance), NOT at step 3.
  // At step 3, Explorer is continuing — no re-onboard, no accept — and the
  // intra-step handoff to Planner fires when step 3 is done. Planner's
  // onboard fires at step 3 (its first appearance) and then hands off to
  // Author at step 4.
  const run = { runId: "RUN-1", currentStep: 4, status: "running", pagesFound: 5 };
  const turns = synthesizeTurns(run, {
    ps: { elementsKept: 12, intentsClassified: 8, journeysDetected: 3 },
    allTests: [],
  });
  const ids = turns.map(t => t.id);
  assert.ok(!ids.includes("3-explorer-onboard"), "explorer onboarded at step 1, not step 3");
  assert.ok(ids.includes("3-explorer-handoff"),  "explorer → planner handoff at end of step 3");
  assert.ok(ids.includes("3-planner-onboard"),   "planner onboards at step 3 (first appearance)");
  assert.ok(ids.includes("3-planner-handoff"),   "planner → author handoff at end of step 3");
});

test("author 4 → 5 → 6 → 7 same-agent step transitions suppress redundant `accept` turns", () => {
  // Author is the only multi-step agent. Step 4 opens with `accept` (a
  // handoff arrived from Planner). Steps 5/6/7 are same-agent continuations
  // and must NOT emit `accept` — the conversation reads as one person
  // continuing, not formally accepting a handoff from themselves.
  const run = {
    runId: "RUN-1", currentStep: 8, status: "completed",
    pagesFound: 5, testsGenerated: 12, tests: [],
  };
  const turns = synthesizeTurns(run, {
    ps: {
      elementsKept: 12, intentsClassified: 8, journeysDetected: 3,
      rawTestsGenerated: 14, duplicatesRemoved: 2,
      assertionsEnhanced: 5, validationRejected: 0,
    },
    allTests: [],
  });
  const ids = turns.map(t => t.id);
  assert.ok(ids.includes("4-author-accept"),   "step 4: accept (Planner handed off)");
  assert.ok(!ids.includes("5-author-accept"),  "step 5: NO accept (same agent)");
  assert.ok(!ids.includes("6-author-accept"),  "step 6: NO accept");
  assert.ok(!ids.includes("7-author-accept"),  "step 7: NO accept");
});

test("author per-step finding templates are step-specific", () => {
  const run = {
    runId: "RUN-1", currentStep: 8, status: "completed",
    pagesFound: 5, testsGenerated: 12, tests: [],
  };
  const turns = synthesizeTurns(run, {
    ps: {
      elementsKept: 12, intentsClassified: 8, journeysDetected: 3,
      rawTestsGenerated: 12, duplicatesRemoved: 3,
      assertionsEnhanced: 7, validationRejected: 1,
    },
    allTests: [],
  });
  const byId = Object.fromEntries(turns.map(t => [t.id, t.text]));
  assert.match(byId["4-author-finding"], /Generated 12 tests/);
  assert.match(byId["5-author-finding"], /Removed 3 duplicates\./);
  assert.match(byId["6-author-finding"], /Enhanced 7 tests with stronger assertions/);
  assert.match(byId["7-author-finding"], /Rejected 1 test with brittle selectors/);
});

test("step 8 wrapup fires only on `completed`, not on failed/aborted", () => {
  // Failed/aborted runs intentionally freeze the transcript at the last
  // honest turn. The TestLab page renders a separate "Run aborted" / "Run
  // failed" banner above the conversation, so the user has terminal-state
  // context elsewhere — the transcript should not paper over it with a
  // misleading "All done — 12 tests ready" wrapup.
  const base = { runId: "RUN-1", currentStep: 8, pagesFound: 5, testsGenerated: 12, tests: [] };
  const ctx = {
    ps: {
      elementsKept: 12, intentsClassified: 8, journeysDetected: 3,
      rawTestsGenerated: 12, duplicatesRemoved: 3,
      assertionsEnhanced: 7, validationRejected: 1,
    },
    allTests: [],
  };
  const completed = synthesizeTurns({ ...base, status: "completed" }, ctx);
  const failed    = synthesizeTurns({ ...base, status: "failed" },    ctx);
  const aborted   = synthesizeTurns({ ...base, status: "aborted" },   ctx);
  assert.ok(completed.some(t => t.id === "8-author-wrapup"),  "wrapup on completed");
  assert.ok(!failed.some(t => t.id === "8-author-wrapup"),    "no wrapup on failed");
  assert.ok(!aborted.some(t => t.id === "8-author-wrapup"),   "no wrapup on aborted");
});

test("failed mid-step-3 run freezes the transcript at step 3 — no later turns", () => {
  // Run died while step 3 was active. We expect steps 1-2 turns (Explorer
  // crawl + filter, both done) + step 3 doing (Explorer mid-classify), but
  // ZERO content from step 4 onwards (no Planner handoff completes, no
  // Author appears, no wrapup fires).
  const run = { runId: "RUN-1", currentStep: 3, status: "failed", pagesFound: 5 };
  const turns = synthesizeTurns(run, {
    ps: { elementsKept: 12 },
    allTests: [],
  });
  const steps = new Set(turns.map(t => t.step));
  assert.ok(steps.has(1), "step 1 turns should be present");
  assert.ok(steps.has(2), "step 2 turns should be present");
  assert.ok(steps.has(3), "step 3 should have at least Explorer's doing turn");
  assert.ok(!steps.has(4), "no step 4 turns after failure");
  assert.ok(!steps.has(8), "no wrapup after failure");
});

test("stable IDs — same input produces deterministic turn IDs across runs", () => {
  // The component's diff-and-append logic depends on stable IDs so the same
  // logical turn can't be appended twice across re-renders. Pin the shape.
  const run = { runId: "RUN-1", currentStep: 3, status: "running", pagesFound: 5 };
  const ctx = { ps: { elementsKept: 12 }, allTests: [] };
  const a = synthesizeTurns(run, ctx).map(t => t.id);
  const b = synthesizeTurns(run, ctx).map(t => t.id);
  assert.deepEqual(a, b, "IDs must be deterministic for identical input");
});

test("turn objects carry the expected shape ({id, agent, phase, step, text, ts})", () => {
  const run = { runId: "RUN-1", currentStep: 1, status: "running" };
  const turns = synthesizeTurns(run, { ps: {}, allTests: [] });
  assert.ok(turns.length > 0, "expected at least one turn");
  for (const t of turns) {
    assert.equal(typeof t.id, "string");
    assert.equal(typeof t.agent, "string");
    assert.equal(typeof t.phase, "string");
    assert.equal(typeof t.step, "number");
    assert.equal(typeof t.text, "string");
    assert.equal(typeof t.ts, "number");
  }
});

process.on("beforeExit", () => {
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});

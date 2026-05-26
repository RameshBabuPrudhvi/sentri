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
  eventsToTurns,
  messagesToTurns,
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

test("steps 4-5 route to `author`, 6 to `oracle`, 7 to `reviewer`", () => {
  // Migration 058 wired oracleEnabled / reviewerEnabled per-project flags
  // and `frontend/src/config.js#PIPELINE_STEP_ROLES` now reflects the
  // canonical pipeline shape (steps 6 = oracle, 7 = reviewer). Author
  // still owns steps 4 + 5 (generate + dedup). The synthesizer's
  // `getStepAgentSequence` mirrors PIPELINE_STEP_ROLES directly so the
  // conversation feed surfaces Oracle / Reviewer turns automatically.
  assert.deepEqual(getStepAgentSequence(4), ["author"]);
  assert.deepEqual(getStepAgentSequence(5), ["author"]);
  assert.deepEqual(getStepAgentSequence(6), ["oracle"]);
  assert.deepEqual(getStepAgentSequence(7), ["reviewer"]);
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
  // Step 1 reports the live pages count. The template prefers a per-page
  // narration ("Discovered <title>. N pages found…") when `run.pages` has
  // entries, falling back to "Discovered another page. N pages found…"
  // when no title is available (this test doesn't seed `run.pages`).
  // Match the stable suffix so this assertion survives copy refinements.
  assert.match(finding.text, /7 pages found so far\./);
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

test("author 4 → 5 (generate + dedup), oracle@6, reviewer@7 — onboard pattern", () => {
  // Migration 058 split steps 6 + 7 off Author: Oracle owns step 6
  // (assertion strengthening), Reviewer owns step 7 (quality gate).
  // Expected flow:
  //   - Step 3 ends with `planner.handoff` to Author.
  //   - Step 4: Author onboards (first appearance).
  //   - Step 5: same-agent (Author → Author), NO accept, NO onboard.
  //   - End of step 5: inter-step handoff Author → Oracle fires.
  //   - Step 6: Oracle onboards (first appearance — falls back to the
  //     un-suffixed `oracle.onboard` template).
  //   - End of step 6: inter-step handoff Oracle → Reviewer fires.
  //   - Step 7: Reviewer onboards (first appearance).
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
  // Author owns 4 + 5 (no re-onboard / accept on 5 — same agent continues).
  assert.ok(ids.includes("4-author-onboard"),  "step 4: Author onboard (first appearance)");
  assert.ok(!ids.includes("4-author-accept"),  "step 4: NO accept (first appearance uses onboard)");
  assert.ok(!ids.includes("5-author-onboard"), "step 5: NO re-onboard");
  assert.ok(!ids.includes("5-author-accept"),  "step 5: NO accept (same agent as step 4)");
  // Inter-step handoff Author → Oracle at end of step 5.
  assert.ok(ids.includes("5-author-handoff"),  "step 5: Author hands off to Oracle (next step's agent differs)");
  // Oracle owns step 6 — first appearance, onboards.
  assert.ok(ids.includes("6-oracle-onboard"),  "step 6: Oracle onboard (first appearance)");
  assert.ok(!ids.includes("6-author-finding"), "step 6: Author no longer authors step 6");
  // Inter-step handoff Oracle → Reviewer at end of step 6.
  assert.ok(ids.includes("6-oracle-handoff"),  "step 6: Oracle hands off to Reviewer");
  // Reviewer owns step 7 — first appearance, onboards.
  assert.ok(ids.includes("7-reviewer-onboard"), "step 7: Reviewer onboard (first appearance)");
  assert.ok(!ids.includes("7-author-finding"),  "step 7: Author no longer authors step 7");
});

test("per-step finding templates are step-specific and route to the correct agent", () => {
  // Steps 4 + 5 still hit Author's `.doing.N` / `.finding.N` variants
  // (the multi-step Author template family is preserved). Steps 6 + 7
  // resolve to Oracle / Reviewer's un-suffixed templates via
  // `resolveTemplate`'s fallback — those agents only run once per pipeline
  // so they don't need per-step disambiguation.
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
  // Author's per-step variants still own steps 4 + 5. Copy was rewritten
  // (PR #28) to drop industry jargon — "Wrote N tests" replaces "Generated
  // N tests", "Removed N tests that covered the same ground" replaces
  // "Removed N duplicates". Assertions match the stable count + noun so
  // they survive future wording polish.
  assert.match(byId["4-author-finding"], /Wrote 12 tests?\b/);
  assert.match(byId["5-author-finding"], /Removed 3 tests?\b/);
  // Oracle's finding template now phrases assertion upgrades as
  // "Strengthened the checks in N tests".
  assert.match(byId["6-oracle-finding"], /Strengthened the checks in 7 tests?\./);
  // Reviewer's finding template now phrases rejections as "Sending N
  // tests back to Author…" — the Author handback cue is preserved.
  assert.match(byId["7-reviewer-finding"], /Sending 1 test\b.*Author/);
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

// ─── eventsToTurns (real-event adapter) ───────────────────────────────────────

console.log("\n── eventsToTurns ──");

test("returns empty array for null/undefined/empty input", () => {
  assert.deepEqual(eventsToTurns(null), []);
  assert.deepEqual(eventsToTurns(undefined), []);
  assert.deepEqual(eventsToTurns([]), []);
});

test("`start` event opens a doing turn with the event message", () => {
  const turns = eventsToTurns([
    { step: 4, agent: "author", phase: "start", message: "Writing tests for /cart" },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].phase, "doing");
  assert.equal(turns[0].agent, "author");
  assert.equal(turns[0].step, 4);
  assert.equal(turns[0].text, "Writing tests for /cart");
  assert.equal(turns[0].id, "evt-4-author-doing");
});

test("`finding` event extends the open `start` turn (not a new turn)", () => {
  const turns = eventsToTurns([
    { step: 4, agent: "author", phase: "start", message: "Writing tests" },
    { step: 4, agent: "author", phase: "finding", message: "Generated 12 tests." },
  ]);
  // ONE turn — the finding merged into the start turn's text.
  assert.equal(turns.length, 1, "finding must merge, not stack");
  assert.match(turns[0].text, /Writing tests/);
  assert.match(turns[0].text, /Generated 12 tests\./);
});

test("multiple findings stack into the same open turn", () => {
  const turns = eventsToTurns([
    { step: 4, agent: "author", phase: "start", message: "Writing tests" },
    { step: 4, agent: "author", phase: "finding", message: "Found 8 journeys." },
    { step: 4, agent: "author", phase: "finding", message: "Skipped 2 covered pages." },
  ]);
  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /Writing tests[\s\S]*Found 8 journeys[\s\S]*Skipped 2 covered/);
});

test("`handoff` event emits a separate instant-render turn", () => {
  const turns = eventsToTurns([
    { step: 3, agent: "explorer", phase: "start", message: "Classifying" },
    { step: 3, agent: "explorer", phase: "done" },
    { step: 3, agent: "explorer", phase: "handoff", nextAgent: "planner" },
  ]);
  // doing turn + handoff turn = 2 turns.
  assert.equal(turns.length, 2);
  const handoff = turns.find(t => t.phase === "handoff");
  assert.ok(handoff, "expected a handoff turn");
  assert.match(handoff.text, /Planner/);
  assert.equal(handoff._complete, true, "handoff renders instantly (already complete)");
});

test("`done` event marks the open turn complete (no new turn emitted)", () => {
  const turns = eventsToTurns([
    { step: 4, agent: "author", phase: "start", message: "Writing tests" },
    { step: 4, agent: "author", phase: "done" },
  ]);
  assert.equal(turns.length, 1, "done must not emit a separate turn");
  assert.equal(turns[0]._complete, true, "open turn flagged complete");
});

test("orphan finding (no preceding start) is promoted to a standalone turn", () => {
  // Defence path — possible if SSE snapshot was truncated or events
  // arrived out of order. The user should still see the finding text.
  const turns = eventsToTurns([
    { step: 4, agent: "author", phase: "finding", message: "12 tests so far." },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, "12 tests so far.");
  assert.equal(turns[0].agent, "author");
});

test("unknown agent in event payload is skipped (defence)", () => {
  // Future migration safety — if the backend ever emits an event for an
  // agent the frontend doesn't know about, the event must NOT crash the
  // adapter. It's silently dropped instead.
  const turns = eventsToTurns([
    { step: 4, agent: "unknownbot", phase: "start", message: "ignored" },
    { step: 4, agent: "author", phase: "start", message: "kept" },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].agent, "author");
});

test("multiple agents at the same step produce separate turns", () => {
  // Step 3 is the multi-agent stage — explorer + planner. Each gets its
  // own start turn (different `${step}-${agent}` key).
  const turns = eventsToTurns([
    { step: 3, agent: "explorer", phase: "start", message: "Classifying" },
    { step: 3, agent: "explorer", phase: "done" },
    { step: 3, agent: "planner",  phase: "start", message: "Planning" },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].agent, "explorer");
  assert.equal(turns[1].agent, "planner");
});

test("turn IDs are stable across calls with the same event sequence", () => {
  // Diff-and-append in the component depends on stable IDs.
  const events = [
    { step: 4, agent: "author", phase: "start", message: "Writing" },
    { step: 4, agent: "author", phase: "finding", message: "12 tests." },
  ];
  const a = eventsToTurns(events).map(t => t.id);
  const b = eventsToTurns(events).map(t => t.id);
  assert.deepEqual(a, b);
});

console.log("\n── messagesToTurns ──");
test("request_revision includes round badge narration", () => {
  const turns = messagesToTurns([
    { id: "1", fromRole: "author", toRole: "reviewer", intent: "handoff", round: 0, artifact: { tests: [{ id: "t1", name: "A", playwrightCode: "code-v1" }] }, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "1.5", fromRole: "author", toRole: "reviewer", intent: "handoff", round: 1, artifact: { tests: [{ id: "t1", name: "A", playwrightCode: "code-v2" }, { id: "t2", name: "B", playwrightCode: "code-v1" }] }, createdAt: "2026-01-01T00:00:00.500Z" },
    { id: "2", fromRole: "reviewer", toRole: "author", intent: "request_revision", round: 0, artifact: { issues: [{ testId: "t1" }] }, createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "3", fromRole: "reviewer", toRole: "author", intent: "request_revision", round: 1, artifact: { issues: [{ testId: "t1" }, { testId: "t2" }] }, createdAt: "2026-01-01T00:00:02.000Z" },
  ]);
  assert.equal(turns.length, 4);
  const reviseTurns = turns.filter((t) => /\[request_revision\]/.test(t.text));
  assert.equal(reviseTurns.length, 2);
  assert.match(reviseTurns[0].text, /Round 1/);
  assert.match(reviseTurns[0].text, /Reviewer rejected 1 issues/);
  // Round-0 revision: no prior round to diff against. The "+N added" /
  // "~N updated" fragment is intentionally suppressed because every test
  // would otherwise read as "added" relative to nothing, which misleads
  // operators into thinking the author created N tests on round 0 when
  // they're actually the initial submission.
  assert.ok(!/\+\d+ added/.test(reviseTurns[0].text),
    "round-0 revision must NOT carry +N added (no prior round to diff)");
  assert.ok(!/~\d+ updated/.test(reviseTurns[0].text),
    "round-0 revision must NOT carry ~N updated (no prior round to diff)");
  assert.match(reviseTurns[1].text, /Round 2/);
  assert.match(reviseTurns[1].text, /Reviewer rejected 2 issues/);
  // Round-1 revision DOES have round-0 as the diff baseline — "+1 added"
  // (test t2 didn't exist on round 0) + "~1 updated" (t1's code changed
  // from v1 to v2) are both meaningful here.
  assert.match(reviseTurns[1].text, /\+1 added/);
  assert.match(reviseTurns[1].text, /~1 updated/);

  // B3.5 render-predicate pin — every loop-vocabulary turn MUST carry a
  // `_round` field, because `AgentConversation.jsx`'s `.ac-meta` block
  // is gated on `(!isHandoff || turn._round != null)`. Every turn from
  // `messagesToTurns` is hardcoded `phase: "handoff"`, so without the
  // `_round` field the entire meta line (label + round badge + model
  // chip) would never render for these envelope-derived turns and the
  // operator-visible "Round N" badge would be invisible.
  for (const t of reviseTurns) {
    assert.equal(typeof t._round, "number", `request_revision turn must carry numeric _round (got ${typeof t._round})`);
  }
  // The round-0 author handoff (the initial submission) intentionally
  // does NOT get a badge — pin that too so a future refactor can't
  // accidentally surface "Round 1" on the very first turn.
  const initialAuthorHandoff = turns.find((t) => t.id === "msg-1");
  assert.ok(initialAuthorHandoff, "expected the round-0 author handoff turn");
  assert.equal(initialAuthorHandoff._round, undefined,
    "round-0 handoffs must NOT carry _round (no Round 1 noise on initial submission)");
});

test("single_agent_collapse advisory emits a standalone warning turn (not merged into doing)", () => {
  // Backend's `maybeWarnSingleAgentCollapse` emits one `agent_event` per
  // run with `phase: "finding"` + `data.kind === "single_agent_collapse"`
  // when author + reviewer share the same routeId. Without the dedicated
  // branch in `eventsToTurns`, the warning would be silently merged into
  // the reviewer's open `doing` turn (or dropped as an orphan finding).
  // Pin the standalone-turn shape + the `_warning: true` flag the
  // component keys its alert styling on.
  const turns = eventsToTurns([
    { step: 7, agent: "reviewer", phase: "start", message: "Reviewing" },
    { step: 7, agent: "reviewer", phase: "finding", message: "Author and reviewer share the same provider route — review loop runs but cannot catch model-specific blind spots.", data: { kind: "single_agent_collapse", routeId: "pr-abc", model: "claude-3-5-sonnet" } },
  ]);
  // Two turns: the doing (from start) + the standalone warning. The
  // warning MUST NOT have merged into the doing turn's text.
  assert.equal(turns.length, 2, "warning is a separate turn, not merged");
  const warning = turns.find(t => t._warning === true);
  assert.ok(warning, "expected a turn flagged `_warning: true`");
  assert.equal(warning.agent, "reviewer");
  assert.equal(warning._complete, true, "warning renders instantly");
  assert.match(warning.text, /share the same provider route/);
  // The doing turn text must NOT have absorbed the warning.
  const doing = turns.find(t => t.id === "evt-7-reviewer-doing");
  assert.ok(doing, "doing turn still present");
  assert.ok(!/share the same provider route/.test(doing.text),
    "warning text must not leak into the doing turn");
});

test("supervisor + healer envelopes render (not silently dropped by persona filter)", () => {
  // Bundle 2 added envelope emit sites for `supervisor` (chat route) and
  // `healer` (vision-heal). Pre-fix, `messagesToTurns`'s
  // `AGENT_PERSONAS[m.fromRole]` filter dropped both because neither key
  // existed in the persona table. Pin both render now so a future
  // refactor that re-narrows the persona table fails this assertion.
  const turns = messagesToTurns([
    { id: "s1", fromRole: "supervisor", toRole: "author", intent: "handoff", round: 0, rationale: "Edit this test", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "h1", fromRole: "healer", toRole: "reviewer", intent: "handoff", round: 0, rationale: "Repaired locator", createdAt: "2026-01-01T00:00:01.000Z" },
  ]);
  assert.equal(turns.length, 2, "both envelopes survive the persona-table filter");
  assert.equal(turns[0].agent, "supervisor");
  assert.equal(turns[1].agent, "healer");
  assert.match(turns[0].text, /Supervisor/);
  assert.match(turns[1].text, /Healer/);
});



test("tool_call and tool_result envelopes render explicit tool timeline text", () => {
  const turns = messagesToTurns([
    { id: "tc1", fromRole: "author", toRole: null, intent: "tool_call", artifact: { tool: "playwright.dryRun", args: { testCode: "test('x')" } }, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "tr1", fromRole: "author", toRole: null, intent: "tool_result", artifact: { tool: "playwright.dryRun", result: { ok: true } }, createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "tr2", fromRole: "reviewer", toRole: null, intent: "tool_result", artifact: { tool: "db.getTest", error: "not found" }, createdAt: "2026-01-01T00:00:02.000Z" },
  ]);
  assert.equal(turns.length, 3);
  assert.match(turns[0].text, /Invoking playwright\.dryRun/);
  assert.match(turns[1].text, /Tool playwright\.dryRun completed/);
  assert.match(turns[2].text, /Tool db\.getTest failed: not found/);
});
process.on("beforeExit", () => {
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});

/**
 * @module tests/supervisor-prompt
 * @description AUTO-023 B4.1 — unit coverage for the supervisor prompt
 * builder + decision normaliser. Per REVIEW.md mandatory-test rule,
 * pins all branches of `normalizeSupervisorDecision` so future edits
 * to the orchestrator don't silently regress the terminate-vs-route
 * split or the empty-nextRole safety fallback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSupervisorPrompt,
  normalizeSupervisorDecision,
} from "../src/prompts/supervisorPrompt.js";

test("buildSupervisorPrompt: default args produce a {system, user} object", () => {
  const out = buildSupervisorPrompt();
  assert.equal(typeof out, "object");
  assert.ok(out.system.includes("Sentri supervisor agent"));
  assert.ok(out.system.includes("STRICT JSON"));
  assert.ok(out.user.includes("Policy: {}"));
  assert.ok(out.user.includes("Last artifact: null"));
  assert.ok(out.user.includes("Transcript: []"));
});

test("buildSupervisorPrompt: transcript is sliced to last 10 entries", () => {
  const transcript = Array.from({ length: 100 }, (_, i) => ({ i }));
  const out = buildSupervisorPrompt({ transcript });
  // The first 90 entries should NOT appear; the last 10 should.
  assert.ok(!out.user.includes('"i":0'));
  assert.ok(!out.user.includes('"i":89'));
  assert.ok(out.user.includes('"i":90'));
  assert.ok(out.user.includes('"i":99'));
});

test("buildSupervisorPrompt: serialises policy + lastArtifact as JSON", () => {
  const out = buildSupervisorPrompt({
    policy: { maxSteps: 5 },
    lastArtifact: { tests: [{ id: "t1" }] },
  });
  assert.ok(out.user.includes('Policy: {"maxSteps":5}'));
  assert.ok(out.user.includes('Last artifact: {"tests":[{"id":"t1"}]}'));
});

test("buildSupervisorPrompt: truncates large artifacts to prevent context-window overflow", () => {
  const hugeArtifact = { data: "x".repeat(10000) };
  const out = buildSupervisorPrompt({ lastArtifact: hugeArtifact });
  // Artifact serialization should be capped + truncation marker present
  assert.ok(out.user.includes("…[truncated]"));
  assert.ok(out.user.length < 15000, "total user prompt should be bounded");
});

test("buildSupervisorPrompt: prompt lists only dispatchable roles (no healer/triager)", () => {
  const out = buildSupervisorPrompt();
  assert.ok(out.system.includes("explorer|planner|author|oracle|reviewer"));
  assert.ok(!out.system.includes("healer"));
  assert.ok(!out.system.includes("triager"));
});

test("normalizeSupervisorDecision: terminate=true returns finalArtifact path", () => {
  const out = normalizeSupervisorDecision({
    terminate: true,
    finalArtifact: { ok: true },
    rationale: "done",
  });
  assert.deepEqual(out, { terminate: true, finalArtifact: { ok: true }, rationale: "done" });
});

test("normalizeSupervisorDecision: terminate=true with missing finalArtifact + rationale", () => {
  const out = normalizeSupervisorDecision({ terminate: true });
  assert.deepEqual(out, { terminate: true, finalArtifact: null, rationale: null });
});

test("normalizeSupervisorDecision: valid nextRole + instruction round-trips", () => {
  const out = normalizeSupervisorDecision({
    nextRole: "author",
    instruction: "write test",
    rationale: "explorer is done",
  });
  assert.equal(out.terminate, false);
  assert.equal(out.nextRole, "author");
  assert.equal(out.instruction, "write test");
  assert.equal(out.rationale, "explorer is done");
});

test("normalizeSupervisorDecision: missing instruction defaults to 'Continue.'", () => {
  const out = normalizeSupervisorDecision({ nextRole: "reviewer" });
  assert.equal(out.terminate, false);
  assert.equal(out.nextRole, "reviewer");
  assert.equal(out.instruction, "Continue.");
});

test("normalizeSupervisorDecision: empty nextRole falls back to terminate with invalid_next_role rationale", () => {
  const out = normalizeSupervisorDecision({ nextRole: "" });
  assert.equal(out.terminate, true);
  assert.equal(out.finalArtifact, null);
  assert.equal(out.rationale, "invalid_next_role");
});

test("normalizeSupervisorDecision: whitespace-only nextRole also falls back", () => {
  const out = normalizeSupervisorDecision({ nextRole: "   " });
  assert.equal(out.terminate, true);
  assert.equal(out.rationale, "invalid_next_role");
});

test("normalizeSupervisorDecision: empty input safely defaults", () => {
  const out = normalizeSupervisorDecision();
  assert.equal(out.terminate, true);
  assert.equal(out.rationale, "invalid_next_role");
});

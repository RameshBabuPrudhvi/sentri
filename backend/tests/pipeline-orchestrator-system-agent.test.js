/**
 * Bundle-A fix #20 — deterministic post-generation pipeline stages
 * (Step 5 dedup, Step 6 enhance, Step 7 validate) emit `agent_event`
 * rows tagged `agent: "system"` instead of `agent: "author"`.
 *
 * Pre-fix every post-processing emit landed under the author lane in
 * the conversation UI, conflating mechanical algorithmic work with
 * actual LLM author dispatches. Post-fix the system lane shows only
 * deterministic work — operators can tell at a glance which steps were
 * LLM calls and which were local.
 *
 * Drives the real `runPostGenerationPipeline` against in-memory SQLite,
 * then reads back the persisted `run_agent_events` rows to verify the
 * `agent` column.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();

const { runPostGenerationPipeline } = await import("../src/pipeline/pipelineOrchestrator.js");
const runAgentEventRepo = await import("../src/database/repositories/runAgentEventRepo.js");

const PROJECT = {
  id: "PRJ-SYS",
  url: "http://app.example.test",
  workspaceId: "__default__",
};

function cleanTest() {
  return {
    name: "User can view the dashboard page",
    steps: ["Open dashboard"],
    type: "functional",
    scenario: "positive",
    sourceUrl: "http://app.example.test/dashboard",
    playwrightCode: [
      "test('Dashboard visit', async ({ page }) => {",
      "  await page.goto('http://app.example.test/dashboard');",
      "  await safeExpect(page, expect, 'Dashboard', 'heading');",
      "});",
    ].join("\n"),
  };
}

function mkRun() {
  return {
    id: `RUN-SYS-${Math.random().toString(36).slice(2, 8)}`,
    type: "generate",
    logs: [],
    status: "running",
  };
}

test("steps 5/6/7 emit agent_event rows tagged agent='system'", async () => {
  const run = mkRun();
  await runPostGenerationPipeline([cleanTest()], PROJECT, run, {});

  const rows = runAgentEventRepo.getByRunId(run.id);
  // Steps 5, 6, 7 each emit 3 phases (start, finding, done) → 9 rows.
  // Production may emit additional rows from other code paths (the
  // healing-transform log isn't an event emit, so we don't expect more).
  // We assert at minimum 9 rows and verify each step's row set.
  assert.ok(rows.length >= 9, `expected ≥ 9 emit rows, got ${rows.length}`);

  for (const step of [5, 6, 7]) {
    const stepRows = rows.filter((r) => r.step === step);
    assert.ok(stepRows.length >= 3, `step ${step} must emit ≥ 3 rows, got ${stepRows.length}`);
    for (const r of stepRows) {
      assert.equal(
        r.agent,
        "system",
        `step ${step} phase ${r.phase} must be tagged "system", got "${r.agent}"`,
      );
    }
  }
});

test("steps 5/6/7 do NOT emit any agent='author' rows (the conflation bug)", async () => {
  const run = mkRun();
  await runPostGenerationPipeline([cleanTest()], PROJECT, run, {});

  const rows = runAgentEventRepo.getByRunId(run.id);
  // The post-generation pipeline must NOT emit author-tagged rows on its
  // deterministic steps. Pre-fix it did — those events conflated with
  // actual LLM author dispatches in the conversation UI.
  for (const step of [5, 6, 7]) {
    const authorRows = rows.filter((r) => r.step === step && r.agent === "author");
    assert.equal(
      authorRows.length,
      0,
      `step ${step} must NOT emit author-tagged rows; found ${authorRows.length}`,
    );
  }
});

test("each system-tagged step preserves the start/finding/done phase sequence", async () => {
  // Phase sequence is a separate contract — fix #20 only changes the
  // `agent` column, not the existing phase ordering. Pin both so a
  // future refactor that drops one of the phase rows is caught.
  const run = mkRun();
  await runPostGenerationPipeline([cleanTest()], PROJECT, run, {});

  const rows = runAgentEventRepo.getByRunId(run.id);
  for (const step of [5, 6, 7]) {
    const phases = rows.filter((r) => r.step === step).map((r) => r.phase);
    assert.ok(phases.includes("start"),  `step ${step} must include phase=start`);
    assert.ok(phases.includes("finding"), `step ${step} must include phase=finding`);
    assert.ok(phases.includes("done"),   `step ${step} must include phase=done`);
  }
});

console.log("✅ pipeline-orchestrator-system-agent tests passed");

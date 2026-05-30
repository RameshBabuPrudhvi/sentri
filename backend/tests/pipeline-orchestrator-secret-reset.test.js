/**
 * Bundle-A fix #6 — `runPostGenerationPipeline` must reset
 * `run.secretScanBlocked` to `false` at entry so a re-entry on the same
 * `run` object (e.g. the crawler calling the pipeline twice for a
 * multi-batch generation) doesn't carry a stale `true` from a previous
 * batch that contained leaked credentials.
 *
 * Drives the real `runPostGenerationPipeline` (not a simulator) so the
 * reset behaviour is exercised against the production code path.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();

const { runPostGenerationPipeline } = await import("../src/pipeline/pipelineOrchestrator.js");

const PROJECT = {
  id: "PRJ-RESET",
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
    id: `RUN-RESET-${Math.random().toString(36).slice(2, 8)}`,
    type: "generate",
    logs: [],
    status: "running",
  };
}

test("runPostGenerationPipeline resets stale secretScanBlocked=true at entry on clean batch", async () => {
  const run = mkRun();
  // Simulate a re-entry: caller hands us the run with a stale flag from a
  // previous batch that contained leaked credentials.
  run.secretScanBlocked = true;

  await runPostGenerationPipeline([cleanTest()], PROJECT, run, {});

  assert.equal(
    run.secretScanBlocked,
    false,
    "stale `true` flag must be reset by orchestrator entry when the current batch is clean",
  );
});

test("runPostGenerationPipeline initialises secretScanBlocked=false when the field was never set", async () => {
  const run = mkRun();
  // Field never written by the caller — orchestrator entry must still
  // initialise it explicitly to `false` (not leave it `undefined`) so
  // downstream consumers reading `run.secretScanBlocked === false` see
  // the canonical value, not a falsy-but-undefined truthiness check
  // bug waiting to happen.
  assert.equal(run.secretScanBlocked, undefined, "precondition: field not set");

  await runPostGenerationPipeline([cleanTest()], PROJECT, run, {});

  assert.equal(run.secretScanBlocked, false, "field initialised to explicit boolean false");
});

console.log("✅ pipeline-orchestrator-secret-reset tests passed");

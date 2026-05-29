/**
 * Bundle-A fix #7 — `runPostGenerationPipeline` must re-score quality
 * factors AFTER the healing-transform stage, not before.
 *
 * The healing transforms rewrite `page.getByRole(..., { name }).click()`
 * into `safeClick(page, ...)`, removing the literal `getByRole`/
 * `getByLabel`/`getByText` calls that the `selector.semantic` rubric
 * factor rewards. Pre-fix the re-score ran BEFORE the transforms, so
 * tests that got rewritten kept a stale `selector.semantic` bonus that
 * no longer matched the persisted code — biasing both the Review Queue's
 * "why was this drafted?" popover and the auto-approval threshold.
 *
 * Drives the real `runPostGenerationPipeline` against in-memory SQLite.
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
  id: "PRJ-QS",
  url: "http://app.example.test",
  workspaceId: "__default__",
};

function mkRun() {
  return {
    id: `RUN-QS-${Math.random().toString(36).slice(2, 8)}`,
    type: "generate",
    logs: [],
    status: "running",
  };
}

test("re-score happens AFTER healing transforms (no stale selector.semantic bonus)", async () => {
  const run = mkRun();
  // `page.getByRole(..., { name: ... }).click()` gets rewritten by
  // `applyHealingTransforms` into `safeClick(page, ...)`. After the
  // rewrite, the literal `getByRole` is gone from `playwrightCode`.
  const t = {
    name: "User submits the contact form on the landing page",
    steps: ["Open landing page", "Submit form"],
    type: "functional",
    scenario: "positive",
    sourceUrl: "http://app.example.test/contact",
    playwrightCode: [
      "test('Contact submit', async ({ page }) => {",
      "  await page.goto('http://app.example.test/contact');",
      "  await page.getByRole('button', { name: 'Submit' }).click();",
      "  await safeExpect(page, expect, 'Thanks', 'heading');",
      "});",
    ].join("\n"),
  };

  await runPostGenerationPipeline([t], PROJECT, run, {});

  // Precondition: the transform stage actually ran and rewrote the
  // semantic-locator click into safeClick.
  assert.ok(
    !t.playwrightCode.includes("getByRole"),
    "precondition: healing transforms must have rewritten getByRole().click() to safeClick",
  );
  assert.ok(
    t.playwrightCode.includes("safeClick"),
    "precondition: rewrite produced safeClick",
  );

  // Bundle-A fix #7 — `_qualityFactors` MUST NOT carry the
  // `selector.semantic` reward, because the re-score now runs AFTER
  // the transform stage and the post-transform code no longer contains
  // `getByRole`/`getByLabel`/`getByText`. Pre-fix the factor list still
  // included `selector.semantic` against the pre-transform shape —
  // a 10-point misattribution surfaced in the Review Queue's
  // "why was this drafted?" popover and biased auto-approval scoring.
  const factorIds = (t._qualityFactors || []).map((f) => f.id);
  assert.ok(
    !factorIds.includes("selector.semantic"),
    `selector.semantic must NOT be attributed after transform; got factors: ${factorIds.join(", ")}`,
  );
});

test("scoring factors agree with the post-transform code shape (general invariant)", async () => {
  const run = mkRun();
  // Negative-path / invariant: for ANY test in the persisted output,
  // the `selector.semantic` factor presence must match what's actually
  // in `playwrightCode`. Pre-fix this invariant could be violated for
  // any test the transform stage rewrote. This generalises the bug
  // assertion above so a future regression that re-orders the stages
  // (or skips the re-score) gets caught no matter which fixture lands
  // in the test.
  const t = {
    name: "User submits the contact form on the landing page",
    steps: ["Open landing page", "Submit form"],
    type: "functional",
    scenario: "positive",
    sourceUrl: "http://app.example.test/contact",
    playwrightCode: [
      "test('Contact submit', async ({ page }) => {",
      "  await page.goto('http://app.example.test/contact');",
      "  await page.getByRole('button', { name: 'Submit' }).click();",
      "  await safeExpect(page, expect, 'Thanks', 'heading');",
      "});",
    ].join("\n"),
  };
  await runPostGenerationPipeline([t], PROJECT, run, {});

  const factorIds = (t._qualityFactors || []).map((f) => f.id);
  const codeHasSemantic = /getByRole|getByLabel|getByText/.test(t.playwrightCode);
  assert.equal(
    factorIds.includes("selector.semantic"),
    codeHasSemantic,
    "selector.semantic factor presence must match the post-transform code",
  );

  // Same invariant for the `_quality` score (0–100) and the lock-step
  // `confidenceScore` (0–1) so AUTO-003b auto-approval keys against
  // the post-transform score, not the pre-transform one.
  assert.ok(Number.isFinite(t._quality), "quality score is finite");
  assert.ok(t._quality >= 0 && t._quality <= 100, "quality score in [0,100]");
  assert.ok(Number.isFinite(t.confidenceScore), "confidence score is finite");
  assert.ok(t.confidenceScore >= 0 && t.confidenceScore <= 1, "confidence in [0,1]");
});

console.log("✅ pipeline-orchestrator-quality-rescoring tests passed");

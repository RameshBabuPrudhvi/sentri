import assert from "node:assert/strict";
import test from "node:test";
import { setupTestEnvironment } from "./helpers/test-base.js";

setupTestEnvironment();

const runtime = await import("../src/aiProvider/agentTools/runtime.js");

test("tool execution: dryRun success shape", async () => {
  // Realistic Playwright snippet so the static validator
  // (`pipeline/testValidator.validateTest`) sees a parseable test body
  // with a recognised action + assertion. A bare `test('x', async()=>{})`
  // would now fail the deep checks the validator performs once acorn
  // parses successfully (no `page.*`, no `expect(...)`).
  const out = await runtime.executeToolCall({
    role: "reviewer",
    tool: "playwright.dryRun",
    args: {
      testCode: "test('hello', async ({ page }) => { await page.goto('https://app.example.test/'); await expect(page).toHaveURL(/example/); });",
    },
    context: { workspaceId: "ws1", threadId: "th1", fromRole: "reviewer", projectUrl: "https://app.example.test/" },
  });
  assert.equal(out.result.ok, true);
  assert.deepEqual(out.result.diagnostics, []);
});

test("tool execution: dryRun rejects malformed code with diagnostics", async () => {
  const out = await runtime.executeToolCall({
    role: "reviewer",
    tool: "playwright.dryRun",
    args: { testCode: "test('broken', async ({ page }) => { await page.clicks('#x') }" }, // typo + unbalanced
    context: { workspaceId: "ws1", threadId: "th1", fromRole: "reviewer" },
  });
  assert.equal(out.result.ok, false);
  assert.ok(Array.isArray(out.result.diagnostics) && out.result.diagnostics.length > 0);
});

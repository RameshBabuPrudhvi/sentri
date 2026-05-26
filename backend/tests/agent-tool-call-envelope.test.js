import assert from "node:assert/strict";
import test from "node:test";
import { setupTestEnvironment } from "./helpers/test-base.js";

setupTestEnvironment();

const runtime = await import("../src/aiProvider/agentTools/runtime.js");

test("tool execution: dryRun success shape", async () => {
  const out = await runtime.executeToolCall({
    role: "reviewer",
    tool: "playwright.dryRun",
    args: { testCode: "test('x', async()=>{})" },
    context: { workspaceId: "ws1", threadId: "th1", fromRole: "reviewer" },
  });
  assert.equal(out.result.ok, true);
});

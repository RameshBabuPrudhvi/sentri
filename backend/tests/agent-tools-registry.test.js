import assert from "node:assert/strict";
import test from "node:test";

const tools = await import("../src/aiProvider/agentTools/index.js");

test("listToolsForRole enforces allowlist", () => {
  const all = tools.listToolsForRole("author");
  assert.ok(all.includes("db.listExistingTests"));
  const filtered = tools.listToolsForRole("author", ["playwright.dryRun"]);
  assert.deepEqual(filtered, ["playwright.dryRun"]);
});

test("validateToolCall validates schema", () => {
  const parsed = tools.validateToolCall("db.getTest", { testId: "t-1" });
  assert.equal(parsed.testId, "t-1");
  assert.throws(() => tools.validateToolCall("db.getTest", {}));
  assert.throws(() => tools.validateToolCall("nope", {}));
});

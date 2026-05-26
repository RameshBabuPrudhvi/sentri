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

test("allowlist cannot elevate role beyond baseline tool set", () => {
  // Reviewer baseline doesn't include db.listExistingTests. Even if
  // allowlist asks for it, intersection logic must keep it hidden.
  const filtered = tools.listToolsForRole("reviewer", ["db.listExistingTests", "db.getTest"]);
  assert.deepEqual(filtered, ["db.getTest"]);
});

test("validateToolCall surfaces structured Zod issues on `err.issues`", () => {
  // Gap #3 — the migration from hand-rolled validators to Zod attaches
  // an `issues[]` array carrying `{path, message, code}` per ZodError.
  // A future LLM-driven retry path keys on the path to know which field
  // to correct.
  try {
    tools.validateToolCall("crawl.getPageHtml", { url: "not-a-url", runId: "" });
    assert.fail("expected validateToolCall to throw");
  } catch (err) {
    assert.equal(err.code, "ERR_AGENT_TOOL_VALIDATION");
    assert.ok(Array.isArray(err.issues), "err.issues must be an array");
    // Zod reports both invalid fields in a single pass (vs. the prior
    // hand-rolled validator that bailed on first failure).
    assert.ok(err.issues.length >= 2,
      `expected ≥2 issues, got ${err.issues.length}`);
    const paths = err.issues.map((i) => i.path.join("."));
    assert.ok(paths.includes("url"), "url issue should be reported");
    assert.ok(paths.includes("runId"), "runId issue should be reported");
  }
});

test("db.listExistingTests `limit` arg is coerced + clamped to positive int", () => {
  // Gap #6 — the `limit` flag pushes the SQL LIMIT to the repo. Validate
  // that string numerics coerce, non-positive values are rejected, and
  // the field stays optional (omitted → undefined, repo defaults to 30).
  const parsedString = tools.validateToolCall("db.listExistingTests", { projectId: "p-1", limit: "50" });
  assert.equal(parsedString.limit, 50);

  const parsedOmitted = tools.validateToolCall("db.listExistingTests", { projectId: "p-1" });
  assert.equal(parsedOmitted.limit, undefined);

  assert.throws(() => tools.validateToolCall("db.listExistingTests", { projectId: "p-1", limit: -5 }));
  assert.throws(() => tools.validateToolCall("db.listExistingTests", { projectId: "p-1", limit: 0 }));
  assert.throws(() => tools.validateToolCall("db.listExistingTests", { projectId: "p-1", limit: 1.5 }));
});

test("strict schemas reject unknown args (Zod `.strict()`)", () => {
  // Strict schemas prevent silent param drift — a typo'd field name
  // throws instead of being dropped on the floor.
  assert.throws(() => tools.validateToolCall("db.getTest", { testId: "t-1", extraField: "ignored" }));
});

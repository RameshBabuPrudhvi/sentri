/**
 * @module tests/test-edit-prompt
 * @description Unit tests for buildTestEditPrompt() — DIF-007 conversational
 * test editor prompt builder.
 *
 * Verifies that `context.mode === "test_edit"` produces the dedicated
 * test-edit system prompt and a structured user message containing the
 * test name, steps, and current Playwright code, with safe defaults for
 * missing/invalid fields.
 */

import assert from "node:assert/strict";
import { buildTestEditPrompt, TEST_EDIT_SYSTEM_PROMPT } from "../src/routes/testEdit.js";
import { createTestRunner } from "./helpers/test-base.js";

// Stage 2 (test-infra cleanup) — replaced the inline `function test(name, fn)`
// with the shared runner from `helpers/test-base.js`. See the comment in
// `secret-scanner.test.js` for the rationale + behavioural-compat notes.
const { test, summary } = createTestRunner();

console.log("\n✏️   buildTestEditPrompt — DIF-007 test edit mode");

test("returns the dedicated TEST_EDIT_SYSTEM_PROMPT", () => {
  const { systemPrompt } = buildTestEditPrompt(
    { testCode: "x", testName: "n", testSteps: [] },
    { content: "do it" },
  );
  assert.equal(systemPrompt, TEST_EDIT_SYSTEM_PROMPT);
});

test("user content embeds testName, request, steps, and code block", () => {
  const { userContent } = buildTestEditPrompt(
    {
      testCode: "await page.goto('/');",
      testName: "Login flow",
      testSteps: ["open page", "click login"],
    },
    { content: "Add an assertion for the title" },
  );
  assert.ok(userContent.includes("Test name: Login flow"));
  assert.ok(userContent.includes("Add an assertion for the title"));
  assert.ok(userContent.includes("1. open page"));
  assert.ok(userContent.includes("2. click login"));
  assert.ok(userContent.includes("```javascript\nawait page.goto('/');\n```"));
});

test("steps are capped at 20", () => {
  const steps = Array.from({ length: 30 }, (_, i) => `step ${i + 1}`);
  const { userContent } = buildTestEditPrompt(
    { testCode: "", testName: "T", testSteps: steps },
    { content: "edit" },
  );
  assert.ok(userContent.includes("20. step 20"));
  assert.ok(!userContent.includes("21. step 21"));
});

test("missing testCode defaults to empty string in code block", () => {
  const { userContent } = buildTestEditPrompt(
    { testName: "T", testSteps: [] },
    { content: "edit" },
  );
  assert.ok(userContent.includes("```javascript\n\n```"));
});

test("non-string testCode is coerced to empty", () => {
  const { userContent } = buildTestEditPrompt(
    { testCode: 12345, testName: "T", testSteps: [] },
    { content: "edit" },
  );
  assert.ok(userContent.includes("```javascript\n\n```"));
});

test("missing testName falls back to 'Unnamed test'", () => {
  const { userContent } = buildTestEditPrompt(
    { testCode: "x", testSteps: [] },
    { content: "edit" },
  );
  assert.ok(userContent.includes("Test name: Unnamed test"));
});

test("non-array testSteps falls back to '(none)'", () => {
  const { userContent } = buildTestEditPrompt(
    { testCode: "x", testName: "T", testSteps: "not-an-array" },
    { content: "edit" },
  );
  assert.ok(userContent.includes("Current steps:\n(none)"));
});

test("null context is handled safely", () => {
  const { systemPrompt, userContent } = buildTestEditPrompt(null, { content: "edit" });
  assert.equal(systemPrompt, TEST_EDIT_SYSTEM_PROMPT);
  assert.ok(userContent.includes("Test name: Unnamed test"));
  assert.ok(userContent.includes("Current steps:\n(none)"));
  assert.ok(userContent.includes("```javascript\n\n```"));
});

summary("test-edit-prompt");

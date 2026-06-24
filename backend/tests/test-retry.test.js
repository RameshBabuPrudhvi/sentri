/**
 * @module tests/test-retry
 * @description Unit tests for `executeWithRetries` (AUTO-005).
 */

import assert from "node:assert/strict";
import { executeWithRetries } from "../src/runner/retry.js";
import { createTestRunner } from "./helpers/test-base.js";

// Stage 2 (test-infra cleanup) — replaced the inline `async function test(name, fn)`
// with the shared runner from `helpers/test-base.js`. See the comment in
// `secret-scanner.test.js` for the rationale + behavioural-compat notes.
const { test, summary } = createTestRunner();

console.log("\n🧪 executeWithRetries");

await test("returns retryCount when later attempt succeeds", async () => {
  let tries = 0;
  const { result, retryCount } = await executeWithRetries(async () => {
    tries += 1;
    if (tries === 1) throw new Error("first fail");
    return { status: "passed" };
  }, 2);

  assert.equal(retryCount, 1);
  assert.equal(result.status, "passed");
  assert.equal(tries, 2);
});

await test("throws after retries exhausted", async () => {
  let tries = 0;
  await assert.rejects(async () => {
    await executeWithRetries(async () => {
      tries += 1;
      throw new Error("always fails");
    }, 2);
  }, /always fails/);
  assert.equal(tries, 3);
});

summary("test-retry");

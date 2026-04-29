/**
 * @module tests/test-retry
 * @description Unit tests for `executeWithRetries` (AUTO-005).
 */

import assert from "node:assert/strict";
import { executeWithRetries } from "../src/runner/retry.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

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

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  Test-retry tests failed");
  process.exit(1);
}

console.log("\n🎉 Test-retry tests passed");

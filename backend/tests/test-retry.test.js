/**
 * @module tests/test-retry
 * @description Unit tests for AUTO-005 — `executeWithRetries()` helper in
 * `backend/src/runner/retry.js`. Verifies the retry budget is honoured, that
 * a successful later attempt surfaces the correct `retryCount`, and that the
 * last error propagates after retries are exhausted.
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

async function main() {
  console.log("\n🧪 executeWithRetries()");

  try {
    await test("returns retryCount when a later attempt succeeds", async () => {
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

    await test("throws the last error after retries are exhausted", async () => {
      let tries = 0;
      await assert.rejects(async () => {
        await executeWithRetries(async () => {
          tries += 1;
          throw new Error("always fails");
        }, 2);
      }, /always fails/);
      assert.equal(tries, 3);
    });
  } finally {
    console.log("\n──────────────────────────────────────────────────");
    console.log(`Results: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.log("\n⚠️  retry tests failed");
      process.exit(1);
    }

    console.log("\n🎉 All retry tests passed!");
  }
}

main().catch((err) => {
  console.error("❌ test-retry failed:", err);
  process.exit(1);
});

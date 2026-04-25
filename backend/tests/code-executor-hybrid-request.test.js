/**
 * @module tests/code-executor-hybrid-request
 * @description Regression test: browser sandbox request fixture supports both
 * request.newContext() and request.<httpMethod>() shapes.
 */

import assert from "node:assert/strict";
import { runGeneratedCode } from "../src/runner/codeExecutor.js";

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

console.log("\n🧪 codeExecutor hybrid request fixture");

await run("runGeneratedCode exposes request.newContext and request.get in browser sandbox", async () => {
  const playwrightCode = [
    "import { test, expect } from '@playwright/test';",
    "test('hybrid request fixture', async ({ page, request }) => {",
    "  if (typeof request.newContext !== 'function') throw new Error('missing newContext');",
    "  if (typeof request.get !== 'function') throw new Error('missing get');",
    "  const api = await request.newContext();",
    "  await api.dispose();",
    "});",
  ].join("\n");

  const result = await runGeneratedCode(
    {},
    { browser: () => undefined },
    playwrightCode,
    () => ({ toBe: () => {} }),
    {},
  );
  assert.equal(result.passed, true);
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("\n🎉 codeExecutor hybrid request tests passed");


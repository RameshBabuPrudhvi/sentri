/**
 * @module tests/code-parsing
 * @description Focused unit tests for runner/codeParsing string repair helpers.
 */

import assert from "node:assert/strict";
import { repairBrokenStringLiterals } from "../src/runner/codeParsing.js";

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n🧪 codeParsing: repairBrokenStringLiterals");

test("repairs newline inside single-quoted selector", () => {
  const broken = "const el = await page.$('button[name=btnI]\n[type=submit]');";
  const repaired = repairBrokenStringLiterals(broken);
  assert.equal(repaired.includes("\n"), false);
  assert.match(repaired, /button\[name=btnI\]\s+\[type=submit\]/);
});

test("repairs newline inside double-quoted selector", () => {
  const broken = "await page.locator(\".search .g > div\n.result\").first();";
  const repaired = repairBrokenStringLiterals(broken);
  assert.equal(repaired.includes("\n"), false);
  assert.match(repaired, /\.search \.g > div\s+\.result/);
});

test("does not alter template literals", () => {
  const code = "const msg = `line1\\nline2`;";
  const repaired = repairBrokenStringLiterals(code);
  assert.equal(repaired, code);
});

if (process.exitCode) {
  console.log("\n⚠️ codeParsing tests failed");
  process.exit(1);
}
console.log("\n🎉 codeParsing tests passed");

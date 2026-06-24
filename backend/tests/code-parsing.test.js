/**
 * @module tests/code-parsing
 * @description Focused unit tests for runner/codeParsing string repair helpers.
 */

import assert from "node:assert/strict";
import { repairBrokenStringLiterals } from "../src/runner/codeParsing.js";
import { createTestRunner } from "./helpers/test-base.js";

// Stage 2 (test-infra cleanup) — replaced the inline `function test(name, fn)`
// with the shared runner from `helpers/test-base.js`. See the comment in
// `secret-scanner.test.js` for the rationale + behavioural-compat notes.
const { test, summary } = createTestRunner();

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

test("does not treat apostrophes in line comments as string delimiters", () => {
  const code = "// Don't break here\nconst value = 'ok';";
  const repaired = repairBrokenStringLiterals(code);
  assert.equal(repaired, code);
  assert.equal(repaired.includes("\n"), true);
});

test("does not treat apostrophes in block comments as string delimiters", () => {
  const code = "/* user's note: don't touch */\nconst value = 'ok';";
  const repaired = repairBrokenStringLiterals(code);
  assert.equal(repaired, code);
  assert.equal(repaired.includes("\n"), true);
});

summary("codeParsing");

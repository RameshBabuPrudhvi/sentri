import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

console.log("\n♿ Accessibility migration");

const migrationPath = path.join(process.cwd(), "src/database/migrations/013_accessibility_violations.sql");
const sql = fs.readFileSync(migrationPath, "utf8");

test("creates accessibility_violations table", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS accessibility_violations/i);
});

test("includes required columns", () => {
  const expected = ["runId", "pageUrl", "ruleId", "impact", "wcagCriterion", "help", "description", "nodesJson", "createdAt"];
  for (const col of expected) {
    assert.match(sql, new RegExp(`\\b${col}\\b`));
  }
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

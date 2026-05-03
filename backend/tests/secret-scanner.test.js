import assert from "node:assert/strict";
import { scanForSecrets } from "../src/pipeline/secretScanner.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(err.message);
    failed++;
    process.exitCode = 1;
  }
}

test("detects AWS access keys", () => {
  const code = "const key = 'AKIA1234567890ABCDEF';";
  const findings = scanForSecrets(code);
  assert.ok(findings.some(f => f.ruleId === "aws-access-key-id"));
  assert.ok(findings[0].match.includes("…"));
});

test("detects JWT", () => {
  const code = "const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoidGVzdCJ9.c2lnbmF0dXJl';";
  const findings = scanForSecrets(code);
  assert.ok(findings.some(f => f.ruleId === "jwt-token"));
});

test("detects bearer token", () => {
  const code = "await page.setExtraHTTPHeaders({ Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456' });";
  const findings = scanForSecrets(code);
  assert.ok(findings.some(f => f.ruleId === "bearer-token"));
});

test("clean code has no findings", () => {
  const code = "await page.goto('https://example.org'); await safeClick(page, 'Login');";
  assert.deepEqual(scanForSecrets(code), []);
});

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.log(`\n⚠️  ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n🎉 All secret-scanner tests passed!`);
}

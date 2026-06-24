import assert from "node:assert/strict";
import { scanForSecrets } from "../src/pipeline/secretScanner.js";
import { createTestRunner } from "./helpers/test-base.js";

// Stage 2 (test-infra cleanup) — replaced the inline `function test(name, fn)`
// with the shared runner from `helpers/test-base.js` so failures surface with
// full stack traces, per-test timing, and the `TEST_FILTER` / `TEST_BAIL` /
// `TEST_VERBOSE` debug knobs apply uniformly across the backend test suite.
// No behavioural change for the test bodies — `test(...)` keeps the same
// signature, and `summary()` drains pending test promises so the existing
// bare-top-level call pattern (no `await`, no `main()` wrapper) still works.
const { test, summary } = createTestRunner();

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

summary("secret-scanner");

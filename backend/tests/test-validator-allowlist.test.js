/**
 * @module tests/test-validator-allowlist
 * @description Regression coverage for validateActions allowlist entries so
 * expanded Playwright API support does not silently regress.
 */

import assert from "node:assert/strict";
import { validateActions } from "../src/pipeline/testValidator.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

console.log("\n🧪 test-validator allowlist regression");

const ALLOWLIST_CASES = [
  { label: "page.route", code: "await page.route('**/api/**', route => route.fulfill({ status: 200, body: '{}' }));" },
  { label: "route.fulfill", code: "await route.fulfill({ status: 200, body: '{}' });" },
  { label: "route.continue", code: "await route.continue();" },
  { label: "context.storageState", code: "await context.storageState({ path: 'state.json' });" },
  { label: "context.setGeolocation", code: "await context.setGeolocation({ latitude: 1, longitude: 2 });" },
  { label: "page.frameLocator", code: "await page.frameLocator('#checkout').getByRole('button', { name: 'Pay' }).click();" },
  { label: "request context", code: "const api = await request.newContext({ baseURL: 'https://x' }); await api.get('/health');" },
  { label: "page.dragAndDrop", code: "await page.dragAndDrop('#source', '#target');" },
  { label: "locator.dragTo", code: "await page.locator('#source').dragTo(page.locator('#target'));" },
  { label: "setInputFiles", code: "await page.getByLabel('Upload').setInputFiles('file.txt');" },
  { label: "test.describe.configure", code: "test.describe.configure({ mode: 'parallel' });" },
  { label: "testInfo.attach", code: "await testInfo.attach('trace', { body: 'x' });" },
];

for (const c of ALLOWLIST_CASES) {
  test(`${c.label} should not be flagged as invalid`, () => {
    const issues = validateActions(c.code);
    assert.equal(issues.length, 0, `Unexpected issues: ${issues.join("; ")}`);
  });
}

test("invalid typo is still flagged", () => {
  const issues = validateActions("await page.clik('Submit');");
  assert.ok(issues.some((i) => i.includes('.clik()')), `Expected typo issue, got: ${issues.join("; ")}`);
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("\n🎉 test-validator allowlist tests passed");


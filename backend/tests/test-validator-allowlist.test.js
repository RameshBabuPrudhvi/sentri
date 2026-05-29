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
  { label: "request.dispose", code: "const api = await request.newContext({ baseURL: 'https://x' }); await api.dispose();" },
  { label: "page.dragAndDrop", code: "await page.dragAndDrop('#source', '#target');" },
  { label: "locator.dragTo", code: "await page.locator('#source').dragTo(page.locator('#target'));" },
  { label: "setInputFiles", code: "await page.getByLabel('Upload').setInputFiles('file.txt');" },
  { label: "test.describe.configure", code: "test.describe.configure({ mode: 'parallel' });" },
  { label: "testInfo.attach", code: "await testInfo.attach('trace', { body: 'x' });" },
  // ── Bundle-A fix #17 — additions to VALID_PAGE_ACTIONS ─────────────────────
  // Each case exercises a method that pre-fix tripped the "invalid Playwright
  // method" rejection even though it's part of the real `@playwright/test`
  // public API. Bugs.md's spec-required minimum: boundingBox, addScriptTag,
  // addStyleTag, bringToFront, pdf, exposeFunction, exposeBinding,
  // setContent, setOfflineMode, coverage.
  { label: "page.boundingBox via locator", code: "const box = await page.locator('h1').boundingBox();" },
  { label: "page.addScriptTag", code: "await page.addScriptTag({ url: 'https://cdn.example/polyfill.js' });" },
  { label: "page.addStyleTag", code: "await page.addStyleTag({ content: 'body { color: red; }' });" },
  { label: "page.bringToFront", code: "await page.bringToFront();" },
  { label: "page.pdf", code: "await page.pdf({ format: 'A4' });" },
  { label: "page.exposeFunction", code: "await page.exposeFunction('logFromPage', (msg) => console.log(msg));" },
  { label: "page.exposeBinding", code: "await page.exposeBinding('binding', (source, arg) => arg);" },
  { label: "page.setContent", code: "await page.setContent('<html><body>Hello</body></html>');" },
  { label: "context.setOfflineMode", code: "await context.setOfflineMode(true);" },
  { label: "page.coverage", code: "await page.coverage.startJSCoverage();" },
  // Locator combinators (1.34+):
  { label: "locator.and", code: "await page.locator('button').and(page.locator(':visible')).click();" },
  { label: "locator.or", code: "await page.locator('button').or(page.locator('input')).first().click();" },
  { label: "locator.clear", code: "await page.getByLabel('Search').clear();" },
  // Download / video API:
  { label: "download.saveAs", code: "const [download] = await Promise.all([ page.waitForEvent('download'), page.click('a') ]); await download.saveAs('out.pdf');" },
  { label: "download.suggestedFilename", code: "const [download] = await Promise.all([ page.waitForEvent('download'), page.click('a') ]); const name = download.suggestedFilename();" },
  // Response / request body extraction:
  { label: "response.json", code: "const res = await api.get('/x'); const body = await res.json();" },
  { label: "response.headers", code: "const res = await api.get('/x'); const h = res.headers();" },
  // Frame traversal:
  { label: "page.mainFrame", code: "const frame = page.mainFrame();" },
  { label: "page.frames", code: "const frames = page.frames();" },
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

/**
 * @module tests/utils
 * @description Unit tests for frontend utility modules extracted from page components.
 * Runs with plain Node.js (no framework) — matches backend test convention.
 *
 * Usage: node frontend/tests/utils.test.js
 */

import assert from "node:assert/strict";

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── Import utils (ESM) ───────────────────────────────────────────────────────
import { fmtMs, fmtBytes, fmtDate, fmtDateTime } from "../src/utils/formatters.js";
import playwrightToCurl from "../src/utils/playwrightToCurl.js";
import splitCodeBySteps from "../src/utils/splitCodeBySteps.js";
import highlightCode from "../src/utils/highlightCode.js";

// ═══════════════════════════════════════════════════════════════════════════════
// formatters
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 formatters");

test("fmtMs returns empty string for null/undefined", () => {
  assert.equal(fmtMs(null), "");
  assert.equal(fmtMs(undefined), "");
});

test("fmtMs formats milliseconds under 1s", () => {
  assert.equal(fmtMs(0), "");
  assert.equal(fmtMs(500), "500ms");
  assert.equal(fmtMs(999), "999ms");
});

test("fmtMs formats seconds", () => {
  assert.equal(fmtMs(1000), "1.0s");
  assert.equal(fmtMs(2500), "2.5s");
});

test("fmtBytes returns dash for null/undefined", () => {
  assert.equal(fmtBytes(null), "—");
  assert.equal(fmtBytes(undefined), "—");
});

test("fmtBytes formats bytes, KB, MB", () => {
  assert.equal(fmtBytes(0), "—");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(1024), "1.0 KB");
  assert.equal(fmtBytes(1048576), "1.0 MB");
});

test("fmtDate returns dash for falsy input", () => {
  assert.equal(fmtDate(null), "—");
  assert.equal(fmtDate(""), "—");
});

test("fmtDate formats a valid ISO date", () => {
  const result = fmtDate("2026-04-08T12:00:00Z");
  assert.ok(result.includes("2026"), `Expected year in "${result}"`);
  assert.ok(result.includes("8"), `Expected day in "${result}"`);
});

test("fmtDateTime returns dash for falsy input", () => {
  assert.equal(fmtDateTime(null), "—");
});

test("fmtDateTime returns relative time for recent dates", () => {
  const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
  assert.match(fmtDateTime(twoMinAgo), /2m ago/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// playwrightToCurl
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 playwrightToCurl");

test("returns null for null/empty input", () => {
  assert.equal(playwrightToCurl(null), null);
  assert.equal(playwrightToCurl(""), null);
});

test("returns null for code with no API calls", () => {
  assert.equal(playwrightToCurl("await page.goto('https://example.com')"), null);
});

test("converts a simple GET call", () => {
  const code = `const resp = await api.get('https://api.example.com/users')`;
  const curl = playwrightToCurl(code);
  assert.ok(curl, "Expected non-null curl");
  assert.ok(curl.includes("curl"), "Expected curl command");
  assert.ok(curl.includes("https://api.example.com/users"), "Expected URL");
  // GET should not have -X
  assert.ok(!curl.includes("-X"), "GET should not have -X flag");
});

test("converts a POST call with headers and body", () => {
  const code = `await api.post('https://api.example.com/users', {
    headers: { 'Authorization': 'Bearer tok123' },
    data: { name: 'Alice' }
  })`;
  const curl = playwrightToCurl(code);
  assert.ok(curl, "Expected non-null curl");
  assert.ok(curl.includes("-X POST"), "Expected POST method");
  assert.ok(curl.includes("-H 'Authorization: Bearer tok123'"), "Expected auth header");
  assert.ok(curl.includes("-d '"), "Expected data flag");
});

test("discovers custom variable names from newContext()", () => {
  const code = `
    const myClient = await request.newContext({ baseURL: 'https://api.example.com' });
    const resp = await myClient.get('/health');
  `;
  const curl = playwrightToCurl(code);
  assert.ok(curl, "Expected non-null curl for discovered variable");
  assert.ok(curl.includes("/health"), "Expected URL path");
});

test("handles multiple API calls", () => {
  const code = `
    await api.get('https://api.example.com/a');
    await api.post('https://api.example.com/b');
  `;
  const curl = playwrightToCurl(code);
  assert.ok(curl, "Expected non-null curl");
  // Two commands separated by blank line
  assert.ok(curl.includes("/a"), "Expected first URL");
  assert.ok(curl.includes("/b"), "Expected second URL");
  assert.ok(curl.includes("\n\n"), "Expected blank line between commands");
});

// ═══════════════════════════════════════════════════════════════════════════════
// splitCodeBySteps
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 splitCodeBySteps");

test("returns empty array for null code", () => {
  assert.deepEqual(splitCodeBySteps(null, 3), []);
});

test("returns empty array for zero steps", () => {
  assert.deepEqual(splitCodeBySteps("some code", 0), []);
});

test("distributes lines across steps", () => {
  const code = `test('example', async ({ page }) => {
  await page.goto('https://example.com');
  await page.click('#btn');
  await page.fill('#name', 'Alice');
  await expect(page).toHaveTitle('Done');
});`;
  const chunks = splitCodeBySteps(code, 2);
  assert.equal(chunks.length, 2, "Expected 2 chunks");
  assert.ok(chunks[0].length > 0, "First chunk should have content");
  assert.ok(chunks[1].length > 0, "Second chunk should have content");
});

test("handles more steps than lines", () => {
  const code = `test('tiny', async ({ page }) => {
  await page.goto('https://example.com');
});`;
  const chunks = splitCodeBySteps(code, 5);
  assert.equal(chunks.length, 5, "Expected 5 chunks");
  // At least one chunk should have content
  assert.ok(chunks.some(c => c.length > 0), "At least one chunk should have content");
});

// ═══════════════════════════════════════════════════════════════════════════════
// highlightCode
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 highlightCode");

test("returns HTML string", () => {
  const html = highlightCode("const x = 1;");
  assert.ok(typeof html === "string");
  assert.ok(html.includes("<span"), "Expected HTML spans");
});

test("highlights keywords", () => {
  const html = highlightCode("const x = await foo();");
  assert.ok(html.includes("c792ea"), "Expected keyword color for const/await");
});

test("highlights strings without double-highlighting", () => {
  const html = highlightCode("const s = 'hello const world';");
  // The word "const" inside the string should be green (string color), not purple (keyword color)
  // String color is c3e88d
  assert.ok(html.includes("c3e88d"), "Expected string color");
});

test("highlights comments", () => {
  const html = highlightCode("// this is a comment\nconst x = 1;");
  assert.ok(html.includes("546174"), "Expected comment color");
});

test("handles empty string", () => {
  const html = highlightCode("");
  assert.equal(html, "");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════
if (process.exitCode) {
  console.log("\n⚠️  Some frontend util tests failed");
  process.exit(1);
}
console.log("\n🎉 All frontend util tests passed");

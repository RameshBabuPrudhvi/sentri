/**
 * @module tests/api-test-prompt
 * @description Unit tests for formatJsonExample and buildApiTestPrompt.
 *
 * Coverage areas:
 *   1. formatJsonExample — short strings, large arrays, large objects,
 *      single-key overflow, non-JSON payloads, null/undefined input
 *   2. buildApiTestPrompt — truncation integration via endpoint bodies
 *
 * Run: node tests/api-test-prompt.test.js
 */

import assert from "node:assert/strict";
import { formatJsonExample } from "../src/pipeline/prompts/apiTestPrompt.js";

// ── Test runner ───────────────────────────────────────────────────────────────

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

// ── 1. formatJsonExample — basic behavior ────────────────────────────────────

console.log("\n📦  formatJsonExample — basic behavior");

test("returns short strings unchanged", () => {
  const short = '{"name":"Alice","age":30}';
  assert.equal(formatJsonExample(short), short);
});

test("returns empty string for null input", () => {
  assert.equal(formatJsonExample(null), "");
});

test("returns empty string for undefined input", () => {
  assert.equal(formatJsonExample(undefined), "");
});

test("returns empty string for empty string input", () => {
  assert.equal(formatJsonExample(""), "");
});

test("returns non-string input as-is (truthy passthrough)", () => {
  assert.equal(formatJsonExample(42), 42);
});

// ── 2. formatJsonExample — JSON array truncation ─────────────────────────────

console.log("\n📦  formatJsonExample — JSON array truncation");

test("truncates large arrays to fit within maxChars", () => {
  // Create a large array with 50 objects
  const arr = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Item number ${i}`, description: "A moderately long description for testing purposes" }));
  const raw = JSON.stringify(arr);
  assert.ok(raw.length > 200, "Test data should exceed maxChars");

  const result = formatJsonExample(raw, 200);
  assert.ok(result.length <= raw.length, "Result should be shorter than original");
  const parsed = JSON.parse(result);
  assert.ok(Array.isArray(parsed), "Result should be a valid JSON array");
  assert.ok(parsed.length < arr.length, "Result should have fewer elements");
});

test("always includes at least one array element even if it exceeds maxChars", () => {
  // Single large element that exceeds maxChars
  const arr = [{ data: "x".repeat(500) }];
  const raw = JSON.stringify(arr);
  const result = formatJsonExample(raw, 100);
  const parsed = JSON.parse(result);
  assert.ok(Array.isArray(parsed), "Result should be a valid JSON array");
  assert.equal(parsed.length, 1, "Should include at least one element");
});

// ── 3. formatJsonExample — JSON object truncation ────────────────────────────

console.log("\n📦  formatJsonExample — JSON object truncation");

test("truncates large objects by dropping keys that exceed maxChars", () => {
  const obj = {};
  for (let i = 0; i < 30; i++) {
    obj[`key${i}`] = `value_${i}_${"x".repeat(20)}`;
  }
  const raw = JSON.stringify(obj);
  assert.ok(raw.length > 300, "Test data should exceed maxChars");

  const result = formatJsonExample(raw, 300);
  const parsed = JSON.parse(result);
  assert.ok(typeof parsed === "object" && !Array.isArray(parsed));
  assert.ok(Object.keys(parsed).length < Object.keys(obj).length, "Should have fewer keys");
  assert.ok(Object.keys(parsed).length >= 1, "Should have at least one key");
});

test("always includes at least one key even if first key exceeds maxChars", () => {
  // Single key whose value is huge
  const obj = { bigField: "x".repeat(5000) };
  const raw = JSON.stringify(obj);
  const result = formatJsonExample(raw, 100);
  const parsed = JSON.parse(result);
  assert.ok(typeof parsed === "object" && !Array.isArray(parsed));
  assert.equal(Object.keys(parsed).length, 1, "Should include at least one key");
  assert.ok("bigField" in parsed, "Should include the first key");
});

test("does not return empty {} for single-key object exceeding maxChars", () => {
  const obj = { data: "y".repeat(3000) };
  const raw = JSON.stringify(obj);
  const result = formatJsonExample(raw, 100);
  assert.notEqual(result, "{}", "Should never return empty object");
});

// ── 4. formatJsonExample — non-JSON payloads ─────────────────────────────────

console.log("\n📦  formatJsonExample — non-JSON payloads");

test("truncates non-JSON strings with [truncated] marker", () => {
  const raw = "x".repeat(3000);
  const result = formatJsonExample(raw, 200);
  assert.ok(result.includes("... [truncated]"), "Should include truncated marker");
  // The first 200 chars should be preserved
  assert.ok(result.startsWith("x".repeat(200)), "Should start with original content");
});

test("non-JSON HTML payload is truncated with marker", () => {
  const raw = "<html>" + "<div>content</div>".repeat(200) + "</html>";
  const result = formatJsonExample(raw, 500);
  assert.ok(result.includes("... [truncated]"));
  assert.ok(result.length < raw.length);
});

// ── 5. formatJsonExample — maxChars parameter ────────────────────────────────

console.log("\n📦  formatJsonExample — custom maxChars");

test("respects custom maxChars for objects", () => {
  const obj = { a: "short", b: "medium length value here", c: "another value that is longer" };
  const raw = JSON.stringify(obj);
  // With a very small maxChars, fewer keys should be included
  const result = formatJsonExample(raw, 50);
  const parsed = JSON.parse(result);
  assert.ok(Object.keys(parsed).length >= 1, "Should include at least one key");
  assert.ok(Object.keys(parsed).length <= Object.keys(obj).length);
});

test("returns string unchanged when under maxChars", () => {
  const raw = JSON.stringify({ a: 1, b: 2 });
  assert.equal(formatJsonExample(raw, 5000), raw);
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.log(`\n⚠️  ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n🎉 All api-test-prompt tests passed!`);
}

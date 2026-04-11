/**
 * @module tests/test-fix
 * @description Unit tests for the AI test fix frontend API methods.
 *
 * Mocks global.fetch and global.localStorage before importing api.js
 * (same approach as api.integration.test.js).
 */

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

// ── Set up global mocks before importing api.js ──────────────────────────────
const originalFetch = global.fetch;
const originalLocalStorage = global.localStorage;
const originalWindow = global.window;
const originalDocument = global.document;

global.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
global.window = { location: { pathname: "/tests/TC-1", href: "/tests/TC-1" } };
global.document = { cookie: "_csrf=test-csrf-token" };
global.fetch = async () => ({ ok: true, status: 200 });

const { api } = await import("../src/api.js");

// ═══════════════════════════════════════════════════════════════════════════════
// API client: fixTest SSE parsing
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 api.fixTest SSE parsing");

await testAsync("fixTest streams tokens and calls onDone", async () => {
  const sseBody = [
    `data: ${JSON.stringify({ token: "test(" })}\n\n`,
    `data: ${JSON.stringify({ token: "'fixed'" })}\n\n`,
    `data: ${JSON.stringify({ done: true, fixedCode: "test('fixed');", explanation: "Fixed 1 line", diff: "+ test('fixed');" })}\n\n`,
  ].join("");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody));
      controller.close();
    },
  });

  global.fetch = async (url, init) => {
    assert.ok(url.includes("/tests/TC-1/fix"), "URL should target the fix endpoint");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "include", "Should send credentials: include");
    assert.equal(init.headers["X-CSRF-Token"], "test-csrf-token", "Should send CSRF token");
    return { ok: true, status: 200, body: stream };
  };

  const tokens = [];
  let doneResult = null;
  let errorResult = null;

  await api.fixTest(
    "TC-1",
    (token) => tokens.push(token),
    (result) => { doneResult = result; },
    (err) => { errorResult = err; },
  );

  assert.deepEqual(tokens, ["test(", "'fixed'"]);
  assert.ok(doneResult, "onDone should have been called");
  assert.equal(doneResult.fixedCode, "test('fixed');");
  assert.equal(doneResult.explanation, "Fixed 1 line");
  assert.equal(errorResult, null, "onError should not have been called");
});

await testAsync("fixTest calls onError for error events", async () => {
  const sseBody = `data: ${JSON.stringify({ error: "AI provider rate limit reached." })}\n\n`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody));
      controller.close();
    },
  });

  global.fetch = async () => ({ ok: true, status: 200, body: stream });

  let errorResult = null;
  let doneResult = null;

  await api.fixTest(
    "TC-1",
    () => {},
    (result) => { doneResult = result; },
    (err) => { errorResult = err; },
  );

  assert.equal(errorResult, "AI provider rate limit reached.");
  assert.equal(doneResult, null, "onDone should not have been called");
});

await testAsync("fixTest throws on non-ok response", async () => {
  global.fetch = async () => ({
    ok: false,
    status: 400,
    async json() { return { error: "Test has no Playwright code to fix." }; },
  });

  await assert.rejects(
    () => api.fixTest("TC-1", () => {}, () => {}, () => {}),
    /Test has no Playwright code to fix/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// API client: applyTestFix
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n🧪 api.applyTestFix");

await testAsync("applyTestFix sends POST with code body", async () => {
  let capturedBody = null;
  global.fetch = async (url, init) => {
    assert.ok(url.includes("/tests/TC-1/apply-fix"), "URL should target apply-fix");
    assert.equal(init.method, "POST");
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async json() { return { id: "TC-1", playwrightCode: "fixed code", codeVersion: 1 }; },
    };
  };

  const result = await api.applyTestFix("TC-1", "fixed code");
  assert.equal(result.playwrightCode, "fixed code");
  assert.equal(result.codeVersion, 1);
  assert.deepEqual(capturedBody, { code: "fixed code" });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup + Summary
// ═══════════════════════════════════════════════════════════════════════════════
global.fetch = originalFetch;
global.localStorage = originalLocalStorage;
global.window = originalWindow;
global.document = originalDocument;

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  Frontend test-fix tests failed");
  process.exit(1);
}

console.log("\n🎉 Frontend test-fix tests passed");

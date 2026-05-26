import assert from "node:assert/strict";
import test from "node:test";
import { resetDb } from "./helpers/test-base.js";

// `resetDb()` initializes the SQLite singleton + clears prior test rows.
// `playwright.dryRun` itself is pure (no DB read) but the runtime imports
// repos at the top of the module, so an uninitialised DB connection would
// fail at module-load time.
resetDb();

const runtime = await import("../src/aiProvider/agentTools/runtime.js");

test("tool execution: dryRun success shape", async () => {
  // Realistic Playwright snippet so the static validator
  // (`pipeline/testValidator.validateTest`) sees a parseable test body
  // with a recognised action + assertion. A bare `test('x', async()=>{})`
  // would now fail the deep checks the validator performs once acorn
  // parses successfully (no `page.*`, no `expect(...)`).
  const out = await runtime.executeToolCall({
    role: "reviewer",
    tool: "playwright.dryRun",
    args: {
      testCode: "test('hello', async ({ page }) => { await page.goto('https://app.example.test/'); await expect(page).toHaveURL(/example/); });",
    },
    context: { workspaceId: "ws1", threadId: "th1", fromRole: "reviewer", projectUrl: "https://app.example.test/" },
  });
  assert.equal(out.result.ok, true);
  assert.deepEqual(out.result.diagnostics, []);
});

test("tool execution: dryRun rejects malformed code with diagnostics", async () => {
  const out = await runtime.executeToolCall({
    role: "reviewer",
    tool: "playwright.dryRun",
    args: { testCode: "test('broken', async ({ page }) => { await page.clicks('#x') }" }, // typo + unbalanced
    context: { workspaceId: "ws1", threadId: "th1", fromRole: "reviewer" },
  });
  assert.equal(out.result.ok, false);
  assert.ok(Array.isArray(out.result.diagnostics) && out.result.diagnostics.length > 0);
});

test("rate limiter rejects calls past the per-minute cap (gap #5)", async () => {
  // Per-minute cap drops to 3 for this test; the 4th dispatch should
  // throw ERR_AGENT_TOOL_RATE_LIMITED while the first 3 succeed. Reset
  // the in-memory bucket between cases so previous tests don't leak.
  process.env.AGENT_TOOL_RATE_LIMIT_PER_MIN = "3";
  runtime._resetRateLimiterForTests();
  const baseArgs = {
    role: "reviewer",
    tool: "playwright.dryRun",
    args: {
      testCode: "test('hello', async ({ page }) => { await page.goto('https://app.example.test/'); await expect(page).toHaveURL(/example/); });",
    },
    context: { workspaceId: "ws-rate", threadId: "th-rate", runId: "run-rate", fromRole: "reviewer", projectUrl: "https://app.example.test/" },
  };
  for (let i = 0; i < 3; i++) {
    const out = await runtime.executeToolCall(baseArgs);
    assert.equal(out.result.ok, true);
  }
  await assert.rejects(() => runtime.executeToolCall(baseArgs), (err) => {
    assert.equal(err.code, "ERR_AGENT_TOOL_RATE_LIMITED");
    assert.equal(err.limit, 3);
    return true;
  });
  delete process.env.AGENT_TOOL_RATE_LIMIT_PER_MIN;
  runtime._resetRateLimiterForTests();
});

test("aborted signal short-circuits tool dispatch (gap #7)", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runtime.executeToolCall({
    role: "reviewer",
    tool: "playwright.dryRun",
    args: { testCode: "test('x', async ({ page }) => { await page.goto('https://app.example.test/'); });" },
    context: { workspaceId: "ws-abort", fromRole: "reviewer" },
    signal: controller.signal,
  }), (err) => {
    assert.equal(err.name, "AbortError");
    return true;
  });
});

test("redactToolArgsForPersistence scrubs secrets from playwright.dryRun args (gap #8)", () => {
  // Inline an AWS-shaped credential (one of `secretScanner`'s built-in
  // detectors). The redaction must replace `testCode` with a placeholder
  // and stamp `_secretsScrubbed` with the matched rule ids.
  const withSecret = {
    testCode: "test('leak', async () => { const key = 'AKIAIOSFODNN7EXAMPLE'; });",
  };
  const redacted = runtime.redactToolArgsForPersistence("playwright.dryRun", withSecret);
  assert.notEqual(redacted.testCode, withSecret.testCode, "testCode must be scrubbed");
  assert.match(redacted.testCode, /REDACTED/);
  assert.ok(Array.isArray(redacted._secretsScrubbed) && redacted._secretsScrubbed.length > 0);
});

test("redactToolArgsForPersistence passes through clean args unchanged (gap #8)", () => {
  // Negative-path: no secrets → identical object back. Performance +
  // operator-debugging path stays clean for the common case.
  const clean = {
    testCode: "test('ok', async ({ page }) => { await page.goto('https://app.example.test/'); });",
  };
  const out = runtime.redactToolArgsForPersistence("playwright.dryRun", clean);
  assert.equal(out.testCode, clean.testCode);
  assert.equal(out._secretsScrubbed, undefined);
});

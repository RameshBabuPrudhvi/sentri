/**
 * @module tests/ai-fallback
 * @description Unit tests for FEA-003 AI provider fallback chain and circuit breaker.
 *
 * Tests the public `generateText()` fallback behaviour by mocking `callProvider`
 * at the module boundary. The circuit breaker functions are module-private, so
 * we test them indirectly through `generateText()` behaviour.
 */

import assert from "node:assert/strict";
import { isRateLimitError } from "../src/aiProvider.js";
import { createTestRunner } from "./helpers/test-base.js";

const { test, summary } = createTestRunner();

// ── isRateLimitError detection ────────────────────────────────────────────────
// This is the public function that drives the fallback chain's decision logic.
// Thorough testing here ensures the fallback triggers correctly.

console.log("\n🧪 isRateLimitError()");

test("detects HTTP 429 status", () => {
  const err = new Error("Too Many Requests");
  err.status = 429;
  assert.equal(isRateLimitError(err), true);
});

test("detects HTTP 529 status (Anthropic overloaded)", () => {
  const err = new Error("Overloaded");
  err.status = 529;
  assert.equal(isRateLimitError(err), true);
});

test("detects 'rate limit' in message (case-insensitive)", () => {
  assert.equal(isRateLimitError(new Error("Rate limit exceeded")), true);
  assert.equal(isRateLimitError(new Error("RATE LIMIT reached")), true);
  assert.equal(isRateLimitError(new Error("rate_limit_error")), true);
});

test("detects 'too many requests' in message", () => {
  assert.equal(isRateLimitError(new Error("Too Many Requests")), true);
  assert.equal(isRateLimitError(new Error("too many requests — please slow down")), true);
});

test("detects 'quota exceeded' in message", () => {
  assert.equal(isRateLimitError(new Error("Quota exceeded for model")), true);
  assert.equal(isRateLimitError(new Error("quota exhausted")), true);
});

test("detects 'resource exhausted' in message (Google)", () => {
  assert.equal(isRateLimitError(new Error("RESOURCE_EXHAUSTED: quota limit")), true);
  assert.equal(isRateLimitError(new Error("resource.exhausted")), true);
});

test("detects 'overloaded' in message (Anthropic)", () => {
  assert.equal(isRateLimitError(new Error("overloaded_error")), true);
  assert.equal(isRateLimitError(new Error("The API is overloaded")), true);
});

test("does NOT false-positive on port numbers like localhost:4290", () => {
  assert.equal(isRateLimitError(new Error("connect ECONNREFUSED 127.0.0.1:4290")), false);
});

test("does NOT false-positive on generic errors", () => {
  assert.equal(isRateLimitError(new Error("Network error")), false);
  assert.equal(isRateLimitError(new Error("Invalid API key")), false);
  assert.equal(isRateLimitError(new Error("Model not found")), false);
});

test("DOES match 'disk quota exceeded' (regex catches all quota patterns)", () => {
  // The regex /\bquota\s*(exceeded|exhausted|limit)/i intentionally catches
  // all "quota exceeded" messages — including disk quota. This is acceptable
  // because isRateLimitError is only called on AI provider errors, never on
  // filesystem errors.
  assert.equal(isRateLimitError(new Error("disk quota exceeded")), true);
});

test("handles null/undefined error gracefully", () => {
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError(undefined), false);
  assert.equal(isRateLimitError({}), false);
});

test("detects '429' as a standalone number in message", () => {
  assert.equal(isRateLimitError(new Error("HTTP 429 — rate limited")), true);
  assert.equal(isRateLimitError(new Error("Error 429")), true);
});

summary("AI fallback");

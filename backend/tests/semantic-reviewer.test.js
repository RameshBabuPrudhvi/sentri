/**
 * @module tests/semantic-reviewer
 * @description B6 / QAL-005 — semantic-review prompt + response normaliser.
 *
 * The LLM call itself is exercised by the integration suite under stubbed
 * `generateText`; this file pins the pure-function contracts:
 *
 *   • `buildSemanticReviewPrompt` returns the documented `{ system, user }`
 *     envelope shape with the four contract questions embedded verbatim.
 *   • `normalizeSemanticReviewResponse` clamps + defaults bad LLM output
 *     so the consumer never persists a NaN score or an unknown verdict.
 *   • The 5-issue cap is enforced regardless of what the LLM returns.
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import {
  buildSemanticReviewPrompt,
  normalizeSemanticReviewResponse,
  SEMANTIC_REVIEW_MAX_ISSUES,
} from "../src/pipeline/prompts/semanticReviewPrompt.js";

const t = createTestContext();
const { test, summary } = t.createTestRunner();

const sampleTest = {
  id: "T-1",
  name: "User can complete checkout",
  description: "Add an item to cart and complete the purchase flow.",
  sourceUrl: "https://shop.example/checkout",
  playwrightCode:
    "import { test, expect } from '@playwright/test';\n" +
    "test('checkout', async ({ page }) => {\n" +
    "  await page.goto('https://shop.example');\n" +
    "  await page.getByRole('button', { name: 'Buy' }).click();\n" +
    "  await expect(page.getByText('Thank you')).toBeVisible();\n" +
    "});",
};

test("buildSemanticReviewPrompt returns a { system, user } envelope", () => {
  const out = buildSemanticReviewPrompt(sampleTest);
  assert.equal(typeof out.system, "string");
  assert.equal(typeof out.user, "string");
  assert.ok(out.system.length > 0);
  assert.ok(out.user.length > 0);
});

test("user prompt embeds the four contract questions verbatim", () => {
  const { user } = buildSemanticReviewPrompt(sampleTest);
  assert.ok(user.includes("MEANINGFUL state change"));
  assert.ok(user.includes("TRIVIALLY ALWAYS-TRUE"));
  assert.ok(user.includes("FULL described scenario"));
  assert.ok(user.includes("catch a REGRESSION"));
});

test("user prompt includes the test code and source URL", () => {
  const { user } = buildSemanticReviewPrompt(sampleTest);
  assert.ok(user.includes("shop.example/checkout"));
  assert.ok(user.includes("page.getByRole('button',"));
});

test("user prompt truncates oversized playwrightCode", () => {
  const big = { ...sampleTest, playwrightCode: "x".repeat(40_000) };
  const { user } = buildSemanticReviewPrompt(big);
  assert.ok(user.includes("[truncated for semantic review]"));
});

test("normalize clamps score to [0, 100]", () => {
  assert.equal(normalizeSemanticReviewResponse({ score: -50, verdict: "accept" }).score, 0);
  assert.equal(normalizeSemanticReviewResponse({ score: 999, verdict: "accept" }).score, 100);
  assert.equal(normalizeSemanticReviewResponse({ score: 73,  verdict: "revise" }).score, 73);
});

test("normalize derives verdict from score when verdict missing", () => {
  assert.equal(normalizeSemanticReviewResponse({ score: 90 }).verdict, "accept");
  assert.equal(normalizeSemanticReviewResponse({ score: 60 }).verdict, "revise");
  assert.equal(normalizeSemanticReviewResponse({ score: 20 }).verdict, "reject");
});

test("normalize rejects unknown verdict and falls back to score-derived", () => {
  const out = normalizeSemanticReviewResponse({ score: 85, verdict: "lgtm" });
  assert.equal(out.verdict, "accept");
});

test("normalize caps issues array at SEMANTIC_REVIEW_MAX_ISSUES", () => {
  const issues = Array.from({ length: 20 }, (_, i) => `issue ${i}`);
  const out = normalizeSemanticReviewResponse({ score: 60, verdict: "revise", issues });
  assert.equal(out.issues.length, SEMANTIC_REVIEW_MAX_ISSUES);
  assert.equal(out.issues[0], "issue 0");
});

test("normalize truncates per-issue strings at 200 chars", () => {
  const long = "x".repeat(500);
  const out = normalizeSemanticReviewResponse({ score: 60, verdict: "revise", issues: [long] });
  assert.equal(out.issues[0].length, 200);
});

test("normalize drops non-string issues + empty strings", () => {
  const out = normalizeSemanticReviewResponse({
    score: 60, verdict: "revise",
    issues: ["valid", null, "", 42, "another", undefined],
  });
  assert.deepEqual(out.issues, ["valid", "another"]);
});

test("normalize tolerates non-object input without throwing", () => {
  const out = normalizeSemanticReviewResponse(null);
  assert.equal(out.score, 50);
  assert.equal(out.verdict, "revise");
  assert.deepEqual(out.issues, []);
});

test("normalize tolerates array input without throwing", () => {
  const out = normalizeSemanticReviewResponse([1, 2, 3]);
  assert.equal(out.score, 50);
  assert.equal(out.verdict, "revise");
});

await summary("semantic-reviewer");

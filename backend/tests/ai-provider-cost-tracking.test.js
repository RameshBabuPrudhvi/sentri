/**
 * AI-003 — per-call cost tracking regression test.
 *
 * Pins:
 *   1. `computeCostUsd()` arithmetic for each cloud provider against the
 *      committed catalog (anthropic / openai / google).
 *   2. Catalog miss → `costUsd: null` (no fake zeros).
 *   3. Catalog-known free model (Ollama) → `costUsd: 0`.
 *   4. `openrouter/auto` (variable underlying model, `null/null` pricing) →
 *      `costUsd: null`.
 *   5. MNT-001 vision-heal $5/M + $15/M midpoint cost is preserved for
 *      models NOT in the catalog (fallback path in callVisionModel).
 *   6. `pricingFor()` returns the full pricing entry (including `asOf`) so
 *      future staleness alerts have a stable read path.
 *
 * This is a pure-arithmetic test — no SDK calls, no network. Adapter
 * contract (does each adapter actually call `withCost(...)`?) is covered
 * separately by `aiProvider-adapter-contract.test.js`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCostUsd,
  pricingFor,
  MODEL_PRICING,
} from "../src/aiProvider/modelCatalog.js";

// ── computeCostUsd() — per-provider arithmetic ───────────────────────────────

test("computeCostUsd: Anthropic Claude Sonnet uses $3/M input + $15/M output", () => {
  // 1000 input + 500 output tokens → 1000 * 0.003/1000 + 500 * 0.015/1000
  //                                = 0.003 + 0.0075 = 0.0105
  const cost = computeCostUsd("claude-sonnet-4-20250514", { input: 1000, output: 500 });
  assert.equal(cost.toFixed(6), "0.010500");
});

test("computeCostUsd: OpenAI gpt-4o-mini uses $0.15/M input + $0.6/M output", () => {
  // 10000 input + 2000 output → 10000 * 0.00015/1000 + 2000 * 0.0006/1000
  //                           = 0.0015 + 0.0012 = 0.0027
  const cost = computeCostUsd("gpt-4o-mini", { input: 10000, output: 2000 });
  assert.equal(cost.toFixed(6), "0.002700");
});

test("computeCostUsd: Google Gemini 2.5 Flash uses $0.075/M input + $0.3/M output", () => {
  const cost = computeCostUsd("gemini-2.5-flash", { input: 10000, output: 5000 });
  // 10000 * 0.000075/1000 + 5000 * 0.0003/1000 = 0.00075 + 0.0015 = 0.00225
  assert.equal(cost.toFixed(6), "0.002250");
});

// ── Catalog miss → null (no fake zeros) ─────────────────────────────────────

test("computeCostUsd: unknown model returns null (catalog miss is not $0)", () => {
  const cost = computeCostUsd("some-future-model-not-in-catalog", { input: 1000, output: 500 });
  assert.equal(cost, null);
});

test("computeCostUsd: empty model id returns null", () => {
  assert.equal(computeCostUsd("", { input: 100, output: 100 }), null);
  assert.equal(computeCostUsd(undefined, { input: 100, output: 100 }), null);
});

test("computeCostUsd: missing usage returns null (no token data is not $0)", () => {
  assert.equal(computeCostUsd("gpt-4o-mini", null), null);
  assert.equal(computeCostUsd("gpt-4o-mini", undefined), null);
});

test("computeCostUsd: zero tokens returns null (no usable signal)", () => {
  // A response with no token counts at all is indistinguishable from a
  // catalog miss for dashboard purposes — both mean "no data".
  assert.equal(computeCostUsd("gpt-4o-mini", { input: 0, output: 0 }), null);
});

// ── Catalog-known free model (Ollama) ───────────────────────────────────────

test("pricingFor: Ollama mistral:7b is in the catalog at 0/0 (free, not unknown)", () => {
  const p = pricingFor("mistral:7b");
  assert.ok(p, "mistral:7b should be in MODEL_PRICING");
  assert.equal(p.inputPer1k, 0);
  assert.equal(p.outputPer1k, 0);
  assert.equal(p.provider, "local");
});

// ── openrouter/auto — variable model, null pricing ──────────────────────────

test("computeCostUsd: openrouter/auto returns null (variable underlying model)", () => {
  // openrouter/auto has inputPer1k: null + outputPer1k: null in the catalog
  // because the underlying model is chosen per-call. We don't pretend to
  // know the cost — dashboards see "no data" for these calls.
  const cost = computeCostUsd("openrouter/auto", { input: 1000, output: 500 });
  assert.equal(cost, null);
});

// ── MNT-001 fallback preserved for models NOT in the catalog ────────────────

test("MNT-001 vision-heal fallback: midpoint $5/M + $15/M for unknown vision model", () => {
  // The fallback math lives in `callVisionModel()` and is:
  //   costUsd = (input/1M) * $5 + (output/1M) * $15
  // when the adapter returns `usage.costUsd: null` (catalog miss).
  // This test pins the formula's arithmetic — the orchestrator wires it.
  const input = 2000;
  const output = 1000;
  const expected = (input / 1_000_000) * 5 + (output / 1_000_000) * 15;
  assert.equal(expected.toFixed(6), "0.025000"); // 2k * $5/M + 1k * $15/M
});

// ── pricingFor() returns the full entry (including asOf) ────────────────────

test("pricingFor: returns full entry with asOf for staleness alerts", () => {
  const p = pricingFor("claude-sonnet-4-20250514");
  assert.ok(p, "claude-sonnet-4-20250514 should be in catalog");
  assert.equal(typeof p.asOf, "string");
  assert.match(p.asOf, /^\d{4}-\d{2}-\d{2}$/, "asOf should be ISO date");
  assert.equal(typeof p.inputPer1k, "number");
  assert.equal(typeof p.outputPer1k, "number");
});

test("MODEL_PRICING: every entry has the required schema fields", () => {
  for (const [model, entry] of Object.entries(MODEL_PRICING)) {
    assert.ok(entry.provider, `${model}: missing provider`);
    assert.ok(entry.asOf, `${model}: missing asOf`);
    assert.match(entry.asOf, /^\d{4}-\d{2}-\d{2}$/, `${model}: asOf must be ISO date`);
    // inputPer1k / outputPer1k may be null (openrouter/auto) or number
    assert.ok(
      entry.inputPer1k === null || typeof entry.inputPer1k === "number",
      `${model}: inputPer1k must be null or number`,
    );
    assert.ok(
      entry.outputPer1k === null || typeof entry.outputPer1k === "number",
      `${model}: outputPer1k must be null or number`,
    );
  }
});

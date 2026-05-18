/**
 * @module tests/self-healing-vision
 * @description MNT-001 — host-side vision-healing waterfall (stages 7-8).
 *
 * Stub-driven so no real CV / no real network happens in CI. `tryVisionHeal()`
 * takes pixelmatch + LLM deps via the `deps` parameter — dependency-injection
 * test pattern (matches existing convention in the suite).
 *
 * Covered:
 *   - Constants surface (STRATEGY_INDEX_PIXELMATCH/LLM_VISION, frozen array)
 *   - Feature gating (off mode, missing fields, null ctx)
 *   - Stage 7 (pixelmatch): above threshold, below threshold, missing baseline, throws
 *   - Stage 8 (LLM): pixelmatch declines -> LLM, sub-threshold, throws, missing cost
 *   - Budget circuit-breaker (dailyCalls / monthlyCost exhausted, under-cap pass)
 *   - pixelmatch_only mode NEVER invokes LLM even when pixelmatch declines
 */
import assert from "node:assert/strict";
import {
  tryVisionHeal,
  STRATEGY_INDEX_PIXELMATCH,
  STRATEGY_INDEX_LLM_VISION,
  VISION_STRATEGY_INDICES,
} from "../src/selfHealing.js";
import { getDatabase } from "../src/database/sqlite.js";

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => console.log(`  PASS  ${name}`),
        (err) => {
          console.log(`  FAIL  ${name}`);
          console.log(`        ${err.message}`);
          process.exitCode = 1;
        },
      );
    }
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n[MNT-001] host-side vision healing (stages 7-8)");

// Boot the DB so `recordHealing` (called inside tryVisionHeal on success)
// has the healing_history table available. getDatabase() runs migrations
// on first call.
getDatabase();

const SHOT = Buffer.from("fake-png");
const BASELINE = Buffer.from("fake-baseline");

function ctx(overrides = {}) {
  return {
    testId: `vh-${Math.random().toString(36).slice(2)}@v1`,
    action: "click",
    label: "Sign in",
    project: { id: "PRJ-1", visionHealing: "off" },
    failureScreenshot: SHOT,
    baselineCrop: BASELINE,
    ...overrides,
  };
}

// ── Constants surface ────────────────────────────────────────────────────────
test("STRATEGY_INDEX_PIXELMATCH === 7", () => assert.equal(STRATEGY_INDEX_PIXELMATCH, 7));
test("STRATEGY_INDEX_LLM_VISION === 8", () => assert.equal(STRATEGY_INDEX_LLM_VISION, 8));
test("VISION_STRATEGY_INDICES is frozen and lists [7, 8]", () => {
  assert.deepEqual(VISION_STRATEGY_INDICES, [7, 8]);
  assert.ok(Object.isFrozen(VISION_STRATEGY_INDICES));
});

// ── Feature gating ───────────────────────────────────────────────────────────
await test("visionHealing='off' returns null", async () => {
  assert.equal(await tryVisionHeal(ctx()), null);
});

await test("visionHealing missing returns null", async () => {
  assert.equal(await tryVisionHeal(ctx({ project: { id: "P" } })), null);
});

await test("no failureScreenshot returns null", async () => {
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_only" }, failureScreenshot: null }),
    { pixelmatchHeal: async () => ({ confidence: 0.95 }) },
  );
  assert.equal(r, null);
});

await test("null ctx or no project returns null", async () => {
  assert.equal(await tryVisionHeal(null), null);
  assert.equal(await tryVisionHeal({}), null);
});
// ── Stage 7 (pixelmatch) ─────────────────────────────────────────────────────
await test("pixelmatch_only above threshold returns vision_pixelmatch event", async () => {
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_only" } }),
    {
      pixelmatchHeal: async (fail, base, t) => {
        assert.equal(fail, SHOT);
        assert.equal(base, BASELINE);
        assert.equal(t, 0.85);
        return { confidence: 0.92, box: { x: 100, y: 200, width: 80, height: 32 } };
      },
    },
  );
  assert.ok(r);
  assert.equal(r.kind, "vision_pixelmatch");
  assert.equal(r.strategyIndex, STRATEGY_INDEX_PIXELMATCH);
  assert.equal(r.confidence, 0.92);
  assert.equal(r.key, "click::Sign in");
  assert.deepEqual(r.box, { x: 100, y: 200, width: 80, height: 32 });
  assert.equal(r.healed, true);
});

await test("pixelmatch_only below threshold returns null AND LLM never invoked", async () => {
  let llmCalled = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_only" } }),
    {
      pixelmatchHeal: async () => ({ confidence: 0.3 }),
      llmVisionHeal: async () => { llmCalled = true; return { confidence: 1.0 }; },
    },
  );
  assert.equal(r, null);
  assert.equal(llmCalled, false, "pixelmatch_only must never invoke LLM");
});

await test("pixelmatch_only missing baselineCrop skips pixelmatch, returns null", async () => {
  let called = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_only" }, baselineCrop: null }),
    { pixelmatchHeal: async () => { called = true; return { confidence: 1.0 }; } },
  );
  assert.equal(r, null);
  assert.equal(called, false);
});

await test("pixelmatch throws -> swallowed, null in pixelmatch_only mode", async () => {
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_only" } }),
    { pixelmatchHeal: async () => { throw new Error("CV crash"); } },
  );
  assert.equal(r, null);
});
// ── Stage 8 (LLM vision) ─────────────────────────────────────────────────────
await test("pixelmatch_and_llm: pixelmatch declines -> LLM invoked -> vision_llm event", async () => {
  let llmInvoked = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" } }),
    {
      pixelmatchHeal: async () => ({ confidence: 0.4 }),
      llmVisionHeal: async ({ failure, intent }) => {
        llmInvoked = true;
        assert.equal(failure, SHOT);
        assert.equal(intent.action, "click");
        assert.equal(intent.label, "Sign in");
        return {
          confidence: 0.88,
          box: { x: 50, y: 60, width: 70, height: 24 },
          model: "claude-3-5-sonnet-20241022",
          costUsd: 0.0023,
        };
      },
    },
  );
  assert.equal(llmInvoked, true);
  assert.ok(r);
  assert.equal(r.kind, "vision_llm");
  assert.equal(r.strategyIndex, STRATEGY_INDEX_LLM_VISION);
  assert.equal(r.confidence, 0.88);
  assert.equal(r.model, "claude-3-5-sonnet-20241022");
  assert.equal(r.costUsd, 0.0023);
});

await test("pixelmatch_and_llm: LLM below threshold returns null", async () => {
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" } }),
    {
      pixelmatchHeal: async () => ({ confidence: 0.5 }),
      llmVisionHeal: async () => ({ confidence: 0.4, model: "gpt-4o", costUsd: 0.001 }),
    },
  );
  assert.equal(r, null);
});

await test("pixelmatch_and_llm: LLM throws returns null (no rethrow)", async () => {
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" } }),
    {
      pixelmatchHeal: async () => ({ confidence: 0.5 }),
      llmVisionHeal: async () => { throw new Error("LLM rate limit"); },
    },
  );
  assert.equal(r, null);
});

await test("pixelmatch_and_llm: missing costUsd defaults to 0", async () => {
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" }, baselineCrop: null }),
    { llmVisionHeal: async () => ({ confidence: 0.9, model: "gpt-4o" }) },
  );
  assert.ok(r);
  assert.equal(r.costUsd, 0);
});

// ── Budget circuit-breaker ───────────────────────────────────────────────────
await test("budget: dailyCalls exhausted -> stage 8 skipped, returns null", async () => {
  let llmCalled = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" }, baselineCrop: null }),
    {
      isBudgetExhausted: async () => ({ dailyCalls: true, monthlyCost: false }),
      llmVisionHeal: async () => { llmCalled = true; return { confidence: 1.0 }; },
    },
  );
  assert.equal(r, null);
  assert.equal(llmCalled, false, "Stage 8 must skip LLM when daily cap is hit");
});

await test("budget: monthlyCost exhausted -> stage 8 skipped, returns null", async () => {
  let llmCalled = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" }, baselineCrop: null }),
    {
      isBudgetExhausted: async () => ({ dailyCalls: false, monthlyCost: true }),
      llmVisionHeal: async () => { llmCalled = true; return { confidence: 1.0 }; },
    },
  );
  assert.equal(r, null);
  assert.equal(llmCalled, false);
});

await test("budget: under both caps -> stage 8 invoked normally", async () => {
  let llmCalled = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" }, baselineCrop: null }),
    {
      isBudgetExhausted: async () => ({ dailyCalls: false, monthlyCost: false }),
      llmVisionHeal: async () => {
        llmCalled = true;
        return { confidence: 0.9, model: "gpt-4o", costUsd: 0.002 };
      },
    },
  );
  assert.equal(llmCalled, true);
  assert.ok(r);
  assert.equal(r.kind, "vision_llm");
});

await test("budget check throws -> conservative skip (no LLM call)", async () => {
  let llmCalled = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" }, baselineCrop: null }),
    {
      isBudgetExhausted: async () => { throw new Error("budget repo down"); },
      llmVisionHeal: async () => { llmCalled = true; return { confidence: 1.0 }; },
    },
  );
  assert.equal(r, null);
  assert.equal(llmCalled, false, "Budget-check failure must be treated as exhausted");
});

if (process.exitCode) process.exit(1);
console.log("\n[MNT-001] vision healing tests passed");

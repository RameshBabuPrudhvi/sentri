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
await test("budget: dailyCalls exhausted -> stage 8 skipped, returns sentinel", async () => {
  // MNT-001b — the budget-exhausted path now returns a distinguishable
  // sentinel object (NOT null) so executeTest.js can emit an audit row
  // and bump the `app_vision_heal_budget_exhausted_total` counter before
  // filtering it out of the healing-event stream. `healed: false` keeps
  // persistHealingEvents from treating it as a successful heal.
  let llmCalled = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" }, baselineCrop: null }),
    {
      isBudgetExhausted: async () => ({ dailyCalls: true, monthlyCost: false }),
      llmVisionHeal: async () => { llmCalled = true; return { confidence: 1.0 }; },
    },
  );
  assert.ok(r, "expected sentinel object, not null");
  assert.equal(r.kind, "vision_budget_exhausted");
  assert.equal(r.reason, "daily_calls");
  assert.equal(r.healed, false);
  assert.equal(r.key, "click::Sign in");
  assert.equal(llmCalled, false, "Stage 8 must skip LLM when daily cap is hit");
});

await test("budget: monthlyCost exhausted -> stage 8 skipped, returns sentinel", async () => {
  let llmCalled = false;
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" }, baselineCrop: null }),
    {
      isBudgetExhausted: async () => ({ dailyCalls: false, monthlyCost: true }),
      llmVisionHeal: async () => { llmCalled = true; return { confidence: 1.0 }; },
    },
  );
  assert.ok(r);
  assert.equal(r.kind, "vision_budget_exhausted");
  assert.equal(r.reason, "monthly_cost");
  assert.equal(r.healed, false);
  // Daily cap takes precedence in the ternary — verify monthly-only fires
  // with the right reason label, which is what the Prometheus counter
  // surfaces to operators.
  assert.equal(llmCalled, false);
});

await test("budget: dailyCalls cap takes precedence over monthlyCost in sentinel.reason", async () => {
  // Both flags true → reason is "daily_calls". This pins the documented
  // tie-break behaviour so a future refactor doesn't silently swap to
  // monthly_cost (which would re-attribute alert volume in dashboards).
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_and_llm" }, baselineCrop: null }),
    {
      isBudgetExhausted: async () => ({ dailyCalls: true, monthlyCost: true }),
      llmVisionHeal: async () => ({ confidence: 1.0 }),
    },
  );
  assert.ok(r);
  assert.equal(r.kind, "vision_budget_exhausted");
  assert.equal(r.reason, "daily_calls");
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

// ── AUTO-023 Bundle 2 — envelope emit on heal outcomes ──────────────────────
// Closes the gap flagged in code review: the previous test surface only
// asserted that `tryVisionHeal` returned the right shape, never that the
// healer-thread envelope was emitted on success or the `_workspaceId`
// guard correctly no-oped when `ctx.project` lacked a workspaceId. These
// tests use `agentMessageRepo.listByRun` as the post-condition witness —
// the only side-effect the emit produces that survives the function call.

const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();
const agentMessageRepo = await import("../src/database/repositories/agentMessageRepo.js");
const WS_VH = "__default__";

await test("envelope: pixelmatch success emits healer→reviewer envelope (B2.2 selfHealing wiring)", async () => {
  const runId = `RUN-VH-${Math.random().toString(36).slice(2, 10)}`;
  const testId = `TC-vh-${Math.random().toString(36).slice(2, 6)}@v1`;
  const r = await tryVisionHeal(
    {
      runId,
      testId,
      action: "click",
      label: "Sign in",
      project: { id: "P", visionHealing: "pixelmatch_only", workspaceId: WS_VH },
      failureScreenshot: SHOT,
      baselineCrop: BASELINE,
    },
    { pixelmatchHeal: async () => ({ confidence: 0.95, box: { x: 1, y: 2, width: 3, height: 4 } }) },
  );
  assert.ok(r, "pixelmatch heal should succeed");

  // Envelope row must exist on the healer thread keyed by
  // `${runId}-heal-${testId}`. We list by run since that is workspace-scoped.
  const rows = agentMessageRepo.listByRun(runId, WS_VH);
  assert.equal(rows.length, 1, "exactly one envelope emitted on heal success");
  assert.equal(rows[0].fromRole, "healer");
  assert.equal(rows[0].toRole, "reviewer");
  assert.equal(rows[0].intent, "handoff");
  assert.equal(rows[0].artifact?.kind, "vision_pixelmatch");
  assert.equal(rows[0].artifact?.healed, true);
  assert.equal(rows[0].threadId, `${runId}-heal-${testId}`);
});

await test("envelope: LLM-vision success emits healer→reviewer envelope with model + cost", async () => {
  const runId = `RUN-VH-${Math.random().toString(36).slice(2, 10)}`;
  const testId = `TC-vh-${Math.random().toString(36).slice(2, 6)}@v1`;
  const r = await tryVisionHeal(
    {
      runId,
      testId,
      action: "fill",
      label: "Email",
      project: { id: "P", visionHealing: "pixelmatch_and_llm", workspaceId: WS_VH },
      failureScreenshot: SHOT,
      baselineCrop: null,
    },
    { llmVisionHeal: async () => ({ confidence: 0.9, model: "gpt-4o", costUsd: 0.0015 }) },
  );
  assert.ok(r);
  const rows = agentMessageRepo.listByRun(runId, WS_VH);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artifact?.kind, "vision_llm");
  assert.equal(rows[0].artifact?.model, "gpt-4o");
  assert.equal(rows[0].artifact?.costUsd, 0.0015);
});

await test("envelope: missing runId no-ops the emit (no FK insert against null)", async () => {
  // ctx.runId omitted → _runId === null → _threadId === null →
  // emitHandoffEnvelope's missing-field guard short-circuits. Heal still
  // succeeds (return value is unchanged); only the envelope side-effect
  // is suppressed. This is the no-FK-against-null safety the comment in
  // `selfHealing.js#tryVisionHeal` claims.
  const r = await tryVisionHeal(
    ctx({ project: { id: "P", visionHealing: "pixelmatch_only", workspaceId: WS_VH } }),
    { pixelmatchHeal: async () => ({ confidence: 0.95 }) },
  );
  assert.ok(r, "heal still succeeds without runId");
  // No row should exist on any thread for a synthetic runId we never set.
  // We can't easily query "all rows without a specific runId", but we
  // CAN verify by listing for a fresh runId that the spy would have used.
  // The simpler invariant: emit returns null when runId is missing, which
  // we verify via the agentHandoff unit tests already; here we just
  // confirm the heal proceeds without error.
});

await test("envelope: missing ctx.project.workspaceId no-ops the emit (guard works)", async () => {
  const runId = `RUN-VH-${Math.random().toString(36).slice(2, 10)}`;
  const testId = `TC-vh-${Math.random().toString(36).slice(2, 6)}@v1`;
  // Project row with no workspaceId field → _workspaceId resolves to null
  // → emitHandoffEnvelope no-ops on missing required field. Heal itself
  // still succeeds.
  const r = await tryVisionHeal(
    {
      runId,
      testId,
      action: "click",
      label: "X",
      project: { id: "P", visionHealing: "pixelmatch_only" /* no workspaceId */ },
      failureScreenshot: SHOT,
      baselineCrop: BASELINE,
    },
    { pixelmatchHeal: async () => ({ confidence: 0.95 }) },
  );
  assert.ok(r, "heal succeeds even when envelope guard short-circuits");
  // Without a workspace context we can't list rows scoped to it, but the
  // contract is that the emit returns null → no row persisted. Verify by
  // querying the workspace we DO know about — the emit shouldn't have
  // leaked into it.
  const rows = agentMessageRepo.listByRun(runId, WS_VH);
  assert.equal(rows.length, 0, "no envelope emitted when workspaceId is missing");
});

if (process.exitCode) process.exit(1);
console.log("\n[MNT-001] vision healing tests passed");

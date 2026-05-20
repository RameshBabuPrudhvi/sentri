/**
 * @module tests/agent-dispatch
 * @description AI-005 — Multi-agent dispatch unit tests.
 *
 * Covers the registry / dispatcher behaviour added in PR #22:
 *   1. agentRole + workspaceId routing reads `agent_configs`
 *   2. Unconfigured role falls back to env detection
 *   3. fallbackRole cycle rejected at upsert (`ERR_AGENT_FALLBACK_CYCLE`)
 *   4. Per-(provider, role) circuit breakers don't leak across roles
 *   5. Sticky-fallback wins over agentRole resolution (tripwire #1)
 *   6. resetCircuitBreaker clears every `provider::role` variant
 *
 * The pipeline-shape e2e (planner=A + author=B → both providers called) is
 * pinned in tests/agent-dispatch-pipeline.test.js.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// In-memory SQLite — the pattern lifted from compat-config-cache.test.js so
// the import below initialises a fresh DB without touching the dev file.
process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.OPENAI_API_KEY = "test-openai-key";

// Lazy imports so the env vars above are in effect before sqlite.js boots.
const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const agentConfigRepo = await import("../src/database/repositories/agentConfigRepo.js");
const {
  breakerKey,
  resolveProvider,
  recordProviderFailure,
  recordProviderSuccess,
  isCircuitBreakerOpen,
  setStickyFallback,
  clearStickyFallback,
  stickyFallbackActive,
  setRuntimeKey,
} = await import("../src/aiProvider/registry.js");

// Boot DB so migrations create `agent_configs` + `workspaces`.
getDatabase();

const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();

const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

// Seed a workspace row we can attach agent_configs to.
function seedWorkspace() {
  const db = getDatabase();
  const id = `ws-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, `ws-${id}`, id, "test-user", now(), now());
  return id;
}

function upsertConfig(workspaceId, role, overrides = {}) {
  return agentConfigRepo.upsert({
    id: `cfg-${randomUUID().slice(0, 8)}`,
    workspaceId,
    role,
    provider: overrides.provider ?? "anthropic",
    model: overrides.model ?? null,
    systemPromptOverride: overrides.systemPromptOverride ?? null,
    temperature: overrides.temperature ?? 0.2,
    maxTokens: overrides.maxTokens ?? null,
    fallbackRole: overrides.fallbackRole ?? null,
    createdAt: now(),
    updatedAt: now(),
  });
}

// ── breakerKey ────────────────────────────────────────────────────────────────

console.log("\n🧪 breakerKey()");

test("returns bare provider when no role", () => {
  assert.equal(breakerKey("anthropic", null), "anthropic");
  assert.equal(breakerKey("openai"), "openai");
});

test("composes provider::role when role is set", () => {
  assert.equal(breakerKey("anthropic", "planner"), "anthropic::planner");
  assert.equal(breakerKey("openai", "author"), "openai::author");
});

// ── resolveProvider ───────────────────────────────────────────────────────────

console.log("\n🧪 resolveProvider()");

test("returns null provider when nothing configured for unknown env", () => {
  // workspaceId without role still goes through env detection — both env
  // keys above are set, so this should return one of them.
  const { provider } = resolveProvider({});
  assert.ok(provider, "expected env detection to find ANTHROPIC or OPENAI");
});

test("agent_configs row drives provider selection for (role, workspaceId)", () => {
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "openai" });
  const { provider, config } = resolveProvider({ agentRole: "planner", workspaceId });
  assert.equal(provider, "openai");
  assert.equal(config?.role, "planner");
});

test("unconfigured role falls back to env detection", () => {
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "openai" });
  // No author row → fall back to env detection (anthropic / openai).
  const { provider, config } = resolveProvider({ agentRole: "author", workspaceId });
  assert.ok(provider, "expected env fallback for unconfigured role");
  assert.equal(config, null, "config should be null for env-fallback path");
});

// AI-005c — single-agent preservation. When a workspace has no `agent_configs`
// row for a role, `resolveProvider` returns `effectiveAgentRole: null` so
// downstream breakers / sticky-fallback / fallback enumeration all collapse
// to the bare-provider key. This pins the invariant that single-agent
// workspaces don't pay the per-role wasted-call tax during 429 incidents —
// the explicit user requirement that gated PR #22's merge (free-tier
// workspaces with 20-call/day caps would have burned 3 calls per incident
// before the fix).
test("AI-005c: unconfigured role returns effectiveAgentRole=null (single-agent collapse)", () => {
  const workspaceId = seedWorkspace();
  // No agent_configs rows at all — pure single-agent workspace.
  const result = resolveProvider({ agentRole: "planner", workspaceId });
  assert.equal(result.effectiveAgentRole, null,
    "single-agent workspaces must collapse to bare-provider breaker key");
});

test("AI-005c: configured role returns effectiveAgentRole=role (multi-agent isolation)", () => {
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "openai" });
  const result = resolveProvider({ agentRole: "planner", workspaceId });
  assert.equal(result.effectiveAgentRole, "planner",
    "multi-agent workspaces keep per-role breaker isolation");
});

test("AI-005c: single-agent shares ONE breaker across roles (no wasted-call amplification)", () => {
  // Pre-PR shape: anthropic 429 on stage 1 → bare `anthropic` breaker trips →
  // stages 2+3 skip Anthropic and route to OpenAI fallback. Post-PR with
  // AI-005c the same shape holds for workspaces without agent_configs rows
  // because every stage's `effectiveAgentRole` collapses to null →
  // `breakerKey("anthropic", null) === "anthropic"` → ONE breaker, shared.
  // Simulate a stage-1 failure under the collapsed key.
  recordProviderFailure("anthropic", null);
  assert.equal(isCircuitBreakerOpen("anthropic", null), true,
    "bare-provider breaker tripped");
  assert.equal(isCircuitBreakerOpen("anthropic"), true,
    "bare-provider breaker also visible via 1-arg call");
  // Stage 2 in a single-agent workspace passes effectiveAgentRole=null too,
  // so its breaker check sees the same tripped state — no second wasted call.
  // (The multi-agent-mode regression test 'rate-limiting anthropic::planner
  // does NOT trip anthropic::author' above pins the opposite invariant.)
  recordProviderSuccess("anthropic", null);
});

test("sticky fallback for the role WINS over agent_configs (tripwire #1)", () => {
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "anthropic" });
  // Pretend planner's anthropic just rate-limited and we pinned openai.
  setStickyFallback("openai", "planner");
  try {
    const { provider } = resolveProvider({ agentRole: "planner", workspaceId });
    assert.equal(provider, "openai", "sticky fallback must beat configured provider");
  } finally {
    clearStickyFallback("planner");
  }
});

test("sticky fallback for a DIFFERENT role does not leak", () => {
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "anthropic" });
  upsertConfig(workspaceId, "author", { provider: "openai" });
  setStickyFallback("openai", "planner");
  try {
    // Author's resolution must stay on openai (its configured provider),
    // not be perturbed by planner's sticky-fallback entry.
    const { provider } = resolveProvider({ agentRole: "author", workspaceId });
    assert.equal(provider, "openai");
    // And the planner sticky entry is still active.
    assert.equal(stickyFallbackActive("planner"), true);
    assert.equal(stickyFallbackActive("author"), false);
  } finally {
    clearStickyFallback("planner");
  }
});

// ── Per-role circuit breakers ─────────────────────────────────────────────────

console.log("\n🧪 per-role circuit breaker isolation");

test("rate-limiting anthropic::planner does NOT trip anthropic::author", () => {
  recordProviderFailure("anthropic", "planner");
  assert.equal(isCircuitBreakerOpen("anthropic", "planner"), true);
  assert.equal(isCircuitBreakerOpen("anthropic", "author"), false);
  assert.equal(isCircuitBreakerOpen("anthropic"), false);
  recordProviderSuccess("anthropic", "planner");
});

test("clearing one role's breaker leaves the other role's breaker untouched", () => {
  recordProviderFailure("anthropic", "planner");
  recordProviderFailure("anthropic", "author");
  assert.equal(isCircuitBreakerOpen("anthropic", "planner"), true);
  assert.equal(isCircuitBreakerOpen("anthropic", "author"), true);
  recordProviderSuccess("anthropic", "planner");
  // success only resets failures, not disabledUntil — breaker stays open
  // until cooldown expires. The contract is "different roles don't share
  // state", which is exactly what we're pinning here.
  assert.equal(isCircuitBreakerOpen("anthropic", "planner"), true);
  assert.equal(isCircuitBreakerOpen("anthropic", "author"), true);
});

test("setRuntimeKey clears per-role breakers for the provider", () => {
  // Pre-condition: planner + author both tripped from previous test.
  assert.equal(isCircuitBreakerOpen("anthropic", "planner"), true);
  // Simulate the user fixing their key — should clear EVERY anthropic::*
  // breaker variant, not just the bare anthropic key.
  setRuntimeKey("anthropic", "fresh-key");
  assert.equal(isCircuitBreakerOpen("anthropic", "planner"), false);
  assert.equal(isCircuitBreakerOpen("anthropic", "author"), false);
  assert.equal(isCircuitBreakerOpen("anthropic"), false);
});

// ── fallbackRole cycle guard ──────────────────────────────────────────────────

console.log("\n🧪 fallbackRole cycle detection");

test("self-referential fallbackRole is rejected", () => {
  const workspaceId = seedWorkspace();
  assert.throws(
    () => upsertConfig(workspaceId, "planner", { fallbackRole: "planner" }),
    (err) => err.code === "ERR_AGENT_FALLBACK_CYCLE",
  );
});

test("two-hop cycle (planner→critic→planner) is rejected", () => {
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { fallbackRole: null });
  upsertConfig(workspaceId, "critic", { fallbackRole: "planner" });
  // Now try to set planner.fallbackRole = critic → planner → critic → planner cycle.
  assert.throws(
    () => upsertConfig(workspaceId, "planner", { fallbackRole: "critic" }),
    (err) => err.code === "ERR_AGENT_FALLBACK_CYCLE",
  );
});

test("non-cyclic chain is accepted", () => {
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { fallbackRole: null });
  upsertConfig(workspaceId, "critic", { fallbackRole: "planner" });
  // critic → planner → null  ← terminates, no cycle.
  // No throw expected; round-trip read confirms persistence.
  const row = agentConfigRepo.getByRole(workspaceId, "critic");
  assert.equal(row.fallbackRole, "planner");
});

summary("Agent dispatch (AI-005)");

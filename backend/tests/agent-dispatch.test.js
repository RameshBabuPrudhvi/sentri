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
  resolveRoute,
  recordProviderFailure,
  recordProviderSuccess,
  isCircuitBreakerOpen,
  setStickyFallback,
  clearStickyFallback,
  stickyFallbackActive,
  setRuntimeKey,
} = await import("../src/aiProvider/registry.js");
const { AGENT_ROLES, METRIC_AGENT_ROLES } = await import("../src/aiProvider/agentHealthCheck.js");

// Boot DB so migrations create `agent_configs` + `workspaces`.
getDatabase();

const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();

const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

// Seed a workspace row we can attach agent_configs to. The `workspaces`
// table carries a foreign-key constraint on `ownerId` → `users.id` (from
// migration 005_workspaces_rbac.sql), so we must seed a user first or
// SQLite rejects the workspace INSERT with `FOREIGN KEY constraint failed`.
// We insert directly (rather than `registerAndLogin`-style HTTP flow) so
// this unit test doesn't depend on the auth stack — these tests only
// exercise the dispatcher-layer state machine in `registry.js` +
// `agentConfigRepo.js`, and a real workspace row is the minimum schema
// state the FK requires.
function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const wsId = `ws-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(userId, `Test ${userId}`, `${userId}@test.local`, "x", now(), now());
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(wsId, `ws-${wsId}`, wsId, userId, now(), now());
  return wsId;
}

/**
 * Seed an `agent_configs` row pinned to a `provider_routes` row.
 *
 * B2.1 — `agent_configs.provider` + `model` were dropped in migration
 * 048; dispatch now keys on `routeId`. Tests that previously passed
 * `provider: "openai"` to drive a planner toward OpenAI now seed a
 * matching `provider_routes` row and write its id as `routeId`.
 *
 * The helper find-or-creates a route per (workspaceId, family) so
 * multiple `upsertConfig` calls for the same family in one workspace
 * share a single route — mirrors how the real backfill script
 * dedupes, and keeps test setup compact.
 *
 * `family` defaults to `"anthropic"` to match the original
 * `provider: "anthropic"` default. Tests that need a specific
 * family pass `{ family: "openai" }` etc.
 */
function ensureRouteForFamily(workspaceId, family) {
  const db = getDatabase();
  const existing = db.prepare(
    "SELECT id FROM provider_routes WHERE workspaceId = ? AND family = ? LIMIT 1",
  ).get(workspaceId, family);
  if (existing) return existing.id;
  const id = `pr-${randomUUID().slice(0, 8)}`;
  // Protocol mapping mirrors `protocolForProvider.js` — kept inline so
  // this test doesn't take an import dependency on the runtime helper
  // for a one-line lookup.
  const protocol =
    family === "anthropic" ? "anthropic"
    : family === "google" ? "gemini"
    : family === "local" ? "ollama"
    : "openai";
  // `provider_routes.model` is NOT NULL (migration 035). Synthesise a
  // family-shaped placeholder so the INSERT satisfies the constraint —
  // these tests only exercise dispatch resolution, not the model string.
  const model = `test-model-${family}`;
  db.prepare(
    "INSERT INTO provider_routes (id, workspaceId, name, family, protocol, baseUrl, model, " +
    "enabled, cacheEnabled, cacheTtlSec, createdAt, updatedAt) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)",
  ).run(id, workspaceId, `route-${family}-${id.slice(-4)}`, family, protocol, null, model, now(), now());
  return id;
}

function upsertConfig(workspaceId, role, overrides = {}) {
  // `provider`/`model` columns are gone post-048. Tests that pass
  // `{ provider: "openai" }` now produce a routeId pointing at an
  // openai-family `provider_routes` row.
  const family = overrides.provider ?? overrides.family ?? "anthropic";
  const routeId = overrides.routeId ?? ensureRouteForFamily(workspaceId, family);
  return agentConfigRepo.upsert({
    id: `cfg-${randomUUID().slice(0, 8)}`,
    workspaceId,
    role,
    routeId,
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

// ── resolveRoute ──────────────────────────────────────────────────────────────

console.log("\n🧪 resolveRoute()");

test("returns env-detected route when nothing is configured per-role", () => {
  // B2.6 — `resolveProvider` was deleted; `resolveRoute` is the only
  // dispatch-resolution path. With no agentRole / workspaceId pair the
  // route comes from env-detected provider, synthesised as a transient
  // route. Both ANTHROPIC + OPENAI keys are set above, so this should
  // return one of them.
  const { route } = resolveRoute({});
  assert.ok(route, "expected env detection to synthesise a transient route");
  assert.ok(route?.family || route?._transientProvider,
    "transient route must carry provider id via family or _transientProvider");
});

test("agent_configs row drives route selection for (role, workspaceId)", () => {
  // B2.1 — assertion switched from `provider` (post-048 always undefined
  // on the cfg row) to `route.family` (the canonical dispatch target
  // post-migration). The roadmap pins this exact migration in
  // `docs/roadmap/ai-provider-bundle.md:189`.
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "openai" });
  const { route, config } = resolveRoute({ agentRole: "planner", workspaceId });
  assert.equal(route?.family, "openai");
  assert.equal(config?.role, "planner");
});

test("unconfigured role falls back to env detection", () => {
  // B2.6 — `resolveRoute` returns a transient route synthesised from
  // env-detected provider when no agent_configs row exists for the
  // (workspaceId, role). The `config` is null on the env-fallback path
  // — there's no per-role row to carry overrides from.
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "openai" });
  // No author row → fall back to env detection.
  const { route, config } = resolveRoute({ agentRole: "author", workspaceId });
  assert.ok(route, "expected env fallback to synthesise a transient route");
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
  // B2.6 — `resolveRoute` is now the only resolution path. The
  // AI-005c invariant still holds: no agent_configs row → returns
  // `effectiveAgentRole: null` so downstream breakers / sticky /
  // metrics use the bare-discriminator key path.
  const workspaceId = seedWorkspace();
  // No agent_configs rows at all — pure single-agent workspace.
  const result = resolveRoute({ agentRole: "planner", workspaceId });
  assert.equal(result.effectiveAgentRole, null,
    "single-agent workspaces must collapse to bare-discriminator breaker key");
});

test("AI-005c: configured role returns effectiveAgentRole=role (multi-agent isolation)", () => {
  // B2.1 — switched to `resolveRoute` because `resolveProvider`'s
  // multi-agent branch keys on `cfg.provider` which migration 048
  // removed. `resolveRoute` reads `cfg.routeId`, the post-migration
  // canonical multi-agent signal.
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "openai" });
  const result = resolveRoute({ agentRole: "planner", workspaceId });
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
  // Clean up: setRuntimeKey triggers resetCircuitBreaker internally, clearing
  // ALL anthropic::* breaker keys so subsequent tests start clean.
  setRuntimeKey("anthropic", "test-anthropic-key");
});

test("sticky fallback for the role WINS over agent_configs (tripwire #1)", () => {
  // B2.6 — `resolveRoute` carries the sticky-fallback priority. When a
  // sticky entry is pinned, the returned route is a transient route
  // synthesised from the sticky provider, NOT the per-role configured
  // route. Assertion via `route.family` (or `_transientProvider`)
  // because the sticky path produces a synthetic route, not a real one.
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "anthropic" });
  // Pretend planner's anthropic just rate-limited and we pinned openai.
  setStickyFallback("openai", "planner");
  try {
    const { route } = resolveRoute({ agentRole: "planner", workspaceId });
    const stickyProvider = route?._transientProvider || route?.family;
    assert.equal(stickyProvider, "openai", "sticky fallback must beat configured route");
  } finally {
    clearStickyFallback("planner");
  }
});

test("sticky fallback for a DIFFERENT role does not leak", () => {
  // B2.1 — switched to `resolveRoute` for the `route.family` assertion.
  // Post-048 the agent_configs row no longer carries a `provider`
  // column, so `resolveProvider` would fall through to env detection
  // and return whichever key happens to be first in `CLOUD_DETECT_ORDER`
  // — masking the actual contract under test (per-role sticky isolation).
  // `resolveRoute` reads `cfg.routeId` → `provider_routes.family`,
  // which is what the test really intends to pin.
  const workspaceId = seedWorkspace();
  upsertConfig(workspaceId, "planner", { provider: "anthropic" });
  upsertConfig(workspaceId, "author", { provider: "openai" });
  setStickyFallback("openai", "planner");
  try {
    // Author's resolution must stay on openai (its configured route),
    // not be perturbed by planner's sticky-fallback entry.
    const { route } = resolveRoute({ agentRole: "author", workspaceId });
    assert.equal(route?.family, "openai");
    // And the planner sticky entry is still active.
    assert.equal(stickyFallbackActive("planner"), true);
    assert.equal(stickyFallbackActive("author"), false);
  } finally {
    clearStickyFallback("planner");
  }
});

// ── Per-role circuit breakers ─────────────────────────────────────────────────

console.log("\n🧪 per-role circuit breaker isolation");

// Ensure clean breaker state before per-role isolation tests — previous
// tests in this file (AI-005c shared-breaker test) may have left entries
// in the circuitBreakers map. setRuntimeKey triggers resetCircuitBreaker
// which zeros failures + disabledUntil for all anthropic::* keys.
setRuntimeKey("anthropic", "test-anthropic-key");

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

// ── fallbackRole cycle guard (REMOVED in B4.3) ────────────────────────────────
// Migration 053 dropped `agent_configs.fallbackRole`, and the
// `wouldCreateCycle` helper was removed from `agentConfigRepo.js`. The
// canonical per-route fallback now lives on `provider_routes.fallbackRouteId`
// and its cycle protection is pinned by `tests/provider-routes-repo.test.js`
// (`ERR_ROUTE_FALLBACK_CYCLE`). The three role-level cycle tests that lived
// here are intentionally deleted — re-adding them would test dead code.

// ── Canonical-list contracts (the lifeguard-flagged drift fix) ────────────────

console.log("\n🧪 AGENT_ROLES canonical contracts");

test("AGENT_ROLES excludes 'executor' (dead validator entry pre-fix)", () => {
  assert.equal(AGENT_ROLES.includes("executor"), false,
    "'executor' was in settings.js validator pre-AI-005 but no pipeline call site ever passed it");
});

test("AGENT_ROLES excludes 'default' (synthetic metric catch-all, not configurable)", () => {
  assert.equal(AGENT_ROLES.includes("default"), false,
    "'default' is a Prometheus label catch-all emitted by recordAiTokens, not a saveable role");
});

test("AGENT_ROLES contains the 7 canonical pipeline roles", () => {
  const expected = ["explorer", "planner", "author", "oracle", "reviewer", "healer", "triager"];
  for (const role of expected) {
    assert.equal(AGENT_ROLES.includes(role), true, `expected canonical role ${role} in AGENT_ROLES`);
  }
});

test("METRIC_AGENT_ROLES = AGENT_ROLES + 'default' (metric cardinality enumeration)", () => {
  assert.equal(METRIC_AGENT_ROLES.length, AGENT_ROLES.length + 1);
  assert.equal(METRIC_AGENT_ROLES.includes("default"), true);
  for (const role of AGENT_ROLES) {
    assert.equal(METRIC_AGENT_ROLES.includes(role), true);
  }
});

summary("Agent dispatch (AI-005)");

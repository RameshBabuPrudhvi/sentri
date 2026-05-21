/**
 * @module tests/resolve-route
 * @description B1.6 — resolveRoute priority chain + transient-route shim.
 *
 * Pins:
 *   1. Priority chain — sticky > routeId > provider-column shim > env default.
 *   2. AI-005c collapse — no agent_configs row → effectiveAgentRole=null.
 *   3. Configured row with routeId → real provider_routes row.
 *   4. Configured row with provider only → synthetic transient route.
 *   5. Disabled / deleted target route → returns `route: null` (no silent shim).
 *   6. `breakerDiscriminator` strips `provider:` prefix on transient routes.
 *   7. Real routes pass through `breakerDiscriminator` unchanged.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.DB_PATH = ":memory:";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.SENTRI_MASTER_KEY = Buffer.alloc(32, "R").toString("base64");
const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const agentConfigRepo = await import("../src/database/repositories/agentConfigRepo.js");
const providerRouteRepo = await import("../src/database/repositories/providerRouteRepo.js");
const {
  resolveRoute,
  breakerDiscriminator,
  setStickyFallback,
  clearStickyFallback,
} = await import("../src/aiProvider/registry.js");
getDatabase();
const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();
function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const wsId = `ws-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(userId, `T${userId}`, `${userId}@t.local`, "x", now(), now());
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(wsId, `ws-${wsId}`, wsId, userId, now(), now());
  return wsId;
}
function upsertAgent(workspaceId, role, overrides = {}) {
  return agentConfigRepo.upsert({
    id: `cfg-${randomUUID().slice(0, 8)}`,
    workspaceId,
    role,
    provider: overrides.provider ?? null,
    routeId: overrides.routeId ?? null,
    model: overrides.model ?? null,
    systemPromptOverride: null,
    temperature: 0.2,
    maxTokens: null,
    fallbackRole: null,
    createdAt: now(),
    updatedAt: now(),
  });
}
function makeRoute(workspaceId, overrides = {}) {
  return providerRouteRepo.upsert({
    workspaceId,
    name: overrides.name || `r-${randomUUID().slice(0, 8)}`,
    family: overrides.family || "anthropic",
    protocol: overrides.protocol || "anthropic",
    model: overrides.model || "claude-3-5-sonnet",
    enabled: overrides.enabled ?? 1,
  });
}
console.log("\n🧪 resolveRoute priority chain");
test("(2) agent_configs.routeId → real provider_routes row", () => {
  const ws = seedWorkspace();
  const route = makeRoute(ws, { name: "prod-anth" });
  upsertAgent(ws, "planner", { routeId: route.id });
  const { route: got, effectiveAgentRole } = resolveRoute({ agentRole: "planner", workspaceId: ws });
  assert.equal(got.id, route.id);
  assert.equal(got.name, "prod-anth");
  assert.equal(got._transient, undefined, "real routes have no _transient marker");
  assert.equal(effectiveAgentRole, "planner");
});
test("(3) provider-column shim → synthetic transient route", () => {
  const ws = seedWorkspace();
  upsertAgent(ws, "author", { provider: "anthropic" });
  const { route, effectiveAgentRole } = resolveRoute({ agentRole: "author", workspaceId: ws });
  assert.equal(route._transient, true, "shim path yields a transient route");
  assert.equal(route._transientProvider, "anthropic");
  assert.equal(route.protocol, "anthropic");
  assert.equal(route.id, "provider:anthropic");
  assert.equal(effectiveAgentRole, "author");
});
test("(3) provider=openai shim → protocol=openai", () => {
  const ws = seedWorkspace();
  upsertAgent(ws, "explorer", { provider: "openai", model: "gpt-4o-mini" });
  const { route } = resolveRoute({ agentRole: "explorer", workspaceId: ws });
  assert.equal(route.protocol, "openai");
  assert.equal(route.model, "gpt-4o-mini");
});
test("(3) provider=google shim → protocol=gemini", () => {
  const ws = seedWorkspace();
  // Need a google key for isProviderUsable to pass.
  process.env.GOOGLE_API_KEY = "test-google-key";
  upsertAgent(ws, "explorer", { provider: "google" });
  const { route } = resolveRoute({ agentRole: "explorer", workspaceId: ws });
  assert.equal(route.protocol, "gemini");
  delete process.env.GOOGLE_API_KEY;
});
test("(4) no agent_configs row → AI-005c collapse (effectiveAgentRole=null)", () => {
  const ws = seedWorkspace();
  const { route, effectiveAgentRole, config } = resolveRoute({ agentRole: "planner", workspaceId: ws });
  // No agent_configs row exists → AI-005c contract: collapse to bare-
  // provider breaker namespace via effectiveAgentRole=null. Route is
  // still synthesised from the workspace-default provider so the
  // dispatch hot path still has a route to fire against.
  assert.equal(effectiveAgentRole, null, "single-agent workspaces must collapse to null");
  assert.equal(config, null, "no config row found");
  assert.ok(route, "transient route synthesised from env default");
  assert.equal(route._transient, true);
});
test("(2) disabled target route → returns route:null (NOT silent shim)", () => {
  const ws = seedWorkspace();
  const route = makeRoute(ws, { name: "disabled", enabled: 0 });
  upsertAgent(ws, "planner", { routeId: route.id, provider: "anthropic" });
  const result = resolveRoute({ agentRole: "planner", workspaceId: ws });
  // The spec contract: an explicit routeId pointing at a disabled row
  // surfaces as `route: null` so the caller can render a config error
  // to the user. Silently falling back to the provider-column shim
  // would hide the misconfiguration.
  assert.equal(result.route, null, "disabled route MUST NOT silently fall back to shim");
  assert.equal(result.config.role, "planner", "config still returned so UI can render the bad routeId");
});
console.log("\n🧪 sticky-fallback priority");
test("(1) sticky fallback for the role wins over agent_configs", () => {
  const ws = seedWorkspace();
  upsertAgent(ws, "planner", { provider: "anthropic" });
  setStickyFallback("openai", "planner");
  try {
    const { route } = resolveRoute({ agentRole: "planner", workspaceId: ws });
    // Sticky-fallback for openai must beat the configured anthropic.
    // Result is a transient route synthesised from the sticky entry.
    assert.equal(route._transientProvider, "openai");
    assert.equal(route.protocol, "openai");
  } finally {
    clearStickyFallback("planner");
  }
});
test("(1) sticky for a DIFFERENT role does not leak", () => {
  const ws = seedWorkspace();
  upsertAgent(ws, "planner", { provider: "anthropic" });
  upsertAgent(ws, "author", { provider: "openai" });
  setStickyFallback("openai", "planner");
  try {
    // author resolution must use its own configured provider, not be
    // perturbed by planner's sticky-fallback.
    const { route } = resolveRoute({ agentRole: "author", workspaceId: ws });
    assert.equal(route._transientProvider, "openai", "author's own config wins");
    // and the planner sticky is still active
    const planner = resolveRoute({ agentRole: "planner", workspaceId: ws });
    assert.equal(planner.route._transientProvider, "openai", "planner sticky still active");
  } finally {
    clearStickyFallback("planner");
  }
});
console.log("\n🧪 breakerDiscriminator (the breaker-namespace fix)");
test("transient route collapses to bare provider id", () => {
  // The whole point of breakerDiscriminator: a synthetic provider:anthropic
  // route must produce the same breaker key as the legacy AI-005 path so
  // single-agent workspaces don't see their breaker state reset on B2 deploy.
  const ws = seedWorkspace();
  upsertAgent(ws, "planner", { provider: "anthropic" });
  const { route } = resolveRoute({ agentRole: "planner", workspaceId: ws });
  assert.equal(breakerDiscriminator(route), "anthropic",
    "transient routes MUST collapse to the legacy bare-provider key");
});
test("real route id passes through unchanged", () => {
  const ws = seedWorkspace();
  const route = makeRoute(ws);
  upsertAgent(ws, "planner", { routeId: route.id });
  const { route: resolved } = resolveRoute({ agentRole: "planner", workspaceId: ws });
  assert.equal(breakerDiscriminator(resolved), route.id,
    "real route ids (pr-...) must be used as-is so per-route isolation holds");
  assert.ok(route.id.startsWith("pr-"));
});
test("null route yields 'unknown' (defensive)", () => {
  assert.equal(breakerDiscriminator(null), "unknown");
  assert.equal(breakerDiscriminator(undefined), "unknown");
  assert.equal(breakerDiscriminator({}), "unknown");
});
summary("Resolve route (B1.6)");

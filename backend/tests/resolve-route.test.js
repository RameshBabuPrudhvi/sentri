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
  // Note: migrations 048 + 053 dropped `provider`, `model`, and
  // `fallbackRole` from agent_configs. The repo's MUTABLE_FIELDS silently
  // ignores them now — kept in overrides only so the legacy sticky-fallback
  // tests below stay readable (they want to express "this role used to be
  // pinned to provider X" even though the column no longer persists).
  return agentConfigRepo.upsert({
    id: `cfg-${randomUUID().slice(0, 8)}`,
    workspaceId,
    role,
    routeId: overrides.routeId ?? null,
    systemPromptOverride: null,
    temperature: 0.2,
    maxTokens: null,
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
// Migration 048 dropped `agent_configs.provider` + `model`, so the
// pre-existing "provider-column shim" path (set `cfg.provider` →
// `resolveRoute` reads it and synthesises a transient route) no longer
// exists at the schema level. `agentConfigRepo.upsert` silently drops
// the `provider` / `model` keys post-048 because they aren't in
// MUTABLE_FIELDS, and `resolveRoute` reads `cfg.routeId` exclusively.
//
// The post-048 equivalent is: an admin assigns a routeId pointing at
// a `provider_routes` row of the matching family. The tests below
// preserve the original intent (verifying that a role's configured
// dispatch family produces the right `protocol` + `model` on the
// resolved route) but use the canonical post-migration shape — a
// real provider_routes row instead of the dropped column.
test("(3) routeId → protocol=openai + model preserved", () => {
  const ws = seedWorkspace();
  const route = makeRoute(ws, { family: "openai", protocol: "openai", model: "gpt-4o-mini" });
  upsertAgent(ws, "explorer", { routeId: route.id });
  const { route: got } = resolveRoute({ agentRole: "explorer", workspaceId: ws });
  assert.equal(got.protocol, "openai");
  assert.equal(got.model, "gpt-4o-mini");
});
test("(3) routeId → protocol=gemini for family=google", () => {
  const ws = seedWorkspace();
  // No env-key check needed on the route-driven path —
  // `isProviderUsable` only gates env-detection fallbacks. A real
  // `provider_routes` row carries its own (encrypted) key on the
  // row, so the family is dispatch-usable regardless of env vars.
  const route = makeRoute(ws, { family: "google", protocol: "gemini", model: "gemini-1.5-pro" });
  upsertAgent(ws, "explorer", { routeId: route.id });
  const { route: got } = resolveRoute({ agentRole: "explorer", workspaceId: ws });
  assert.equal(got.protocol, "gemini");
  assert.equal(got.family, "google");
});
test("(4) no agent_configs row + no workspace default → env-detection fallback", () => {
  const ws = seedWorkspace();
  const { route, effectiveAgentRole, config } = resolveRoute({ agentRole: "planner", workspaceId: ws });
  // No agent_configs row AND no provider_routes row pinned as
  // `isWorkspaceDefault` (Migration 059) → fall through to env
  // detection. AI-005c contract: collapse to bare-provider breaker
  // namespace via effectiveAgentRole=null. Route is still synthesised
  // so the dispatch hot path has something to fire against.
  assert.equal(effectiveAgentRole, null, "single-agent workspaces must collapse to null");
  assert.equal(config, null, "no config row found");
  assert.ok(route, "transient route synthesised from env default");
  assert.equal(route._transient, true);
});
test("(2) disabled target route → returns route:null (NOT silent shim)", () => {
  const ws = seedWorkspace();
  const route = makeRoute(ws, { name: "disabled", enabled: 0 });
  upsertAgent(ws, "planner", { routeId: route.id });
  const result = resolveRoute({ agentRole: "planner", workspaceId: ws });
  // The spec contract: an explicit routeId pointing at a disabled row
  // surfaces as `route: null` so the caller can render a config error
  // to the user. Silently falling back to env detection would hide
  // the misconfiguration.
  assert.equal(result.route, null, "disabled route MUST NOT silently fall back");
  assert.equal(result.config.role, "planner", "config still returned so UI can render the bad routeId");
});
console.log("\n🧪 sticky-fallback priority");
test("(1) sticky fallback for the role wins over env-detection", () => {
  const ws = seedWorkspace();
  // agent_configs row exists for `planner` but has no routeId, so dispatch
  // would normally fall through to workspace default → env detection.
  // The sticky-fallback pin for "openai" must override the env fallback.
  upsertAgent(ws, "planner");
  setStickyFallback("openai", "planner");
  try {
    const { route } = resolveRoute({ agentRole: "planner", workspaceId: ws });
    assert.equal(route._transientProvider, "openai");
    assert.equal(route.protocol, "openai");
  } finally {
    clearStickyFallback("planner");
  }
});
test("(1) sticky for a DIFFERENT role does not leak", () => {
  const ws = seedWorkspace();
  upsertAgent(ws, "planner");
  upsertAgent(ws, "author");
  setStickyFallback("openai", "planner");
  try {
    // author resolution must use its own env-detection fallback, not be
    // perturbed by planner's sticky-fallback. Both env keys are set in
    // the test header (ANTHROPIC_API_KEY first in CLOUD_DETECT_ORDER),
    // so author lands on anthropic via env detection — provided the
    // `detectProvider({ agentRole: null })` sticky-leak fix is in place.
    const { route } = resolveRoute({ agentRole: "author", workspaceId: ws });
    assert.equal(route._transientProvider, "anthropic", "author falls to env detection, NOT to planner's sticky");
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
  // No agent_configs row → falls to env detection → anthropic (first in
  // CLOUD_DETECT_ORDER with a key set in the test header).
  const ws = seedWorkspace();
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

/**
 * @module tests/provider-routes
 * @description B1.3 — providerRouteRepo unit tests.
 *
 * Pins:
 *   1. CRUD round-trips through the safe SELECT (secret blobs omitted).
 *   2. JSON columns (capabilities, pricing) parse on read.
 *   3. `fallbackRouteId` cycle rejected → `ERR_ROUTE_FALLBACK_CYCLE`.
 *   4. Every mutation emits a `provider_route_audit` row.
 *   5. Idempotent saves don't pollute the audit log.
 *   6. `rotate_key` metadata carries lastFour only, never ciphertext.
 *   7. `remove()` nulls sibling `fallbackRouteId` references in one tx.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = Buffer.alloc(32, "test").toString("base64");
const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const providerRouteRepo = await import("../src/database/repositories/providerRouteRepo.js");
const auditRepo = await import("../src/database/repositories/providerRouteAuditRepo.js");
getDatabase();
const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();
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
  return { wsId, userId };
}
function insertRoute(workspaceId, overrides = {}) {
  return providerRouteRepo.upsert({
    workspaceId,
    name: overrides.name || `route-${randomUUID().slice(0, 8)}`,
    family: overrides.family || "anthropic",
    protocol: overrides.protocol || "anthropic",
    model: overrides.model || "claude-3-5-sonnet",
    baseUrl: overrides.baseUrl,
    capabilities: overrides.capabilities,
    pricing: overrides.pricing,
    fallbackRouteId: overrides.fallbackRouteId ?? null,
    enabled: overrides.enabled ?? 1,
    userId: overrides.userId || null,
  });
}
console.log("\n🧪 providerRouteRepo CRUD");
test("insert + getById round-trip preserves columns", () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId, { name: "anthropic-prod", model: "claude-3-opus" });
  const got = providerRouteRepo.getById(wsId, row.id);
  assert.equal(got.name, "anthropic-prod");
  assert.equal(got.model, "claude-3-opus");
  assert.equal(got.family, "anthropic");
  assert.equal(got.enabled, 1);
});
test("getById is workspace-scoped (cross-workspace returns undefined)", () => {
  const { wsId: wsA } = seedWorkspace();
  const { wsId: wsB } = seedWorkspace();
  const row = insertRoute(wsA);
  assert.ok(providerRouteRepo.getById(wsA, row.id));
  assert.equal(providerRouteRepo.getById(wsB, row.id), undefined);
});
test("getByName resolves single-row via UNIQUE(workspaceId, name)", () => {
  const { wsId } = seedWorkspace();
  insertRoute(wsId, { name: "ollama-local" });
  const got = providerRouteRepo.getByName(wsId, "ollama-local");
  assert.equal(got?.name, "ollama-local");
});
test("listByFamily filters correctly", () => {
  const { wsId } = seedWorkspace();
  insertRoute(wsId, { family: "anthropic" });
  insertRoute(wsId, { family: "openai", protocol: "openai" });
  insertRoute(wsId, { family: "anthropic" });
  const anth = providerRouteRepo.listByFamily(wsId, "anthropic");
  assert.equal(anth.length, 2);
  for (const r of anth) assert.equal(r.family, "anthropic");
});
test("default SELECT omits secret blob columns", () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  assert.equal("apiKeyEncrypted" in row, false);
  assert.equal("apiKeyNonce" in row, false);
  assert.equal("apiKeyLastFour" in row, true);
});
console.log("\n🧪 JSON column round-trip");
test("capabilities + pricing serialise on write, parse on read", () => {
  const { wsId } = seedWorkspace();
  const caps = { vision: true, jsonMode: true };
  const pricing = { inputPerMtok: 3, outputPerMtok: 15, currency: "USD" };
  const row = insertRoute(wsId, { capabilities: caps, pricing });
  const got = providerRouteRepo.getById(wsId, row.id);
  assert.deepEqual(got.capabilities, caps);
  assert.deepEqual(got.pricing, pricing);
});
test("null JSON columns stay null on read", () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  const got = providerRouteRepo.getById(wsId, row.id);
  assert.equal(got.capabilities, null);
  assert.equal(got.pricing, null);
});
console.log("\n🧪 fallbackRouteId cycle detection");
test("self-referential fallbackRouteId is rejected", () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  assert.throws(
    () => providerRouteRepo.upsert({ id: row.id, workspaceId: wsId, fallbackRouteId: row.id }),
    (err) => err.code === "ERR_ROUTE_FALLBACK_CYCLE",
  );
});
test("two-hop cycle (A→B→A) is rejected at upsert", () => {
  const { wsId } = seedWorkspace();
  const a = insertRoute(wsId, { name: "A" });
  const b = insertRoute(wsId, { name: "B", fallbackRouteId: a.id });
  assert.throws(
    () => providerRouteRepo.upsert({ id: a.id, workspaceId: wsId, fallbackRouteId: b.id }),
    (err) => err.code === "ERR_ROUTE_FALLBACK_CYCLE",
  );
});
test("non-cyclic chain is accepted", () => {
  const { wsId } = seedWorkspace();
  const a = insertRoute(wsId, { name: "A" });
  const b = insertRoute(wsId, { name: "B", fallbackRouteId: a.id });
  const c = insertRoute(wsId, { name: "C", fallbackRouteId: b.id });
  assert.equal(providerRouteRepo.getById(wsId, c.id).fallbackRouteId, b.id);
});
console.log("\n🧪 audit log emission");
test("insert emits action=create with name/family/protocol/model", () => {
  const { wsId, userId } = seedWorkspace();
  const row = insertRoute(wsId, { name: "audit-create", userId });
  const log = auditRepo.list(wsId, { routeId: row.id });
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "create");
  assert.equal(log[0].userId, userId);
  const meta = JSON.parse(log[0].metadata);
  assert.equal(meta.name, "audit-create");
  assert.equal(meta.family, "anthropic");
});
test("update emits action=update with metadata.changed", () => {
  const { wsId, userId } = seedWorkspace();
  const row = insertRoute(wsId, { name: "audit-update", userId });
  providerRouteRepo.upsert({ id: row.id, workspaceId: wsId, userId, model: "claude-3-opus" });
  const log = auditRepo.list(wsId, { routeId: row.id });
  assert.equal(log[0].action, "update");
  const meta = JSON.parse(log[0].metadata);
  assert.deepEqual(meta.changed, ["model"]);
});
test("idempotent save (no diff) emits NO audit row", () => {
  const { wsId, userId } = seedWorkspace();
  const row = insertRoute(wsId, { name: "audit-noop", userId });
  providerRouteRepo.upsert({ id: row.id, workspaceId: wsId, userId, model: row.model });
  const log = auditRepo.list(wsId, { routeId: row.id });
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "create");
});
test("changing apiKeyEncrypted emits rotate_key with lastFour only", () => {
  const { wsId, userId } = seedWorkspace();
  const row = insertRoute(wsId, { name: "audit-rotate", userId });
  providerRouteRepo.upsert({
    id: row.id, workspaceId: wsId, userId,
    apiKeyEncrypted: Buffer.from("ciphertext-bytes-deadbeef"),
    apiKeyNonce: Buffer.from("nonce-12-byte"),
    apiKeyLastFour: "abcd",
  });
  const log = auditRepo.list(wsId, { routeId: row.id });
  assert.equal(log[0].action, "rotate_key");
  const meta = JSON.parse(log[0].metadata);
  assert.equal(meta.lastFour, "abcd");
  // Critical: ciphertext / nonce must NEVER appear in the audit row.
  assert.equal("apiKeyEncrypted" in meta, false);
  assert.equal("apiKeyNonce" in meta, false);
  assert.equal("ciphertext" in meta, false);
});
console.log("\n🧪 remove() — fallback unlink + audit");
test("remove() nulls sibling fallbackRouteId references in one tx", () => {
  const { wsId, userId } = seedWorkspace();
  const target = insertRoute(wsId, { name: "TARGET", userId });
  const child = insertRoute(wsId, { name: "CHILD", userId, fallbackRouteId: target.id });
  const out = providerRouteRepo.remove(wsId, target.id, { userId });
  assert.equal(out.deleted, 1);
  assert.equal(out.fallbacksCleared, 1);
  assert.equal(providerRouteRepo.getById(wsId, child.id).fallbackRouteId, null);
  const log = auditRepo.list(wsId, { routeId: target.id });
  assert.equal(log[0].action, "delete");
  const meta = JSON.parse(log[0].metadata);
  assert.equal(meta.name, "TARGET");
});
test("remove() of non-existent route is a no-op (no audit row)", () => {
  const { wsId, userId } = seedWorkspace();
  const out = providerRouteRepo.remove(wsId, "pr-does-not-exist", { userId });
  assert.equal(out.deleted, 0);
  assert.equal(out.fallbacksCleared, 0);
  const log = auditRepo.list(wsId, { routeId: "pr-does-not-exist" });
  assert.equal(log.length, 0);
});
summary("Provider routes (B1.3)");

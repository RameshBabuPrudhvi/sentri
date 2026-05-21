/**
 * @module tests/compat-migration
 * @description B3.11 — Verifies the compat-to-routes.js migration script
 *   converts every compat:<id> slot into a provider_routes row with
 *   family="custom", protocol="openai", keys re-encrypted.
 */
import assert from "node:assert/strict";
process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");
const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const apiKeyRepo = await import("../src/database/repositories/apiKeyRepo.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
const { runMigration } = await import("../src/database/migrations/scripts/compat-to-routes.js");
getDatabase();
ensureDefaultWorkspaces();
const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

/**
 * Clean up ALL compat slots + migrated routes between tests so each
 * test starts from a known-empty state. Without this, compat slots
 * accumulate across tests (the `:memory:` DB is shared) and
 * `runMigration` counts all of them — making `stats.created` return
 * the cumulative total instead of the per-test count.
 */
function resetCompatState() {
  const db = getDatabase();
  try { db.exec("DELETE FROM api_keys WHERE provider LIKE 'compat:%'"); } catch { /* table may not exist */ }
  try { db.exec("DELETE FROM provider_routes WHERE name LIKE 'compat-%'"); } catch { /* table may not exist */ }
  try { db.exec("DELETE FROM provider_route_audit"); } catch { /* table may not exist */ }
}

function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${Math.random().toString(36).slice(2, 10)}`;
  const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`;
  const t = now();
  db.prepare("INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)").run(userId, "Test", `${userId}@test.local`, "x", t, t);
  db.prepare("INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)").run(wsId, `ws-${wsId}`, wsId, userId, t, t);
  return wsId;
}
test("compat slot migrates to provider_routes with family=custom, protocol=openai", () => {
  resetCompatState();
  const wsId = seedWorkspace();
  apiKeyRepo.setCompatSlot("compat:testllm", {
    apiKey: "fake-compat-key-aaaaaaaaa1234",
    baseUrl: "https://llm.example.com/v1",
    model: "test-model-1",
  });
  const stats = runMigration({ workspaceId: wsId });
  assert.equal(stats.created, 1);
  const db = getDatabase();
  const route = db.prepare("SELECT * FROM provider_routes WHERE workspaceId = ? AND name LIKE 'compat-%'").get(wsId);
  assert.ok(route, "migrated route must exist");
  assert.equal(route.family, "custom");
  assert.equal(route.protocol, "openai");
  assert.equal(route.model, "test-model-1");
  assert.equal(route.baseUrl, "https://llm.example.com/v1");
  assert.equal(route.apiKeyLastFour, "1234");
  assert.ok(route.apiKeyEncrypted, "key must be encrypted");
});
test("re-run is idempotent (skips existing)", () => {
  resetCompatState();
  const wsId = seedWorkspace();
  apiKeyRepo.setCompatSlot("compat:idempotent", {
    apiKey: "fake-compat-key-bbbbbbbbb5678",
    baseUrl: "https://llm2.example.com/v1",
    model: "test-model-2",
  });
  const first = runMigration({ workspaceId: wsId });
  assert.equal(first.created, 1);
  const second = runMigration({ workspaceId: wsId });
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);
  assert.equal(second.skippedReasons.exists, 1);
});
test("dry-run commits nothing", () => {
  resetCompatState();
  const wsId = seedWorkspace();
  apiKeyRepo.setCompatSlot("compat:dryrun", {
    apiKey: "fake-compat-key-ccccccccc9012",
    baseUrl: "https://llm3.example.com/v1",
    model: "test-model-3",
  });
  const db = getDatabase();
  const before = db.prepare("SELECT COUNT(*) AS n FROM provider_routes WHERE workspaceId = ?").get(wsId).n;
  const stats = runMigration({ workspaceId: wsId, dryRun: true });
  assert.equal(stats.dryRun, true);
  assert.equal(stats.created, 1);
  const after = db.prepare("SELECT COUNT(*) AS n FROM provider_routes WHERE workspaceId = ?").get(wsId).n;
  assert.equal(after, before, "dry-run must not persist any rows");
});
test("incomplete slot (missing apiKey/baseUrl/model) is skipped", () => {
  resetCompatState();
  const wsId = seedWorkspace();
  apiKeyRepo.setCompatSlot("compat:incomplete", {
    apiKey: "",
    baseUrl: "",
    model: "",
  });
  const stats = runMigration({ workspaceId: wsId });
  assert.equal(stats.created, 0);
  assert.equal(stats.skippedReasons.incomplete_config, 1);
});
summary("Compat migration (B3.11)");

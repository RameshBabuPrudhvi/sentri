/**
 * @module tests/migration-rollback
 * @description B2.1 — Round-trip rollback test for migration 048
 *   (`drop legacy provider+model columns from agent_configs`).
 *
 * The roadmap's risk register (`docs/roadmap/ai-provider-bundle.md:431`)
 * gates Bundle 2 on a "rollback test passes" check. We can't add a
 * `down.sql` convention to `migrationRunner.js` in this PR (that's a
 * separate architectural change), so the rollback is performed via
 * raw SQL inside the test — exactly the migration 048 forward
 * statement reversed by `ADD COLUMN`. The test pins the contract that
 * the four preserved columns (`systemPromptOverride`, `temperature`,
 * `maxTokens`, `fallbackRole`) plus `routeId` survive the round-trip
 * byte-for-byte, while the two dropped columns (`provider`, `model`)
 * legitimately come back NULL — that's the documented Bundle 2
 * breaking change, not data loss.
 *
 * ## What "no data loss" means here
 *
 * Pre-migration row:
 *   { id, workspaceId, role, provider, model, systemPromptOverride,
 *     temperature, maxTokens, fallbackRole, routeId, createdAt, updatedAt }
 *
 * Post-migration row (forward):
 *   { id, workspaceId, role, systemPromptOverride, temperature,
 *     maxTokens, fallbackRole, routeId, createdAt, updatedAt }
 *
 * Post-rollback row (reverse via raw SQL):
 *   Same columns as pre-migration, but `provider` + `model` are NULL.
 *   Operators are expected to re-derive those values from the linked
 *   `provider_routes` row (the whole point of the migration).
 *
 * The contract being tested: every NON-DROPPED column round-trips
 * with its original value. Anything else would be data corruption.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DB_PATH = ":memory:";

const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");

getDatabase();
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();

const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

/**
 * Migration 048 has already run when the in-memory DB booted (the
 * runner walks every migration in order). Re-add the dropped columns
 * so we can simulate the pre-048 state, seed a row, then drop them
 * again to simulate the forward migration applying.
 */
function reAddLegacyColumns() {
  const db = getDatabase();
  db.exec("ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS provider TEXT");
  db.exec("ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS model TEXT");
}

function applyForwardMigration048() {
  const db = getDatabase();
  // Same statements as `migrations/048_agent_configs_drop_legacy_provider_columns.sql`.
  db.exec("ALTER TABLE agent_configs DROP COLUMN IF EXISTS provider");
  db.exec("ALTER TABLE agent_configs DROP COLUMN IF EXISTS model");
}

function applyRollback048() {
  // The reverse of forward — exactly two ADD COLUMN statements. We
  // can't recover the dropped values (SQLite/Postgres truly delete
  // them when DROP COLUMN runs), so the rolled-back columns come back
  // as NULL. The test's contract is "every column we DIDN'T drop
  // round-trips byte-for-byte"; the two dropped ones legitimately
  // come back blank.
  const db = getDatabase();
  db.exec("ALTER TABLE agent_configs ADD COLUMN provider TEXT");
  db.exec("ALTER TABLE agent_configs ADD COLUMN model TEXT");
}

function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const wsId = `ws-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, `Test ${userId}`, `${userId}@test.local`, "x", now(), now());
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(wsId, `ws-${wsId}`, wsId, userId, now(), now());
  return wsId;
}

function seedRoute(workspaceId) {
  const db = getDatabase();
  const id = `pr-${randomUUID().slice(0, 8)}`;
  const t = now();
  db.prepare(
    "INSERT INTO provider_routes (id, workspaceId, name, family, protocol, baseUrl, model, " +
    "enabled, cacheEnabled, cacheTtlSec, createdAt, updatedAt) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)",
  ).run(id, workspaceId, `route-${id}`, "anthropic", "anthropic", null, "claude-3-5-sonnet", t, t);
  return id;
}
// ── 1. Round-trip preserves every non-dropped column ─────────────────────────
test("migration 048 round-trip preserves routeId + 4 retained columns", () => {
  // 1. Reconstitute pre-048 schema and seed a row that exercises every
  //    column the migration touches or claims to preserve.
  reAddLegacyColumns();
  const wsId = seedWorkspace();
  const routeId = seedRoute(wsId);
  const db = getDatabase();
  const cfgId = `cfg-${randomUUID().slice(0, 8)}`;
  const createdAt = "2024-01-01T00:00:00.000Z";
  const updatedAt = "2024-01-02T00:00:00.000Z";
  db.prepare(
    "INSERT INTO agent_configs (id, workspaceId, role, provider, model, " +
    "systemPromptOverride, temperature, maxTokens, fallbackRole, routeId, createdAt, updatedAt) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    cfgId, wsId, "planner",
    "anthropic", "claude-3-5-sonnet",
    "You are a planner.", 0.42, 8192, "author",
    routeId, createdAt, updatedAt,
  );

  // 2. Snapshot every column we expect to survive (everything except
  //    `provider` + `model`).
  const before = db.prepare(
    "SELECT id, workspaceId, role, systemPromptOverride, temperature, maxTokens, fallbackRole, routeId, createdAt, updatedAt " +
    "FROM agent_configs WHERE id = ?",
  ).get(cfgId);

  // 3. Apply forward migration (simulates `migrationRunner` running 048).
  applyForwardMigration048();

  // The dropped columns no longer exist — confirm by introspection.
  const colsAfterForward = db.prepare("PRAGMA table_info(agent_configs)").all().map((c) => c.name);
  assert.equal(colsAfterForward.includes("provider"), false, "provider must be dropped");
  assert.equal(colsAfterForward.includes("model"), false, "model must be dropped");

  // The retained values must still be readable mid-cycle (i.e.
  // dropping `provider`/`model` didn't perturb the other columns).
  const mid = db.prepare(
    "SELECT id, workspaceId, role, systemPromptOverride, temperature, maxTokens, fallbackRole, routeId, createdAt, updatedAt " +
    "FROM agent_configs WHERE id = ?",
  ).get(cfgId);
  assert.deepStrictEqual(mid, before, "forward migration must not perturb retained columns");

  // 4. Apply rollback.
  applyRollback048();

  // Schema is back to pre-048 shape.
  const colsAfterRollback = db.prepare("PRAGMA table_info(agent_configs)").all().map((c) => c.name);
  assert.equal(colsAfterRollback.includes("provider"), true, "provider re-added by rollback");
  assert.equal(colsAfterRollback.includes("model"), true, "model re-added by rollback");

  // Every NON-DROPPED column round-trips byte-for-byte.
  const after = db.prepare(
    "SELECT id, workspaceId, role, systemPromptOverride, temperature, maxTokens, fallbackRole, routeId, createdAt, updatedAt " +
    "FROM agent_configs WHERE id = ?",
  ).get(cfgId);
  assert.deepStrictEqual(after, before, "round-trip must preserve every non-dropped column");

  // The two dropped columns legitimately come back NULL — DROP COLUMN
  // truly deletes data on both SQLite and Postgres. This is the
  // documented breaking change, not a regression. Operators are
  // expected to read `provider` + `model` from the linked
  // `provider_routes` row instead.
  const dropped = db.prepare("SELECT provider, model FROM agent_configs WHERE id = ?").get(cfgId);
  assert.equal(dropped.provider, null);
  assert.equal(dropped.model, null);
});

// ── 2. Forward migration is idempotent (re-running with IF EXISTS) ────────────
test("migration 048 forward is idempotent — re-run is a no-op", () => {
  // Schema is currently rolled-back state from previous test (columns present).
  // Apply forward once.
  applyForwardMigration048();
  // Apply forward AGAIN — must not throw thanks to `IF EXISTS`.
  // Wrap in assert.doesNotThrow for explicit signal in the test runner.
  assert.doesNotThrow(() => applyForwardMigration048(),
    "forward migration must be idempotent on re-run");

  // Restore for any subsequent test.
  applyRollback048();
});

// ── 3. Routes table is FK-target untouched by the migration ───────────────────
test("provider_routes rows survive the round-trip unchanged", () => {
  // The `routeId` FK target on `agent_configs.routeId` references
  // `provider_routes(id) ON DELETE SET NULL`. The drop-column
  // migration must not perturb the FK target rows.
  const wsId = seedWorkspace();
  const routeId = seedRoute(wsId);
  const db = getDatabase();

  const before = db.prepare(
    "SELECT id, workspaceId, name, family, protocol, model FROM provider_routes WHERE id = ?",
  ).get(routeId);

  applyForwardMigration048();
  applyRollback048();

  const after = db.prepare(
    "SELECT id, workspaceId, name, family, protocol, model FROM provider_routes WHERE id = ?",
  ).get(routeId);
  assert.deepStrictEqual(after, before, "provider_routes rows must be untouched by 048 round-trip");
});

summary("Migration 048 rollback (B2.1)");

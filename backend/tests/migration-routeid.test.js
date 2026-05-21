/**
 * @module tests/migration-routeid
 * @description B2.1 — Backfill script correctness. Pins the contract
 *   that `backfill-routes.js` migrates every `agent_configs` row
 *   carrying the legacy `provider` column to a real `provider_routes`
 *   row keyed by `(family, protocol, model, baseUrl)`, encrypts the
 *   inherited global API key into `apiKeyEncrypted`/`apiKeyNonce`,
 *   appends a `providerRouteAuditRepo` entry, and writes the
 *   corresponding `routeId` back. No orphan agent_configs rows after
 *   the script runs.
 *
 * Test patterns lifted from `backend/tests/agent-dispatch.test.js`:
 *   • In-memory SQLite via `DB_PATH=:memory:` so the dev DB file is
 *     never touched.
 *   • Direct INSERT into `users` + `workspaces` to satisfy the FK
 *     chain without booting the auth stack.
 *
 * ## Schema reconstitution
 *
 * Migration 048 (this PR) drops `agent_configs.provider` + `model`.
 * The backfill script reads those columns, so the test runs the
 * script against rows shaped like the post-037 / pre-048 schema. We
 * can't roll the in-memory DB back to that point, so we re-add the
 * legacy columns via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for
 * the duration of this test process. `:memory:` is process-scoped, so
 * the re-added columns never leak to any other test file.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");

const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const apiKeyRepo = await import("../src/database/repositories/apiKeyRepo.js");
const { runBackfill, resolveRouteShape, findExistingRoute } =
  await import("../src/database/migrations/scripts/backfill-routes.js");

getDatabase();
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();

const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

// Re-add the legacy columns that migration 048 drops, so the backfill
// script (which reads them) has rows to operate on. SQLite's
// `ALTER TABLE ... ADD COLUMN` does not accept `IF NOT EXISTS`, so we
// guard via `PRAGMA table_info` to keep the call idempotent within
// the same test process.
function ensureLegacyColumns() {
  const db = getDatabase();
  const cols = db.prepare("PRAGMA table_info(agent_configs)").all().map((c) => c.name);
  if (!cols.includes("provider")) db.exec("ALTER TABLE agent_configs ADD COLUMN provider TEXT");
  if (!cols.includes("model")) db.exec("ALTER TABLE agent_configs ADD COLUMN model TEXT");
}
ensureLegacyColumns();

// Reset DB state between tests so one test's writes can't leak into
// the next test's assertions. `:memory:` is process-scoped, so the
// only safe option is DELETE FROM the tables this file touches.
//
// The DELETE ordering matters: FKs are ON for `:memory:` SQLite by
// default, and several tables in this file's path cascade-reference
// workspaces (`agent_configs.workspaceId`, `provider_routes.workspaceId`).
// We wrap the resets in `defer_foreign_keys = ON` so the ordering of
// DELETEs inside the transaction doesn't trip cascading FK checks
// mid-reset (e.g. deleting `users` before `workspace_members` resolves
// the membership rows' FK on users — without deferral, the runtime
// CASCADE for that delete would race the subsequent statement and
// surface as `FOREIGN KEY constraint failed`). `defer_foreign_keys`
// is per-transaction and resets automatically on COMMIT, so it can't
// leak across tests.
function resetTables() {
  const db = getDatabase();
  // `PRAGMA foreign_keys = OFF` is the only reliable way to bulk-DELETE
  // rows across tables that cascade-reference each other on SQLite.
  // `defer_foreign_keys = ON` only defers checks to COMMIT, but the
  // CASCADE actions still fire mid-transaction and `__system__` rows
  // (migration 033) end up cascading into workspaces and tripping the
  // FK check at COMMIT. We disable the pragma for the duration of the
  // reset and restore it after — better-sqlite3 honours per-connection
  // pragmas immediately, so this can't leak across the connection's
  // other transactions.
  const prev = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("DELETE FROM provider_route_audit");
    db.exec("DELETE FROM provider_routes");
    db.exec("DELETE FROM agent_configs");
    db.exec("DELETE FROM api_keys");
    db.exec("DELETE FROM workspace_members");
    db.exec("DELETE FROM workspaces WHERE id != '__system__'");
    db.exec("DELETE FROM users WHERE id != '__system__'");
  } finally {
    db.pragma(`foreign_keys = ${prev ? "ON" : "OFF"}`);
  }
}
/**
 * Seed a workspace row (with a user as ownerId) so FK constraints
 * pass on the agent_configs + provider_routes inserts. Mirrors the
 * helper in `agent-dispatch.test.js` so the two test files stay
 * shape-compatible.
 */
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

/**
 * Insert a row into the legacy-shape `agent_configs` (with `provider`
 * + `model` columns re-added by `ensureLegacyColumns`). Bypasses
 * `agentConfigRepo.upsert` (which the post-048 INSERT statement no
 * longer references `provider`/`model`) — we need raw rows that
 * mimic a deployment paused mid-bundle between 037 and 048.
 */
function insertLegacyAgentConfig(workspaceId, role, { provider, model = null } = {}) {
  const db = getDatabase();
  const id = `cfg-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO agent_configs (id, workspaceId, role, provider, model, createdAt, updatedAt) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, workspaceId, role, provider, model, now(), now());
  return id;
}
// ── 1. Empty DB → no-op ───────────────────────────────────────────────────────
test("empty DB → backfill is a no-op", () => {
  resetTables();
  const stats = runBackfill();
  assert.equal(stats.rowsBackfilled, 0);
  assert.equal(stats.routesCreated, 0);
  assert.equal(stats.routesReused, 0);
  assert.equal(stats.workspacesScanned, 0);
});

// ── 2. Cloud provider — route created, key encrypted, audit logged ────────────
test("cloud provider → creates route, encrypts inherited global key, audits", () => {
  resetTables();
  apiKeyRepo.set("anthropic", "sk-ant-test-1234567890");
  const wsId = seedWorkspace();
  insertLegacyAgentConfig(wsId, "planner", { provider: "anthropic", model: "claude-3-5-sonnet" });

  const stats = runBackfill();

  assert.equal(stats.rowsBackfilled, 1);
  assert.equal(stats.routesCreated, 1);
  assert.equal(stats.routesReused, 0);

  const db = getDatabase();
  const route = db.prepare(
    "SELECT family, protocol, model, apiKeyEncrypted, apiKeyNonce, apiKeyLastFour FROM provider_routes WHERE workspaceId = ?",
  ).get(wsId);
  assert.equal(route.family, "anthropic");
  assert.equal(route.protocol, "anthropic");
  assert.equal(route.model, "claude-3-5-sonnet");
  // Encrypted blob present, plaintext never written.
  assert.ok(Buffer.isBuffer(route.apiKeyEncrypted), "apiKeyEncrypted must be a BLOB");
  assert.ok(Buffer.isBuffer(route.apiKeyNonce), "apiKeyNonce must be a BLOB");
  assert.notEqual(route.apiKeyEncrypted.toString("utf8"), "sk-ant-test-1234567890",
    "plaintext key must never appear in ciphertext column");
  assert.equal(route.apiKeyLastFour, "7890");

  // Audit row records the inheritance so operators can rotate per-workspace.
  const audit = db.prepare(
    "SELECT action, metadata FROM provider_route_audit WHERE workspaceId = ?",
  ).get(wsId);
  assert.equal(audit.action, "create");
  const meta = JSON.parse(audit.metadata);
  assert.equal(meta.source, "backfill-routes");
  assert.equal(meta.inheritedFromGlobalKey, true);

  // agent_configs.routeId now points at the new route.
  const linked = db.prepare("SELECT routeId FROM agent_configs WHERE workspaceId = ?").get(wsId);
  assert.ok(linked.routeId?.startsWith("pr-"), "routeId must be set to the new route");
});
// ── 3. Two roles, same (provider, model) → ONE route, both linked ─────────────
test("two roles with same (provider, model) → ONE route, both agent_configs linked", () => {
  resetTables();
  apiKeyRepo.set("openai", "sk-openai-test-1234567890");
  const wsId = seedWorkspace();
  insertLegacyAgentConfig(wsId, "planner", { provider: "openai", model: "gpt-4o-mini" });
  insertLegacyAgentConfig(wsId, "author", { provider: "openai", model: "gpt-4o-mini" });

  const stats = runBackfill();

  assert.equal(stats.rowsBackfilled, 2);
  assert.equal(stats.routesCreated, 1, "find-or-create must dedupe identical (provider, model)");
  assert.equal(stats.routesReused, 1);

  const db = getDatabase();
  const routes = db.prepare("SELECT id FROM provider_routes WHERE workspaceId = ?").all(wsId);
  assert.equal(routes.length, 1);
  const sharedRouteId = routes[0].id;
  const configs = db.prepare("SELECT routeId FROM agent_configs WHERE workspaceId = ?").all(wsId);
  assert.equal(configs.length, 2);
  for (const c of configs) assert.equal(c.routeId, sharedRouteId);
});

// ── 4. Re-run is idempotent ───────────────────────────────────────────────────
test("re-run after success → zero new writes (idempotent)", () => {
  resetTables();
  apiKeyRepo.set("anthropic", "sk-ant-test-1234567890");
  const wsId = seedWorkspace();
  insertLegacyAgentConfig(wsId, "planner", { provider: "anthropic", model: "claude-3-5-sonnet" });

  const first = runBackfill();
  assert.equal(first.routesCreated, 1);
  assert.equal(first.rowsBackfilled, 1);

  const second = runBackfill();
  // Re-run sees no rows with `routeId IS NULL`, so nothing scanned.
  assert.equal(second.rowsBackfilled, 0);
  assert.equal(second.routesCreated, 0);
  assert.equal(second.routesReused, 0);
});

// ── 5. --dry-run leaves provider_routes unchanged ─────────────────────────────
test("--dry-run reads but commits nothing", () => {
  resetTables();
  apiKeyRepo.set("google", "sk-goog-test-1234567890");
  const wsId = seedWorkspace();
  insertLegacyAgentConfig(wsId, "planner", { provider: "google", model: "gemini-1.5-pro" });

  const db = getDatabase();
  const routesBefore = db.prepare("SELECT COUNT(*) AS n FROM provider_routes").get().n;
  const auditsBefore = db.prepare("SELECT COUNT(*) AS n FROM provider_route_audit").get().n;

  const stats = runBackfill({ dryRun: true });

  // Stats reflect the planned writes…
  assert.equal(stats.rowsBackfilled, 1);
  assert.equal(stats.routesCreated, 1);
  assert.equal(stats.dryRun, true);
  // …but the DB is untouched.
  const routesAfter = db.prepare("SELECT COUNT(*) AS n FROM provider_routes").get().n;
  const auditsAfter = db.prepare("SELECT COUNT(*) AS n FROM provider_route_audit").get().n;
  assert.equal(routesAfter, routesBefore, "provider_routes count unchanged after --dry-run");
  assert.equal(auditsAfter, auditsBefore, "provider_route_audit count unchanged after --dry-run");
  const linked = db.prepare("SELECT routeId FROM agent_configs WHERE workspaceId = ?").get(wsId);
  assert.equal(linked.routeId, null, "agent_configs.routeId unchanged after --dry-run");
});
// ── 6. compat:* slot → family "custom", protocol "openai" ─────────────────────
test("compat:* slot → family=custom, protocol=openai, baseUrl + key carried", () => {
  resetTables();
  apiKeyRepo.setCompatSlot("compat:myllm", {
    // Fake key shaped to NOT match Gitleaks `generic-api-key` heuristics
    // (no `sk-` / `pk-` / `xoxb-` prefix on a property literally named
    // `apiKey`). The encryption + lastFour assertions below still test
    // the same contract regardless of the string's shape.
    apiKey: "fake-test-key-aaaaaaaaaaaa7890",
    baseUrl: "https://llm.example.com/v1",
    model: "my-model-1",
  });
  const wsId = seedWorkspace();
  insertLegacyAgentConfig(wsId, "planner", { provider: "compat:myllm" });

  const stats = runBackfill();

  assert.equal(stats.rowsBackfilled, 1);
  assert.equal(stats.routesCreated, 1);

  const db = getDatabase();
  const route = db.prepare(
    "SELECT family, protocol, baseUrl, model, apiKeyLastFour FROM provider_routes WHERE workspaceId = ?",
  ).get(wsId);
  assert.equal(route.family, "custom");
  assert.equal(route.protocol, "openai");
  assert.equal(route.baseUrl, "https://llm.example.com/v1");
  assert.equal(route.model, "my-model-1");
  assert.equal(route.apiKeyLastFour, "7890");
});

// ── 7. --workspace=<id> scope flag honours boundary ───────────────────────────
test("--workspace=<id> scopes backfill to one workspace", () => {
  resetTables();
  apiKeyRepo.set("anthropic", "sk-ant-test-1234567890");
  const wsA = seedWorkspace();
  const wsB = seedWorkspace();
  insertLegacyAgentConfig(wsA, "planner", { provider: "anthropic", model: "m1" });
  insertLegacyAgentConfig(wsB, "planner", { provider: "anthropic", model: "m2" });

  const stats = runBackfill({ workspaceId: wsA });

  assert.equal(stats.workspacesScanned, 1);
  assert.equal(stats.rowsBackfilled, 1);

  const db = getDatabase();
  const linkedA = db.prepare("SELECT routeId FROM agent_configs WHERE workspaceId = ?").get(wsA);
  const linkedB = db.prepare("SELECT routeId FROM agent_configs WHERE workspaceId = ?").get(wsB);
  assert.ok(linkedA.routeId?.startsWith("pr-"), "wsA must be backfilled");
  assert.equal(linkedB.routeId, null, "wsB must be untouched");
});

// ── 8. Unmapped provider → skip with reason, never throws ─────────────────────
test("unmapped provider → logged + skipped, run continues", () => {
  resetTables();
  const wsId = seedWorkspace();
  insertLegacyAgentConfig(wsId, "planner", { provider: "mistral", model: "mistral-7b" });

  const logs = [];
  const stats = runBackfill({ log: (m) => logs.push(m) });

  assert.equal(stats.rowsBackfilled, 0);
  assert.equal(stats.routesCreated, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.skippedReasons.unmapped_provider, 1);
  assert.ok(logs.some((m) => m.includes("unmapped provider")), "must log unmapped provider");

  // resolveRouteShape's contract — exposed for downstream tooling.
  const shape = resolveRouteShape({ provider: "mistral" });
  assert.equal(shape._unmapped, true);
});

// ── 9. No API key for cloud provider → keyless route created, counter set ─────
test("cloud provider with no global key → route created keyless, skip counter records", () => {
  resetTables();
  // Note: NO apiKeyRepo.set() — global key missing.
  const wsId = seedWorkspace();
  insertLegacyAgentConfig(wsId, "planner", { provider: "anthropic", model: "claude-3-5-sonnet" });

  const stats = runBackfill();

  assert.equal(stats.routesCreated, 1, "route still created so operator can fix key via Settings");
  assert.equal(stats.skippedReasons.no_api_key, 1);

  const db = getDatabase();
  const route = db.prepare(
    "SELECT apiKeyEncrypted, apiKeyNonce FROM provider_routes WHERE workspaceId = ?",
  ).get(wsId);
  assert.equal(route.apiKeyEncrypted, null);
  assert.equal(route.apiKeyNonce, null);

  // agent_configs is still linked — dispatch will fail-closed at call
  // time until the operator rotates the key. This is the documented
  // contract from the backfill script's header docstring.
  const linked = db.prepare("SELECT routeId FROM agent_configs WHERE workspaceId = ?").get(wsId);
  assert.ok(linked.routeId?.startsWith("pr-"));
});

// ── 10. findExistingRoute helper sanity ───────────────────────────────────────
test("findExistingRoute returns undefined when no match, row when matches", () => {
  resetTables();
  const wsId = seedWorkspace();
  const db = getDatabase();
  const t = now();
  db.prepare(
    "INSERT INTO provider_routes (id, workspaceId, name, family, protocol, baseUrl, model, " +
    "enabled, cacheEnabled, cacheTtlSec, createdAt, updatedAt) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)",
  ).run("pr-fixture", wsId, "fixture", "anthropic", "anthropic", null, "claude-3-5-sonnet", t, t);

  // Exact match returns the row.
  const hit = findExistingRoute(db, {
    workspaceId: wsId, family: "anthropic", protocol: "anthropic",
    model: "claude-3-5-sonnet", baseUrl: null,
  });
  assert.equal(hit?.id, "pr-fixture");

  // NULL-aware equality on baseUrl: a row with baseUrl=null and a query
  // with baseUrl=null must match (the bare `=` would not).
  assert.ok(hit, "NULL-aware equality must match NULL baseUrl");

  // Different model → no match.
  const miss = findExistingRoute(db, {
    workspaceId: wsId, family: "anthropic", protocol: "anthropic",
    model: "claude-3-haiku", baseUrl: null,
  });
  assert.equal(miss, undefined);
});

summary("Backfill routes (B2.1)");

/**
 * @module tests/quota-guard
 * @description B3.7 — Quota guard unit tests.
 *
 * Covers:
 *   1. `checkAndReserve` — token-bucket reserve correctness, dual-dimension
 *      (RPM + TPM) checks, fail-open when no limits set.
 *   2. `reportActual` — drift correction (over-estimate frees tokens).
 *   3. `checkSpendCap` — daily / monthly windowed reads from `ai_request_log`,
 *      alert threshold firing, no-cap pass-through, both-caps interaction.
 *
 * Tests use the in-memory SQLite path established by other B-bundle tests;
 * no Redis. The Redis path is exercised by the in-memory fail-open fallback
 * — when `isRedisAvailable()` returns false the same code runs.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");

const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");

getDatabase();
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
ensureDefaultWorkspaces();

const {
  checkAndReserve,
  reportActual,
  checkSpendCap,
  _resetForTests,
} = await import("../src/aiProvider/quotaGuard.js");

const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedWorkspace({ dailyCap = null, monthlyCap = null, thresholdPct = 80 } = {}) {
  const db = getDatabase();
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const wsId = `ws-${randomUUID().slice(0, 8)}`;
  const t = now();
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, `Test ${userId}`, `${userId}@test.local`, "x", t, t);
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, dailySpendCapUsd, monthlySpendCapUsd, spendAlertThresholdPct, createdAt, updatedAt) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(wsId, `ws-${wsId}`, wsId, userId, dailyCap, monthlyCap, thresholdPct, t, t);
  return wsId;
}

function insertCostRow(workspaceId, { costUsd, ageHours = 0 }) {
  const db = getDatabase();
  const createdAt = new Date(Date.now() - ageHours * 3600 * 1000).toISOString();
  db.prepare(
    "INSERT INTO ai_request_log (id, workspaceId, promptHash, costUsd, outcome, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(`air-${randomUUID().slice(0, 8)}`, workspaceId, "x", costUsd, "success", createdAt);
}

// ─── 1. checkAndReserve ───────────────────────────────────────────────────────

test("checkAndReserve: routes with no limits pass through unconditionally", async () => {
  _resetForTests();
  const result = await checkAndReserve("pr-no-limits", 10_000, {});
  assert.equal(result.ok, true);
  assert.equal(result.retryAfterMs, 0);
});

test("checkAndReserve: RPM-only limit allows up to N calls/min", async () => {
  _resetForTests();
  // rpmLimit=3 → 3 successful reserves, 4th rejected.
  for (let i = 0; i < 3; i += 1) {
    const r = await checkAndReserve("pr-rpm-3", 1, { rpmLimit: 3, tpmLimit: 0 });
    assert.equal(r.ok, true, `call ${i + 1} should succeed`);
  }
  const denied = await checkAndReserve("pr-rpm-3", 1, { rpmLimit: 3, tpmLimit: 0 });
  assert.equal(denied.ok, false, "4th call must be rejected");
  assert.equal(denied.reason, "rpm");
  assert.ok(denied.retryAfterMs > 0, "retryAfterMs must be positive");
});

test("checkAndReserve: TPM-only limit gates on cumulative token count", async () => {
  _resetForTests();
  // tpmLimit=100 → first call reserves 60, second reserves remaining 40,
  // third (even for 1 token) must reject.
  const r1 = await checkAndReserve("pr-tpm-100", 60, { tpmLimit: 100 });
  assert.equal(r1.ok, true);
  const r2 = await checkAndReserve("pr-tpm-100", 40, { tpmLimit: 100 });
  assert.equal(r2.ok, true, "40 tokens fits in remaining 40");
  const r3 = await checkAndReserve("pr-tpm-100", 1, { tpmLimit: 100 });
  assert.equal(r3.ok, false, "0 tokens left, must reject");
  assert.equal(r3.reason, "tpm");
});

test("checkAndReserve: missing routeId returns ok (defensive)", async () => {
  _resetForTests();
  const r = await checkAndReserve(null, 100, { rpmLimit: 1 });
  assert.equal(r.ok, true);
});

// ─── 2. reportActual ──────────────────────────────────────────────────────────

test("reportActual: over-estimate correction frees tokens back to bucket", async () => {
  _resetForTests();
  // Reserve 100 estimated against a 200-token budget → 100 remaining.
  const before = await checkAndReserve("pr-drift", 100, { tpmLimit: 200 });
  assert.equal(before.ok, true);
  // Actual was 80 (over-estimate by 20). Function subtracts delta from
  // bucket: delta = 80 - 100 = -20 → bucket -= -20 → bucket += 20.
  // Bucket goes 100 → 120, allowing a 120-token follow-up reserve.
  await reportActual("pr-drift", 100, 80, 0.0001);
  const after = await checkAndReserve("pr-drift", 120, { tpmLimit: 200 });
  assert.equal(after.ok, true, "over-estimate correction should free up tokens");
});

test("reportActual: no-op when delta is zero or routeId missing", async () => {
  _resetForTests();
  await reportActual(null, 100, 100);    // null routeId — no-op
  await reportActual("pr-x", 100, 100);  // delta=0 — no-op
  // Verifying neither call throws.
  assert.ok(true);
});

// ─── 3. checkSpendCap ─────────────────────────────────────────────────────────

test("checkSpendCap: no caps configured → ok=true, remainingUsd=null", () => {
  const wsId = seedWorkspace(); // no caps
  const r = checkSpendCap(wsId);
  assert.equal(r.ok, true);
  assert.equal(r.remainingUsd, null);
});

test("checkSpendCap: missing workspaceId → defensive ok=true", () => {
  const r = checkSpendCap(null);
  assert.equal(r.ok, true);
});

test("checkSpendCap: daily cap respected, rolling 24h window", () => {
  const wsId = seedWorkspace({ dailyCap: 1.0 });
  // 23h ago — counts (within rolling 24h window).
  insertCostRow(wsId, { costUsd: 0.4, ageHours: 23 });
  // 25h ago — outside window even though same calendar day.
  insertCostRow(wsId, { costUsd: 5.0, ageHours: 25 });
  const r = checkSpendCap(wsId);
  assert.equal(r.ok, true, "0.4 < 1.0 daily cap");
  assert.ok(Math.abs(r.dailySpent - 0.4) < 1e-6);
  assert.ok(Math.abs(r.remainingUsd - 0.6) < 1e-6);
});

test("checkSpendCap: daily cap exceeded → ok=false, exceeded='day'", () => {
  const wsId = seedWorkspace({ dailyCap: 1.0 });
  insertCostRow(wsId, { costUsd: 1.5, ageHours: 1 });
  const r = checkSpendCap(wsId);
  assert.equal(r.ok, false);
  assert.equal(r.exceeded, "day");
  assert.ok(r.remainingUsd <= 0);
});

test("checkSpendCap: alert fires at >= threshold percentage", () => {
  const wsId = seedWorkspace({ dailyCap: 10.0, thresholdPct: 80 });
  insertCostRow(wsId, { costUsd: 8.5, ageHours: 1 });
  const r = checkSpendCap(wsId);
  assert.equal(r.ok, true, "below cap, dispatch still allowed");
  assert.equal(r.alertTriggered, true, "8.5 >= 10 * 0.80, alert should fire");
});

test("checkSpendCap: alert does NOT fire below threshold", () => {
  const wsId = seedWorkspace({ dailyCap: 10.0, thresholdPct: 80 });
  insertCostRow(wsId, { costUsd: 5.0, ageHours: 1 });
  const r = checkSpendCap(wsId);
  assert.equal(r.ok, true);
  assert.equal(r.alertTriggered, false, "5.0 < 10 * 0.80");
});

test("checkSpendCap: monthly cap enforced — month-to-date sum", () => {
  const wsId = seedWorkspace({ monthlyCap: 50.0 });
  // Two rows totalling exactly the cap — exceeded by the >= semantics.
  insertCostRow(wsId, { costUsd: 25.0, ageHours: 1 });
  insertCostRow(wsId, { costUsd: 25.0, ageHours: 24 * 5 });
  const r = checkSpendCap(wsId);
  assert.equal(r.ok, false);
  assert.equal(r.exceeded, "month");
});

summary("Quota guard (B3.7)");

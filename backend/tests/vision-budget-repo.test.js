/**
 * @module tests/vision-budget-repo
 * @description MNT-001b — `visionBudgetRepo` daily-calls + monthly-cost
 * circuit-breaker tests. Real SQLite via `getDatabase()`; projects are
 * created via `projectRepo.create` so the cap-reading code path runs
 * against actual rows (not stubs).
 */
import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as budgetRepo from "../src/database/repositories/visionBudgetRepo.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

function resetBudget() {
  const db = getDatabase();
  db.exec("DELETE FROM vision_heal_budget");
}

function createProject({ id, dailyCap = 100, monthlyCap = 50, workspaceId = "WS-VBR" }) {
  const db = getDatabase();
  // Clean any prior fixture by the same id so re-runs don't conflict on PK.
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  projectRepo.create({
    id,
    name: id,
    url: "https://example.com",
    status: "idle",
    createdAt: new Date().toISOString(),
    workspaceId,
    visionHealing: "pixelmatch_and_llm",
    visionHealMaxCallsPerDay: dailyCap,
    visionHealMaxCostUsdPerMonth: monthlyCap,
  });
}

console.log("\n── MNT-001b visionBudgetRepo ──");

getDatabase();
resetBudget();

await test("dailyWindowKey / monthlyWindowKey format YYYY-MM-DD / YYYY-MM in UTC", () => {
  // Pin a known timestamp so the assertion is portable across timezones.
  const t = new Date(Date.UTC(2026, 0, 15, 10, 30, 0)); // 2026-01-15 10:30 UTC
  assert.equal(budgetRepo.dailyWindowKey(t), "daily:2026-01-15");
  assert.equal(budgetRepo.monthlyWindowKey(t), "monthly:2026-01");
});

await test("recordCall increments daily callCount and monthly costUsd in one txn", async () => {
  resetBudget();
  const t = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  budgetRepo.recordCall({ projectId: "PRJ-VBR-1", costUsd: 0.012, now: t });
  budgetRepo.recordCall({ projectId: "PRJ-VBR-1", costUsd: 0.008, now: t });
  assert.equal(budgetRepo.getDailyCalls("PRJ-VBR-1", t), 2);
  // 0.012 + 0.008 = 0.020 — use approx compare for FP safety.
  const cost = budgetRepo.getMonthlyCost("PRJ-VBR-1", t);
  assert.ok(Math.abs(cost - 0.020) < 1e-9, `expected ~0.020, got ${cost}`);
});

await test("daily and monthly buckets are independent across projects", async () => {
  resetBudget();
  budgetRepo.recordCall({ projectId: "PRJ-VBR-A", costUsd: 0.01 });
  budgetRepo.recordCall({ projectId: "PRJ-VBR-B", costUsd: 0.02 });
  assert.equal(budgetRepo.getDailyCalls("PRJ-VBR-A"), 1);
  assert.equal(budgetRepo.getDailyCalls("PRJ-VBR-B"), 1);
  assert.ok(Math.abs(budgetRepo.getMonthlyCost("PRJ-VBR-A") - 0.01) < 1e-9);
  assert.ok(Math.abs(budgetRepo.getMonthlyCost("PRJ-VBR-B") - 0.02) < 1e-9);
});

await test("getDailyCalls / getMonthlyCost return 0 for empty buckets", () => {
  resetBudget();
  assert.equal(budgetRepo.getDailyCalls("PRJ-EMPTY"), 0);
  assert.equal(budgetRepo.getMonthlyCost("PRJ-EMPTY"), 0);
});

await test("isBudgetExhausted is false under both caps", async () => {
  resetBudget();
  createProject({ id: "PRJ-VBR-UNDER", dailyCap: 100, monthlyCap: 50 });
  budgetRepo.recordCall({ projectId: "PRJ-VBR-UNDER", costUsd: 0.5 });
  const r = await budgetRepo.isBudgetExhausted("PRJ-VBR-UNDER");
  assert.deepEqual(r, { dailyCalls: false, monthlyCost: false });
});

await test("isBudgetExhausted trips dailyCalls when callCount >= cap", async () => {
  resetBudget();
  createProject({ id: "PRJ-VBR-DAILY", dailyCap: 3, monthlyCap: 1000 });
  for (let i = 0; i < 3; i++) {
    budgetRepo.recordCall({ projectId: "PRJ-VBR-DAILY", costUsd: 0.01 });
  }
  const r = await budgetRepo.isBudgetExhausted("PRJ-VBR-DAILY");
  assert.equal(r.dailyCalls, true);
  assert.equal(r.monthlyCost, false);
});

await test("isBudgetExhausted trips monthlyCost when cost >= cap", async () => {
  resetBudget();
  createProject({ id: "PRJ-VBR-MONTHLY", dailyCap: 1000, monthlyCap: 0.5 });
  budgetRepo.recordCall({ projectId: "PRJ-VBR-MONTHLY", costUsd: 0.6 });
  const r = await budgetRepo.isBudgetExhausted("PRJ-VBR-MONTHLY");
  assert.equal(r.dailyCalls, false);
  assert.equal(r.monthlyCost, true);
});

await test("isBudgetExhausted returns both true for unknown project (conservative)", async () => {
  const r = await budgetRepo.isBudgetExhausted("PRJ-DOES-NOT-EXIST");
  assert.deepEqual(r, { dailyCalls: true, monthlyCost: true });
});

await test("isBudgetExhausted returns both true for null/empty projectId", async () => {
  assert.deepEqual(await budgetRepo.isBudgetExhausted(""), { dailyCalls: true, monthlyCost: true });
  assert.deepEqual(await budgetRepo.isBudgetExhausted(null), { dailyCalls: true, monthlyCost: true });
});

await test("recordCall is a noop for falsy projectId", () => {
  resetBudget();
  budgetRepo.recordCall({ projectId: "", costUsd: 1 });
  budgetRepo.recordCall({ projectId: null, costUsd: 1 });
  const db = getDatabase();
  const cnt = db.prepare("SELECT COUNT(*) as c FROM vision_heal_budget").get().c;
  assert.equal(cnt, 0);
});

await test("recordCall coerces non-finite costUsd to 0", () => {
  resetBudget();
  budgetRepo.recordCall({ projectId: "PRJ-NAN", costUsd: NaN });
  budgetRepo.recordCall({ projectId: "PRJ-NAN", costUsd: "not-a-number" });
  assert.equal(budgetRepo.getDailyCalls("PRJ-NAN"), 2);
  assert.equal(budgetRepo.getMonthlyCost("PRJ-NAN"), 0);
});

await test("purgeOlderThan removes stale buckets, preserves recent", () => {
  resetBudget();
  const db = getDatabase();
  const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const newTs = new Date().toISOString();
  db.prepare("INSERT INTO vision_heal_budget VALUES (?, ?, ?, ?, ?)").run("PRJ-X", "daily:2024-01-01", 5, 0, oldTs);
  db.prepare("INSERT INTO vision_heal_budget VALUES (?, ?, ?, ?, ?)").run("PRJ-X", "daily:2026-01-15", 1, 0, newTs);
  const removed = budgetRepo.purgeOlderThan(90);
  assert.equal(removed, 1);
});

await test("deleteByProjectId is scoped to project", () => {
  resetBudget();
  budgetRepo.recordCall({ projectId: "PRJ-DEL-A", costUsd: 1 });
  budgetRepo.recordCall({ projectId: "PRJ-DEL-B", costUsd: 1 });
  const removed = budgetRepo.deleteByProjectId("PRJ-DEL-A");
  assert.ok(removed >= 1);
  assert.equal(budgetRepo.getDailyCalls("PRJ-DEL-A"), 0);
  assert.equal(budgetRepo.getDailyCalls("PRJ-DEL-B"), 1);
});

resetBudget();
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

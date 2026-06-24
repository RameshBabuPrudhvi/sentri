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
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const runner = t.createTestRunner();
const test = (name, fn) => runner.test(name, fn);

function resetBudget() {
  const db = getDatabase();
  db.exec("DELETE FROM vision_budget_counters");
}

function createProject({ id, dailyCap = 100, monthlyCap = 50 }) {
  const db = getDatabase();
  // Clean any prior fixture by the same id so re-runs don't conflict on PK.
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  // workspaceId left null on purpose — populating it would require seeding
  // a workspace row + a user row (workspaces.ownerId FKs to users.id with
  // NOT NULL slug/updatedAt). `isBudgetExhausted` only reads the two cap
  // columns, so a null workspaceId is fine for this fixture.
  projectRepo.create({
    id,
    name: id,
    url: "https://example.com",
    status: "idle",
    createdAt: new Date().toISOString(),
    workspaceId: null,
    visionHealing: "pixelmatch_and_llm",
    visionHealMaxCallsPerDay: dailyCap,
    visionHealMaxCostUsdPerMonth: monthlyCap,
  });
}

console.log("\n── MNT-001b visionBudgetRepo ──");

getDatabase();
resetBudget();

await test("dayKey / monthKey format YYYY-MM-DD / YYYY-MM in UTC (no prefix)", () => {
  // Pin a known timestamp so the assertion is portable across timezones.
  // The period prefix lives in the `windowKind` column now, not the key itself.
  const t = new Date(Date.UTC(2026, 0, 15, 10, 30, 0)); // 2026-01-15 10:30 UTC
  assert.equal(budgetRepo.dayKey(t), "2026-01-15");
  assert.equal(budgetRepo.monthKey(t), "2026-01");
});

await test("record increments daily calls and monthly costUsd in one txn", async () => {
  resetBudget();
  const t = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  budgetRepo.record("PRJ-VBR-1", 0.012, t);
  budgetRepo.record("PRJ-VBR-1", 0.008, t);
  assert.equal(budgetRepo.getDailyCalls("PRJ-VBR-1", t), 2);
  // 0.012 + 0.008 = 0.020 — use approx compare for FP safety.
  const cost = budgetRepo.getMonthlyCost("PRJ-VBR-1", t);
  assert.ok(Math.abs(cost - 0.020) < 1e-9, `expected ~0.020, got ${cost}`);
});

await test("getCounters bundles day + month reads with window keys", () => {
  resetBudget();
  const t = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
  budgetRepo.record("PRJ-VBR-COUNTER", 0.05, t);
  const c = budgetRepo.getCounters("PRJ-VBR-COUNTER", t);
  assert.equal(c.dailyCalls, 1);
  assert.ok(Math.abs(c.monthlyCostUsd - 0.05) < 1e-9);
  assert.equal(c.day, "2026-01-15");
  assert.equal(c.month, "2026-01");
});

await test("daily and monthly buckets are independent across projects", async () => {
  resetBudget();
  budgetRepo.record("PRJ-VBR-A", 0.01);
  budgetRepo.record("PRJ-VBR-B", 0.02);
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
  budgetRepo.record("PRJ-VBR-UNDER", 0.5);
  const r = await budgetRepo.isBudgetExhausted("PRJ-VBR-UNDER");
  assert.deepEqual(r, { dailyCalls: false, monthlyCost: false });
});

await test("isBudgetExhausted trips dailyCalls when calls >= cap", async () => {
  resetBudget();
  createProject({ id: "PRJ-VBR-DAILY", dailyCap: 3, monthlyCap: 1000 });
  for (let i = 0; i < 3; i++) {
    budgetRepo.record("PRJ-VBR-DAILY", 0.01);
  }
  const r = await budgetRepo.isBudgetExhausted("PRJ-VBR-DAILY");
  assert.equal(r.dailyCalls, true);
  assert.equal(r.monthlyCost, false);
});

await test("isBudgetExhausted trips monthlyCost when cost >= cap", async () => {
  resetBudget();
  createProject({ id: "PRJ-VBR-MONTHLY", dailyCap: 1000, monthlyCap: 0.5 });
  budgetRepo.record("PRJ-VBR-MONTHLY", 0.6);
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

await test("record is a noop for falsy projectId", () => {
  resetBudget();
  budgetRepo.record("", 1);
  budgetRepo.record(null, 1);
  const db = getDatabase();
  const cnt = db.prepare("SELECT COUNT(*) as c FROM vision_budget_counters").get().c;
  assert.equal(cnt, 0);
});

await test("record coerces non-finite costUsd to 0", () => {
  resetBudget();
  budgetRepo.record("PRJ-NAN", NaN);
  budgetRepo.record("PRJ-NAN", "not-a-number");
  assert.equal(budgetRepo.getDailyCalls("PRJ-NAN"), 2);
  assert.equal(budgetRepo.getMonthlyCost("PRJ-NAN"), 0);
});

await test("purgeOlderThan removes stale buckets, preserves recent", () => {
  resetBudget();
  const db = getDatabase();
  const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const newTs = new Date().toISOString();
  // Raw INSERT against the new schema — discriminator column 'windowKind' must
  // satisfy the CHECK constraint (`windowKind IN ('day', 'month')`).
  db.prepare("INSERT INTO vision_budget_counters VALUES (?, ?, ?, ?, ?, ?)").run("PRJ-X", "day", "2024-01-01", 5, 0, oldTs);
  db.prepare("INSERT INTO vision_budget_counters VALUES (?, ?, ?, ?, ?, ?)").run("PRJ-X", "day", "2026-01-15", 1, 0, newTs);
  const removed = budgetRepo.purgeOlderThan(90);
  assert.equal(removed, 1);
});

await test("deleteByProjectId is scoped to project", () => {
  resetBudget();
  budgetRepo.record("PRJ-DEL-A", 1);
  budgetRepo.record("PRJ-DEL-B", 1);
  const removed = budgetRepo.deleteByProjectId("PRJ-DEL-A");
  assert.ok(removed >= 1);
  assert.equal(budgetRepo.getDailyCalls("PRJ-DEL-A"), 0);
  assert.equal(budgetRepo.getDailyCalls("PRJ-DEL-B"), 1);
});

await test("CHECK constraint rejects invalid windowKind discriminator", () => {
  resetBudget();
  const db = getDatabase();
  // Direct INSERT with a bogus windowKind value should fail the CHECK constraint
  // at insert time — confirms the schema actually defends against typos.
  let threw = false;
  try {
    db.prepare("INSERT INTO vision_budget_counters VALUES (?, ?, ?, ?, ?, ?)").run(
      "PRJ-CHECK", "year", "2026", 1, 0, new Date().toISOString(),
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "CHECK (windowKind IN ('day','month')) should reject 'year'");
});

resetBudget();
runner.summary("vision-budget-repo");

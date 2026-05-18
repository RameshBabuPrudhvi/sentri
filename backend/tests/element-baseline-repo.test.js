/**
 * @module tests/element-baseline-repo
 * @description MNT-001b — CRUD + retention + cascade tests for
 * `elementBaselineRepo`. Real SQLite via the standard `getDatabase()` so
 * the BLOB binding path is exercised end-to-end.
 */
import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as repo from "../src/database/repositories/elementBaselineRepo.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

function reset() {
  const db = getDatabase();
  db.exec("DELETE FROM element_baselines");
}

console.log("\n── MNT-001b elementBaselineRepo ──");

// Boot the DB so migration 036 has applied before the first query.
getDatabase();
reset();

test("upsert + get round-trips PNG bytes verbatim", () => {
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4]);
  repo.upsert({
    projectId: "PRJ-EBL-1",
    healingKey: "TC-1@v1::click::Submit",
    cropPng: png,
    cropWidth: 80,
    cropHeight: 32,
    capturedAt: "2026-01-15T10:00:00.000Z",
  });
  const row = repo.get("PRJ-EBL-1", "TC-1@v1::click::Submit");
  assert.ok(row);
  assert.equal(row.cropWidth, 80);
  assert.equal(row.cropHeight, 32);
  assert.equal(row.capturedAt, "2026-01-15T10:00:00.000Z");
  assert.ok(Buffer.isBuffer(row.cropPng), "BLOB should round-trip as a Buffer");
  assert.deepEqual(Buffer.from(row.cropPng), png);
});

test("upsert conflict replaces the existing row", () => {
  const first = Buffer.from([1, 2, 3]);
  const second = Buffer.from([9, 8, 7, 6, 5]);
  repo.upsert({
    projectId: "PRJ-EBL-2", healingKey: "k", cropPng: first,
    cropWidth: 10, cropHeight: 10, capturedAt: "2026-01-15T10:00:00.000Z",
  });
  repo.upsert({
    projectId: "PRJ-EBL-2", healingKey: "k", cropPng: second,
    cropWidth: 20, cropHeight: 20, capturedAt: "2026-01-16T10:00:00.000Z",
  });
  const row = repo.get("PRJ-EBL-2", "k");
  assert.deepEqual(Buffer.from(row.cropPng), second);
  assert.equal(row.cropWidth, 20);
  assert.equal(row.capturedAt, "2026-01-16T10:00:00.000Z");
});

test("get returns undefined for unknown (projectId, healingKey)", () => {
  assert.equal(repo.get("PRJ-DNE", "nope"), undefined);
});

test("purgeOlderThan deletes rows older than the cutoff and preserves newer", () => {
  reset();
  const oldTs = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  const newTs = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  repo.upsert({ projectId: "PRJ-EBL-3", healingKey: "old", cropPng: Buffer.from([0]),  cropWidth: 1, cropHeight: 1, capturedAt: oldTs });
  repo.upsert({ projectId: "PRJ-EBL-3", healingKey: "new", cropPng: Buffer.from([1]),  cropWidth: 1, cropHeight: 1, capturedAt: newTs });
  const deleted = repo.purgeOlderThan(30);
  assert.equal(deleted, 1);
  assert.equal(repo.get("PRJ-EBL-3", "old"), undefined);
  assert.ok(repo.get("PRJ-EBL-3", "new"));
});

test("purgeOlderThan rejects invalid retention values", () => {
  assert.equal(repo.purgeOlderThan(0), 0);
  assert.equal(repo.purgeOlderThan(-5), 0);
  assert.equal(repo.purgeOlderThan(NaN), 0);
});

test("deleteByProjectId is scoped to the project", () => {
  reset();
  repo.upsert({ projectId: "PRJ-A", healingKey: "k1", cropPng: Buffer.from([0]), cropWidth: 1, cropHeight: 1, capturedAt: new Date().toISOString() });
  repo.upsert({ projectId: "PRJ-A", healingKey: "k2", cropPng: Buffer.from([0]), cropWidth: 1, cropHeight: 1, capturedAt: new Date().toISOString() });
  repo.upsert({ projectId: "PRJ-B", healingKey: "k1", cropPng: Buffer.from([0]), cropWidth: 1, cropHeight: 1, capturedAt: new Date().toISOString() });
  const removed = repo.deleteByProjectId("PRJ-A");
  assert.equal(removed, 2);
  assert.equal(repo.get("PRJ-A", "k1"), undefined);
  assert.ok(repo.get("PRJ-B", "k1"));
});

reset();
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

import test from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as testFixtureRepo from "../src/database/repositories/testFixtureRepo.js";

function resetFixtures() {
  const db = getDatabase();
  db.exec("DELETE FROM test_fixtures");
}

test("testFixtureRepo upsert/get round-trips JSON rows", () => {
  resetFixtures();
  const rows = [{ email: "a@example.com", role: "admin" }, { email: "b@example.com", role: "viewer" }];
  const saved = testFixtureRepo.upsertFixture({ testId: "T-1", version: 1, format: "json", rows });
  assert.equal(saved.testId, "T-1");
  assert.equal(saved.version, 1);
  assert.equal(saved.format, "json");
  assert.deepEqual(saved.rows, rows);

  const fetched = testFixtureRepo.getFixture("T-1", 1);
  assert.deepEqual(fetched.rows, rows);
});

test("testFixtureRepo upsert replaces existing (testId, version)", () => {
  resetFixtures();
  testFixtureRepo.upsertFixture({ testId: "T-2", version: 3, format: "json", rows: [{ a: 1 }] });
  testFixtureRepo.upsertFixture({ testId: "T-2", version: 3, format: "csv", rows: [{ a: 2 }, { a: 3 }] });
  const all = testFixtureRepo.listFixtures("T-2");
  assert.equal(all.length, 1);
  assert.equal(all[0].format, "csv");
  assert.deepEqual(all[0].rows, [{ a: 2 }, { a: 3 }]);
});

test("testFixtureRepo list returns newest version first", () => {
  resetFixtures();
  testFixtureRepo.upsertFixture({ testId: "T-3", version: 1, format: "json", rows: [{ x: "v1" }] });
  testFixtureRepo.upsertFixture({ testId: "T-3", version: 2, format: "json", rows: [{ x: "v2" }] });
  const versions = testFixtureRepo.listFixtures("T-3").map((f) => f.version);
  assert.deepEqual(versions, [2, 1]);
});

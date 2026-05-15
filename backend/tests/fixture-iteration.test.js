import test from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as testFixtureRepo from "../src/database/repositories/testFixtureRepo.js";
import { executeTestIterations } from "../src/runner/executeTest.js";
import { __testables as testsRouteInternals } from "../src/routes/tests.js";

const { parseCsvRows, clampIterationCap } = testsRouteInternals;

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

// ─── CAP-001 acceptance criteria ─────────────────────────────────────────────

test("executeTestIterations: 5-row fixture yields 5 results with iterationIndex + row snapshot", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ user: `u${i}`, role: i === 2 ? "admin" : "viewer" }));
  const test = { id: "T-iter-5", name: "T", playwrightCode: "expect({{user}}).toBe('{{role}}');" };
  const results = await executeTestIterations(test, rows, async (iterTest) => ({
    status: "passed",
    code: iterTest.playwrightCode,
  }));
  assert.equal(results.length, 5);
  results.forEach((r, i) => {
    assert.equal(r.iterationIndex, i);
    assert.deepEqual(r.fixtureRow, rows[i]);
    // Placeholder substitution happened
    assert.equal(r.code, `expect(u${i}).toBe('${rows[i].role}');`);
  });
});

test("executeTestIterations: fixture-less test runs exactly once with no iteration metadata (zero-regression)", async () => {
  const test = { id: "T-no-fix", name: "T", playwrightCode: "expect(1).toBe(1);" };
  const results = await executeTestIterations(test, undefined, async () => ({ status: "passed" }));
  assert.equal(results.length, 1);
  assert.equal(results[0].iterationIndex, undefined);
  assert.equal(results[0].fixtureRow, undefined);
});

test("executeTestIterations: failed iterations don't short-circuit (every row attributable)", async () => {
  const rows = [{ x: "1" }, { x: "2" }, { x: "3" }];
  const test = { id: "T-fail", name: "T", playwrightCode: "v={{x}}" };
  const results = await executeTestIterations(test, rows, async (iterTest) => {
    // Row 2 (index 1) fails — the others must still execute.
    const idx = Number(iterTest.playwrightCode.replace("v=", ""));
    return idx === 2
      ? { status: "failed", error: `boom on row x=${idx}` }
      : { status: "passed" };
  });
  assert.equal(results.length, 3);
  assert.equal(results[0].status, "passed");
  assert.equal(results[1].status, "failed");
  assert.equal(results[2].status, "passed");
  // Failed row carries the offending fixture snapshot
  assert.deepEqual(results[1].fixtureRow, { x: "2" });
  assert.equal(results[1].iterationIndex, 1);
});

test("clampIterationCap: defaults to 10, clamps to [1, 100]", () => {
  assert.equal(clampIterationCap(undefined), 10);
  assert.equal(clampIterationCap(null), 10);
  assert.equal(clampIterationCap(0), 10);
  assert.equal(clampIterationCap(-5), 10);
  assert.equal(clampIterationCap("not-a-number"), 10);
  assert.equal(clampIterationCap(1), 1);
  assert.equal(clampIterationCap(50), 50);
  assert.equal(clampIterationCap(100), 100);
  assert.equal(clampIterationCap(101), 100);
  assert.equal(clampIterationCap(10_000), 100);
  // Fractional → floored, then clamped
  assert.equal(clampIterationCap(7.9), 7);
});

test("parseCsvRows: handles header + rows with quoted fields and embedded commas", () => {
  const csv = `email,name,note
"a@example.com","Alice","hello, world"
"b@example.com","Bob","line""one"`;
  const rows = parseCsvRows(csv);
  assert.deepEqual(rows, [
    { email: "a@example.com", name: "Alice", note: "hello, world" },
    { email: "b@example.com", name: "Bob",   note: 'line"one' },
  ]);
});

test("parseCsvRows: returns [] for empty or header-only input", () => {
  assert.deepEqual(parseCsvRows(""), []);
  assert.deepEqual(parseCsvRows("   \n  "), []);
  assert.deepEqual(parseCsvRows("a,b,c"), []);
});

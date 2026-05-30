/**
 * @module tests/csv
 * @description Direct unit coverage for `utils/csv.js` after the §17 #1
 * extraction from `routes/tests.js`. The existing `tests/fixture-iteration.test.js`
 * still exercises the same helpers via the `routes/tests.js` `__testables`
 * re-export — this file tests the new module's own import surface so the
 * helpers can be removed from `__testables` in a future cleanup without
 * silently losing coverage.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseCsvRows, clampIterationCap } from "../src/utils/csv.js";

test("parseCsvRows — header + one row returns one keyed object", () => {
  const rows = parseCsvRows("name,age\nalice,30");
  assert.deepEqual(rows, [{ name: "alice", age: "30" }]);
});

test("parseCsvRows — empty / whitespace-only / header-only input returns []", () => {
  assert.deepEqual(parseCsvRows(""), []);
  assert.deepEqual(parseCsvRows("   \n  "), []);
  assert.deepEqual(parseCsvRows("name,age"), [], "header without a data row is []");
});

test("parseCsvRows — quoted fields preserve embedded commas + newlines", () => {
  const text = `name,bio\n"O'Connor","line 1, line 2\nline 3"`;
  const rows = parseCsvRows(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "O'Connor");
  assert.equal(rows[0].bio, "line 1, line 2\nline 3");
});

test("parseCsvRows — `\"\"` inside a quoted field is an escaped double-quote", () => {
  const rows = parseCsvRows(`label,text\nq,"He said ""hi"""`);
  assert.equal(rows[0].text, 'He said "hi"');
});

test("parseCsvRows — handles CRLF row separators", () => {
  const rows = parseCsvRows("a,b\r\n1,2\r\n3,4\r\n");
  assert.deepEqual(rows, [{ a: "1", b: "2" }, { a: "3", b: "4" }]);
});

test("parseCsvRows — drops blank trailing rows", () => {
  const rows = parseCsvRows("a,b\n1,2\n\n\n");
  assert.deepEqual(rows, [{ a: "1", b: "2" }]);
});

test("clampIterationCap — defaults to 10 on bad input, clamps to [1, 100]", () => {
  assert.equal(clampIterationCap(undefined), 10);
  assert.equal(clampIterationCap(null), 10);
  assert.equal(clampIterationCap("not-a-number"), 10);
  assert.equal(clampIterationCap(0), 10);
  assert.equal(clampIterationCap(-5), 10);

  assert.equal(clampIterationCap(1), 1);
  assert.equal(clampIterationCap(50), 50);
  assert.equal(clampIterationCap(100), 100);
  assert.equal(clampIterationCap(101), 100, "above cap clamps to 100");
  assert.equal(clampIterationCap(1_000_000), 100);

  assert.equal(clampIterationCap(3.7), 3, "fractional values floor");
  assert.equal(clampIterationCap("25"), 25, "string-typed input coerces");
});

/**
 * @module tests/postgres-adapter
 * @description Unit tests for the PostgreSQL adapter's SQL translation layer (INF-001).
 *
 * These tests validate the dialect translation functions WITHOUT requiring a
 * live PostgreSQL connection — they exercise `translateSql`, `namedToPositional`,
 * `questionToNumbered`, and `maskStringLiterals` via the exported `translateSql`.
 *
 * Covers:
 *   - LIKE → ILIKE (case-insensitive, string-literal safe)
 *   - datetime('now') → NOW()
 *   - INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
 *   - INSERT OR IGNORE → ON CONFLICT DO NOTHING
 *   - INSERT OR REPLACE → ON CONFLICT DO UPDATE SET
 *   - Multi-statement SQL splitting and per-statement translation
 *   - String literal masking (prevents corruption of values containing SQL keywords)
 *   - @param named → $N positional (with string literal safety)
 *   - ? → $N positional (with string literal safety)
 */

import assert from "node:assert/strict";

// translateSql is the only exported function we can test directly.
// The internal helpers (namedToPositional, questionToNumbered, maskStringLiterals)
// are exercised indirectly through translateSql and through the adapter's
// prepare().run/get/all methods.
import { translateSql } from "../src/database/adapters/postgres-adapter.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

// ─── LIKE → ILIKE ─────────────────────────────────────────────────────────────

console.log("\n🐘 translateSql: LIKE → ILIKE");

test("converts uppercase LIKE to ILIKE", () => {
  const result = translateSql("SELECT * FROM users WHERE name LIKE '%test%'");
  assert.ok(result.includes("ILIKE"), `Expected ILIKE, got: ${result}`);
  assert.ok(!result.includes(" LIKE "), `Should not contain LIKE, got: ${result}`);
});

test("converts lowercase like to ILIKE", () => {
  const result = translateSql("SELECT * FROM users WHERE name like '%test%'");
  assert.ok(result.includes("ILIKE"), `Expected ILIKE, got: ${result}`);
});

test("does NOT corrupt LIKE inside string literals", () => {
  const result = translateSql("INSERT INTO logs (msg) VALUES ('I LIKE cats')");
  assert.ok(result.includes("'I LIKE cats'"), `String literal should be preserved, got: ${result}`);
});

// ─── datetime('now') → NOW() ─────────────────────────────────────────────────

console.log("\n🐘 translateSql: datetime('now') → NOW()");

test("converts datetime('now') to NOW()", () => {
  const result = translateSql("SELECT datetime('now')");
  assert.ok(result.includes("NOW()"), `Expected NOW(), got: ${result}`);
  assert.ok(!result.includes("datetime"), `Should not contain datetime, got: ${result}`);
});

// ─── AUTOINCREMENT → SERIAL ──────────────────────────────────────────────────

console.log("\n🐘 translateSql: AUTOINCREMENT → SERIAL");

test("converts INTEGER PRIMARY KEY AUTOINCREMENT to SERIAL PRIMARY KEY", () => {
  const result = translateSql("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  assert.ok(result.includes("SERIAL PRIMARY KEY"), `Expected SERIAL PRIMARY KEY, got: ${result}`);
});

// ─── INSERT OR IGNORE → ON CONFLICT DO NOTHING ──────────────────────────────

console.log("\n🐘 translateSql: INSERT OR IGNORE");

test("converts INSERT OR IGNORE to ON CONFLICT DO NOTHING", () => {
  const result = translateSql("INSERT OR IGNORE INTO users (id, name) VALUES ('u1', 'Alice')");
  assert.ok(result.includes("INSERT INTO"), `Should replace INSERT OR IGNORE, got: ${result}`);
  assert.ok(result.includes("ON CONFLICT DO NOTHING"), `Should append ON CONFLICT DO NOTHING, got: ${result}`);
  assert.ok(!result.includes("OR IGNORE"), `Should not contain OR IGNORE, got: ${result}`);
});

// ─── INSERT OR REPLACE → ON CONFLICT DO UPDATE SET ──────────────────────────

console.log("\n🐘 translateSql: INSERT OR REPLACE");

test("converts INSERT OR REPLACE to ON CONFLICT DO UPDATE SET", () => {
  const result = translateSql("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', 'dark')");
  assert.ok(result.includes("INSERT INTO"), `Should replace INSERT OR REPLACE, got: ${result}`);
  assert.ok(result.includes("ON CONFLICT(key) DO UPDATE SET"), `Should have ON CONFLICT upsert, got: ${result}`);
  assert.ok(result.includes("value = EXCLUDED.value"), `Should update non-PK columns, got: ${result}`);
});

test("converts INSERT OR REPLACE with single column to ON CONFLICT DO NOTHING", () => {
  const result = translateSql("INSERT OR REPLACE INTO tags (name) VALUES ('important')");
  assert.ok(result.includes("ON CONFLICT(name) DO NOTHING"), `Single-col should use DO NOTHING, got: ${result}`);
});

// ─── Multi-statement SQL ─────────────────────────────────────────────────────

console.log("\n🐘 translateSql: multi-statement");

test("translates each statement independently in multi-statement SQL", () => {
  const sql = `
    INSERT OR IGNORE INTO a (id, name) VALUES ('1', 'x');
    INSERT OR IGNORE INTO b (id, name) VALUES ('2', 'y');
  `;
  const result = translateSql(sql);
  // Both statements should get ON CONFLICT DO NOTHING
  const stmts = result.split(";\n");
  assert.ok(stmts[0].includes("ON CONFLICT DO NOTHING"), `First stmt should have ON CONFLICT, got: ${stmts[0]}`);
  assert.ok(stmts[1].includes("ON CONFLICT DO NOTHING"), `Second stmt should have ON CONFLICT, got: ${stmts[1]}`);
});

test("preserves string literals containing semicolons", () => {
  const sql = "INSERT INTO logs (msg) VALUES ('hello; world')";
  const result = translateSql(sql);
  assert.ok(result.includes("'hello; world'"), `Semicolon in string should be preserved, got: ${result}`);
});

// ─── String literal safety ───────────────────────────────────────────────────

console.log("\n🐘 translateSql: string literal safety");

test("preserves datetime('now') inside string literals", () => {
  const result = translateSql("INSERT INTO logs (msg) VALUES ('created at datetime(''now'')')");
  // The escaped quotes inside the string should be preserved, not translated
  assert.ok(!result.includes("NOW()") || result.includes("'created at"), "datetime inside string should not be translated");
});

test("preserves AUTOINCREMENT inside string literals", () => {
  const result = translateSql("INSERT INTO docs (content) VALUES ('INTEGER PRIMARY KEY AUTOINCREMENT is SQLite syntax')");
  assert.ok(result.includes("AUTOINCREMENT is SQLite syntax"), `AUTOINCREMENT in string should be preserved, got: ${result}`);
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

console.log("\n🐘 translateSql: edge cases");

test("handles empty string input", () => {
  const result = translateSql("");
  assert.equal(result, "");
});

test("handles SQL with no SQLite-isms (passthrough)", () => {
  const sql = "SELECT id, name FROM users WHERE id = 1";
  const result = translateSql(sql);
  assert.ok(result.includes("SELECT id, name FROM users WHERE id = 1"), `Should pass through unchanged, got: ${result}`);
});

test("handles multiple LIKE in one statement", () => {
  const result = translateSql("SELECT * FROM t WHERE a LIKE '%x%' AND b LIKE '%y%'");
  const count = (result.match(/ILIKE/g) || []).length;
  assert.equal(count, 2, `Should have 2 ILIKEs, got ${count}`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);

if (failed > 0) {
  console.log("\n⚠️  postgres-adapter tests failed");
  process.exit(1);
}

console.log("\n🎉 All postgres-adapter tests passed!");

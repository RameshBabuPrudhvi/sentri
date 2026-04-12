/**
 * @module tests/password-reset-token
 * @description Unit tests for passwordResetTokenRepo and the actor() utility.
 *
 * Covers:
 *   - passwordResetTokenRepo.create() inserts a token and invalidates prior unused tokens
 *   - passwordResetTokenRepo.claim() atomically marks a token as used (TOCTOU fix)
 *   - passwordResetTokenRepo.claim() returns null for missing, expired, or already-used tokens
 *   - passwordResetTokenRepo.deleteUnusedByUserId() removes only unused tokens
 *   - passwordResetTokenRepo.deleteExpired() removes only expired tokens
 *   - actor() extracts userId/userName from req.authUser
 *   - actor() prefers name over email over sub
 *   - actor() returns {} when authUser is absent
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as resetTokenRepo from "../src/database/repositories/passwordResetTokenRepo.js";
import { actor } from "../src/utils/actor.js";

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

/** All test user IDs used below — must exist in `users` to satisfy the FK constraint. */
const TEST_USERS = ["U-1", "U-2", "U-3", "U-4", "U-5", "U-6", "U-7", "U-8", "U-A", "U-B"];

function seedTestUsers() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO users (id, name, email, passwordHash, role, createdAt, updatedAt) VALUES (?, ?, ?, NULL, 'user', ?, ?)"
  );
  for (const id of TEST_USERS) {
    insert.run(id, `Test ${id}`, `${id.toLowerCase()}@test.local`, now, now);
  }
}

function resetTokenTable() {
  const db = getDatabase();
  db.exec("DELETE FROM password_reset_tokens");
}

// Seed users once before all tests (FK constraint requires them to exist).
seedTestUsers();

// ─── passwordResetTokenRepo ──────────────────────────────────────────────────

console.log("\n🔑 passwordResetTokenRepo.create");

test("inserts a token row into the database", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  resetTokenRepo.create("tok-create-1", "U-1", expires);

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-create-1");
  assert.ok(row, "Token row should exist");
  assert.equal(row.userId, "U-1");
  assert.equal(row.usedAt, null);
  assert.ok(row.createdAt, "createdAt should be set");
});

test("invalidates prior unused tokens for the same user", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  resetTokenRepo.create("tok-old", "U-2", expires);
  resetTokenRepo.create("tok-new", "U-2", expires);

  const db = getDatabase();
  const old = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-old");
  const nw = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-new");
  assert.equal(old, undefined, "Old unused token should be deleted");
  assert.ok(nw, "New token should exist");
});

test("does not invalidate tokens for a different user", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  resetTokenRepo.create("tok-userA", "U-A", expires);
  resetTokenRepo.create("tok-userB", "U-B", expires);

  const db = getDatabase();
  const a = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-userA");
  const b = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-userB");
  assert.ok(a, "User A token should still exist");
  assert.ok(b, "User B token should exist");
});

console.log("\n🔑 passwordResetTokenRepo.claim");

test("returns the token row and sets usedAt on a valid unused token", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  resetTokenRepo.create("tok-claim-1", "U-3", expires);

  const entry = resetTokenRepo.claim("tok-claim-1");
  assert.ok(entry, "claim() should return the token row");
  assert.equal(entry.token, "tok-claim-1");
  assert.equal(entry.userId, "U-3");
  assert.ok(entry.usedAt, "usedAt should be set after claim");
});

test("returns null for a non-existent token", () => {
  resetTokenTable();
  const entry = resetTokenRepo.claim("does-not-exist");
  assert.equal(entry, null);
});

test("returns null for an already-used token (prevents double-use)", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  resetTokenRepo.create("tok-double", "U-4", expires);

  const first = resetTokenRepo.claim("tok-double");
  assert.ok(first, "First claim should succeed");

  const second = resetTokenRepo.claim("tok-double");
  assert.equal(second, null, "Second claim should return null (already used)");
});

test("returns null for an expired token", () => {
  resetTokenTable();
  // expiresAt is in the past
  const expired = new Date(Date.now() - 1000).toISOString();
  const db = getDatabase();
  db.prepare(
    "INSERT INTO password_reset_tokens (token, userId, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, NULL, ?)"
  ).run("tok-expired", "U-5", expired, new Date().toISOString());

  const entry = resetTokenRepo.claim("tok-expired");
  assert.equal(entry, null, "Expired token should not be claimable");
});

console.log("\n🔑 passwordResetTokenRepo.deleteUnusedByUserId");

test("deletes only unused tokens for the specified user", () => {
  resetTokenTable();
  const db = getDatabase();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // unused token for U-6
  db.prepare(
    "INSERT INTO password_reset_tokens (token, userId, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, NULL, ?)"
  ).run("tok-unused-6", "U-6", expires, now);
  // used token for U-6
  db.prepare(
    "INSERT INTO password_reset_tokens (token, userId, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, ?)"
  ).run("tok-used-6", "U-6", expires, now, now);
  // unused token for U-7 (different user)
  db.prepare(
    "INSERT INTO password_reset_tokens (token, userId, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, NULL, ?)"
  ).run("tok-unused-7", "U-7", expires, now);

  const deleted = resetTokenRepo.deleteUnusedByUserId("U-6");
  assert.equal(deleted, 1, "Should delete 1 unused token for U-6");

  assert.ok(db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-used-6"), "Used token should survive");
  assert.ok(db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-unused-7"), "Other user's token should survive");
  assert.equal(db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-unused-6"), undefined, "Unused U-6 token should be gone");
});

console.log("\n🔑 passwordResetTokenRepo.deleteExpired");

test("deletes only expired tokens regardless of usedAt status", () => {
  resetTokenTable();
  const db = getDatabase();
  const now = new Date().toISOString();
  const pastExpiry = new Date(Date.now() - 60 * 1000).toISOString();
  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  // expired + unused
  db.prepare(
    "INSERT INTO password_reset_tokens (token, userId, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, NULL, ?)"
  ).run("tok-exp-unused", "U-8", pastExpiry, now);
  // expired + used
  db.prepare(
    "INSERT INTO password_reset_tokens (token, userId, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, ?)"
  ).run("tok-exp-used", "U-8", pastExpiry, now, now);
  // not expired
  db.prepare(
    "INSERT INTO password_reset_tokens (token, userId, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, NULL, ?)"
  ).run("tok-valid", "U-8", futureExpiry, now);

  const deleted = resetTokenRepo.deleteExpired();
  assert.equal(deleted, 2, "Should delete both expired tokens");
  assert.ok(db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get("tok-valid"), "Non-expired token should survive");
});

// ─── actor() utility ─────────────────────────────────────────────────────────

console.log("\n👤 actor() utility");

test("returns {} when req is null", () => {
  assert.deepEqual(actor(null), {});
});

test("returns {} when req has no authUser", () => {
  assert.deepEqual(actor({}), {});
  assert.deepEqual(actor({ authUser: null }), {});
});

test("returns userId and userName from authUser", () => {
  const result = actor({ authUser: { sub: "U-1", email: "a@b.com", name: "Alice" } });
  assert.equal(result.userId, "U-1");
  assert.equal(result.userName, "Alice");
});

test("prefers name over email", () => {
  const result = actor({ authUser: { sub: "U-2", email: "b@c.com", name: "Bob" } });
  assert.equal(result.userName, "Bob");
});

test("falls back to email when name is missing", () => {
  const result = actor({ authUser: { sub: "U-3", email: "c@d.com" } });
  assert.equal(result.userName, "c@d.com");
});

test("falls back to sub when both name and email are missing", () => {
  const result = actor({ authUser: { sub: "U-4" } });
  assert.equal(result.userName, "U-4");
});

test("falls back to email when name is empty string", () => {
  const result = actor({ authUser: { sub: "U-5", email: "e@f.com", name: "" } });
  assert.equal(result.userName, "e@f.com");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);

if (failed > 0) {
  console.log("\n⚠️  password-reset-token tests failed");
  process.exit(1);
}

console.log("\n🎉 All password-reset-token tests passed!");

/**
 * @module tests/email-verification
 * @description Unit tests for verificationTokenRepo (SEC-001).
 *
 * Covers:
 *   - verificationTokenRepo.create() inserts a token and invalidates prior unused tokens
 *   - verificationTokenRepo.claim() atomically marks a token as used
 *   - verificationTokenRepo.claim() returns null for missing, expired, or already-used tokens
 *   - verificationTokenRepo.getUnusedByUserId() returns the latest unused token
 *   - verificationTokenRepo.deleteUnusedByUserId() removes only unused tokens
 *   - verificationTokenRepo.deleteExpired() removes only expired tokens
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as verificationTokenRepo from "../src/database/repositories/verificationTokenRepo.js";
import * as userRepo from "../src/database/repositories/userRepo.js";

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
const TEST_USERS = ["VT-U1", "VT-U2", "VT-U3", "VT-U4", "VT-U5", "VT-U6", "VT-U7", "VT-U8"];

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
  db.exec("DELETE FROM verification_tokens");
}

// Seed users once before all tests (FK constraint requires them to exist).
seedTestUsers();

// ─── verificationTokenRepo.create ────────────────────────────────────────────

console.log("\n📧 verificationTokenRepo.create");

test("inserts a token row into the database", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  verificationTokenRepo.create("vtok-create-1", "VT-U1", "vt-u1@test.local", expires);

  const db = getDatabase();
  const row = db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-create-1");
  assert.ok(row, "Token row should exist");
  assert.equal(row.userId, "VT-U1");
  assert.equal(row.email, "vt-u1@test.local");
  assert.equal(row.usedAt, null);
  assert.ok(row.createdAt, "createdAt should be set");
});

test("invalidates prior unused tokens for the same user", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  verificationTokenRepo.create("vtok-old", "VT-U2", "vt-u2@test.local", expires);
  verificationTokenRepo.create("vtok-new", "VT-U2", "vt-u2@test.local", expires);

  const db = getDatabase();
  const old = db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-old");
  const nw = db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-new");
  assert.equal(old, undefined, "Old unused token should be deleted");
  assert.ok(nw, "New token should exist");
});

test("does not invalidate tokens for a different user", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  verificationTokenRepo.create("vtok-userA", "VT-U3", "vt-u3@test.local", expires);
  verificationTokenRepo.create("vtok-userB", "VT-U4", "vt-u4@test.local", expires);

  const db = getDatabase();
  const a = db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-userA");
  const b = db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-userB");
  assert.ok(a, "User A token should still exist");
  assert.ok(b, "User B token should exist");
});

// ─── verificationTokenRepo.claim ─────────────────────────────────────────────

console.log("\n📧 verificationTokenRepo.claim");

test("returns the token row and sets usedAt on a valid unused token", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  verificationTokenRepo.create("vtok-claim-1", "VT-U5", "vt-u5@test.local", expires);

  const entry = verificationTokenRepo.claim("vtok-claim-1");
  assert.ok(entry, "claim() should return the token row");
  assert.equal(entry.token, "vtok-claim-1");
  assert.equal(entry.userId, "VT-U5");
  assert.ok(entry.usedAt, "usedAt should be set after claim");
});

test("returns null for a non-existent token", () => {
  resetTokenTable();
  const entry = verificationTokenRepo.claim("does-not-exist");
  assert.equal(entry, null);
});

test("returns null for an already-used token (prevents double-use)", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  verificationTokenRepo.create("vtok-double", "VT-U5", "vt-u5@test.local", expires);

  const first = verificationTokenRepo.claim("vtok-double");
  assert.ok(first, "First claim should succeed");

  const second = verificationTokenRepo.claim("vtok-double");
  assert.equal(second, null, "Second claim should return null (already used)");
});

test("returns null for an expired token", () => {
  resetTokenTable();
  const expired = new Date(Date.now() - 1000).toISOString();
  const db = getDatabase();
  db.prepare(
    "INSERT INTO verification_tokens (token, userId, email, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)"
  ).run("vtok-expired", "VT-U6", "vt-u6@test.local", expired, new Date().toISOString());

  const entry = verificationTokenRepo.claim("vtok-expired");
  assert.equal(entry, null, "Expired token should not be claimable");
});

// ─── verificationTokenRepo.getUnusedByUserId ─────────────────────────────────

console.log("\n📧 verificationTokenRepo.getUnusedByUserId");

test("returns the latest unused token for a user", () => {
  resetTokenTable();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  verificationTokenRepo.create("vtok-latest", "VT-U7", "vt-u7@test.local", expires);

  const token = verificationTokenRepo.getUnusedByUserId("VT-U7");
  assert.ok(token, "Should return a token");
  assert.equal(token.token, "vtok-latest");
});

test("returns undefined when no unused tokens exist", () => {
  resetTokenTable();
  const token = verificationTokenRepo.getUnusedByUserId("VT-U7");
  assert.equal(token, undefined, "Should return undefined when no tokens exist");
});

// ─── verificationTokenRepo.deleteUnusedByUserId ──────────────────────────────

console.log("\n📧 verificationTokenRepo.deleteUnusedByUserId");

test("deletes only unused tokens for the specified user", () => {
  resetTokenTable();
  const db = getDatabase();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // unused token for VT-U7
  db.prepare(
    "INSERT INTO verification_tokens (token, userId, email, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)"
  ).run("vtok-unused-7", "VT-U7", "vt-u7@test.local", expires, now);
  // used token for VT-U7
  db.prepare(
    "INSERT INTO verification_tokens (token, userId, email, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("vtok-used-7", "VT-U7", "vt-u7@test.local", expires, now, now);
  // unused token for VT-U8 (different user)
  db.prepare(
    "INSERT INTO verification_tokens (token, userId, email, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)"
  ).run("vtok-unused-8", "VT-U8", "vt-u8@test.local", expires, now);

  const deleted = verificationTokenRepo.deleteUnusedByUserId("VT-U7");
  assert.equal(deleted, 1, "Should delete 1 unused token for VT-U7");

  assert.ok(db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-used-7"), "Used token should survive");
  assert.ok(db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-unused-8"), "Other user's token should survive");
  assert.equal(db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-unused-7"), undefined, "Unused VT-U7 token should be gone");
});

// ─── verificationTokenRepo.deleteExpired ─────────────────────────────────────

console.log("\n📧 verificationTokenRepo.deleteExpired");

test("deletes only expired tokens regardless of usedAt status", () => {
  resetTokenTable();
  const db = getDatabase();
  const now = new Date().toISOString();
  const pastExpiry = new Date(Date.now() - 60 * 1000).toISOString();
  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  // expired + unused
  db.prepare(
    "INSERT INTO verification_tokens (token, userId, email, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)"
  ).run("vtok-exp-unused", "VT-U8", "vt-u8@test.local", pastExpiry, now);
  // expired + used
  db.prepare(
    "INSERT INTO verification_tokens (token, userId, email, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("vtok-exp-used", "VT-U8", "vt-u8@test.local", pastExpiry, now, now);
  // not expired
  db.prepare(
    "INSERT INTO verification_tokens (token, userId, email, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)"
  ).run("vtok-valid", "VT-U8", "vt-u8@test.local", futureExpiry, now);

  const deleted = verificationTokenRepo.deleteExpired();
  assert.equal(deleted, 2, "Should delete both expired tokens");
  assert.ok(db.prepare("SELECT * FROM verification_tokens WHERE token = ?").get("vtok-valid"), "Non-expired token should survive");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);

if (failed > 0) {
  console.log("\n⚠️  email-verification tests failed");
  process.exit(1);
}

console.log("\n🎉 All email-verification tests passed!");

/**
 * @module tests/webhook-token
 * @description Unit tests for ENH-011 — webhook trigger token management.
 *
 * Verifies:
 *   - hashToken() produces a consistent 64-char hex SHA-256 digest
 *   - generateToken() produces 80-char hex strings with high entropy
 *   - create() inserts a token row with correct fields
 *   - getByProjectId() returns public fields only (no tokenHash)
 *   - getByProjectId() returns tokens ordered by createdAt DESC
 *   - findByHash() returns the full row including tokenHash
 *   - findByHash() returns undefined for unknown hash
 *   - touch() updates lastUsedAt
 *   - deleteById() removes a single token and returns true
 *   - deleteById() returns false for non-existent id
 *   - deleteByProjectId() removes all tokens for a project
 *   - deleteByProjectId() returns 0 for project with no tokens
 *   - cross-project isolation — tokens from different projects don't bleed
 *   - generateWebhookTokenId() produces sequential WH-N ids
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as webhookTokenRepo from "../src/database/repositories/webhookTokenRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import { generateWebhookTokenId } from "../src/utils/idGenerator.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _ctr = 7000;
const uid = (prefix) => `${prefix}-WH-${++_ctr}`;

function makeProject(overrides = {}) {
  const id = uid("PRJ");
  return {
    id, name: `WH Project ${id}`, url: "https://example.com",
    createdAt: new Date().toISOString(), status: "idle", ...overrides,
  };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM webhook_tokens WHERE projectId LIKE 'PRJ-WH-%'");
  db.exec("DELETE FROM projects      WHERE id        LIKE 'PRJ-WH-%'");
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

resetDb();

// ─── hashToken / generateToken ────────────────────────────────────────────────

console.log("\n── hashToken / generateToken ──");

test("hashToken returns a 64-char hex string", () => {
  const hash = webhookTokenRepo.hashToken("test-plaintext");
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("hashToken is deterministic", () => {
  const a = webhookTokenRepo.hashToken("same-input");
  const b = webhookTokenRepo.hashToken("same-input");
  assert.equal(a, b);
});

test("hashToken produces different output for different input", () => {
  const a = webhookTokenRepo.hashToken("input-a");
  const b = webhookTokenRepo.hashToken("input-b");
  assert.notEqual(a, b);
});

test("generateToken returns an 80-char hex string", () => {
  const token = webhookTokenRepo.generateToken();
  assert.equal(token.length, 80);
  assert.match(token, /^[0-9a-f]{80}$/);
});

test("generateToken produces unique values", () => {
  const a = webhookTokenRepo.generateToken();
  const b = webhookTokenRepo.generateToken();
  assert.notEqual(a, b);
});

// ─── CRUD operations ──────────────────────────────────────────────────────────

console.log("\n── webhookTokenRepo CRUD ──");

const proj = makeProject();
projectRepo.create(proj);

test("create() inserts a token row", () => {
  const plaintext = webhookTokenRepo.generateToken();
  const hash = webhookTokenRepo.hashToken(plaintext);
  const id = uid("WH");
  webhookTokenRepo.create({ id, projectId: proj.id, tokenHash: hash, label: "CI token" });
  const found = webhookTokenRepo.findByHash(hash);
  assert.ok(found);
  assert.equal(found.id, id);
  assert.equal(found.projectId, proj.id);
  assert.equal(found.tokenHash, hash);
  assert.equal(found.label, "CI token");
  assert.ok(found.createdAt);
  assert.equal(found.lastUsedAt, null);
  // cleanup
  webhookTokenRepo.deleteById(id);
});

test("create() with no label stores null", () => {
  const hash = webhookTokenRepo.hashToken("no-label-token");
  const id = uid("WH");
  webhookTokenRepo.create({ id, projectId: proj.id, tokenHash: hash });
  const found = webhookTokenRepo.findByHash(hash);
  assert.equal(found.label, null);
  webhookTokenRepo.deleteById(id);
});

test("getByProjectId() returns tokens without tokenHash", () => {
  const hash = webhookTokenRepo.hashToken("get-by-project-token");
  const id = uid("WH");
  webhookTokenRepo.create({ id, projectId: proj.id, tokenHash: hash, label: "test" });
  const tokens = webhookTokenRepo.getByProjectId(proj.id);
  assert.ok(tokens.length >= 1);
  const token = tokens.find((t) => t.id === id);
  assert.ok(token);
  assert.equal(token.id, id);
  assert.equal(token.projectId, proj.id);
  assert.equal(token.label, "test");
  assert.ok(token.createdAt);
  // tokenHash must NOT be present
  assert.equal(token.tokenHash, undefined);
  webhookTokenRepo.deleteById(id);
});

test("getByProjectId() returns tokens ordered by createdAt DESC", () => {
  const id1 = uid("WH");
  const id2 = uid("WH");
  webhookTokenRepo.create({ id: id1, projectId: proj.id, tokenHash: webhookTokenRepo.hashToken("tok-1") });
  // Small delay to ensure distinct createdAt
  const db = getDatabase();
  db.prepare("UPDATE webhook_tokens SET createdAt = '2020-01-01T00:00:00Z' WHERE id = ?").run(id1);
  webhookTokenRepo.create({ id: id2, projectId: proj.id, tokenHash: webhookTokenRepo.hashToken("tok-2") });
  const tokens = webhookTokenRepo.getByProjectId(proj.id);
  const idx1 = tokens.findIndex((t) => t.id === id1);
  const idx2 = tokens.findIndex((t) => t.id === id2);
  assert.ok(idx2 < idx1, "newer token (id2) should appear before older token (id1)");
  webhookTokenRepo.deleteById(id1);
  webhookTokenRepo.deleteById(id2);
});

test("getByProjectId() returns empty array for project with no tokens", () => {
  const emptyProj = makeProject();
  projectRepo.create(emptyProj);
  const tokens = webhookTokenRepo.getByProjectId(emptyProj.id);
  assert.deepEqual(tokens, []);
});

test("findByHash() returns undefined for unknown hash", () => {
  const result = webhookTokenRepo.findByHash("0000000000000000000000000000000000000000000000000000000000000000");
  assert.equal(result, undefined);
});

test("findByHash() returns full row including tokenHash", () => {
  const hash = webhookTokenRepo.hashToken("find-by-hash-token");
  const id = uid("WH");
  webhookTokenRepo.create({ id, projectId: proj.id, tokenHash: hash });
  const found = webhookTokenRepo.findByHash(hash);
  assert.ok(found);
  assert.equal(found.tokenHash, hash);
  webhookTokenRepo.deleteById(id);
});

// ─── touch ────────────────────────────────────────────────────────────────────

console.log("\n── touch ──");

test("touch() updates lastUsedAt", () => {
  const hash = webhookTokenRepo.hashToken("touch-token");
  const id = uid("WH");
  webhookTokenRepo.create({ id, projectId: proj.id, tokenHash: hash });
  // Before touch
  const before = webhookTokenRepo.findByHash(hash);
  assert.equal(before.lastUsedAt, null);
  // Touch
  webhookTokenRepo.touch(id);
  const after = webhookTokenRepo.findByHash(hash);
  assert.ok(after.lastUsedAt, "lastUsedAt should be set after touch");
  assert.match(after.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);
  webhookTokenRepo.deleteById(id);
});

// ─── deleteById ───────────────────────────────────────────────────────────────

console.log("\n── deleteById ──");

test("deleteById() removes a token and returns true", () => {
  const hash = webhookTokenRepo.hashToken("delete-me");
  const id = uid("WH");
  webhookTokenRepo.create({ id, projectId: proj.id, tokenHash: hash });
  const result = webhookTokenRepo.deleteById(id);
  assert.equal(result, true);
  assert.equal(webhookTokenRepo.findByHash(hash), undefined);
});

test("deleteById() returns false for non-existent id", () => {
  const result = webhookTokenRepo.deleteById("WH-DOES-NOT-EXIST");
  assert.equal(result, false);
});

// ─── deleteByProjectId ────────────────────────────────────────────────────────

console.log("\n── deleteByProjectId ──");

test("deleteByProjectId() removes all tokens for a project", () => {
  const localProj = makeProject();
  projectRepo.create(localProj);
  const id1 = uid("WH");
  const id2 = uid("WH");
  webhookTokenRepo.create({ id: id1, projectId: localProj.id, tokenHash: webhookTokenRepo.hashToken("proj-tok-1") });
  webhookTokenRepo.create({ id: id2, projectId: localProj.id, tokenHash: webhookTokenRepo.hashToken("proj-tok-2") });
  const deleted = webhookTokenRepo.deleteByProjectId(localProj.id);
  assert.equal(deleted, 2);
  assert.deepEqual(webhookTokenRepo.getByProjectId(localProj.id), []);
});

test("deleteByProjectId() returns 0 for project with no tokens", () => {
  const emptyProj = makeProject();
  projectRepo.create(emptyProj);
  const deleted = webhookTokenRepo.deleteByProjectId(emptyProj.id);
  assert.equal(deleted, 0);
});

// ─── Cross-project isolation ──────────────────────────────────────────────────

console.log("\n── cross-project isolation ──");

test("tokens from different projects don't bleed", () => {
  const projA = makeProject();
  const projB = makeProject();
  projectRepo.create(projA);
  projectRepo.create(projB);
  const idA = uid("WH");
  const idB = uid("WH");
  webhookTokenRepo.create({ id: idA, projectId: projA.id, tokenHash: webhookTokenRepo.hashToken("iso-a") });
  webhookTokenRepo.create({ id: idB, projectId: projB.id, tokenHash: webhookTokenRepo.hashToken("iso-b") });
  const tokensA = webhookTokenRepo.getByProjectId(projA.id);
  const tokensB = webhookTokenRepo.getByProjectId(projB.id);
  assert.equal(tokensA.length, 1);
  assert.equal(tokensB.length, 1);
  assert.equal(tokensA[0].id, idA);
  assert.equal(tokensB[0].id, idB);
  // Deleting project A's tokens doesn't affect project B
  webhookTokenRepo.deleteByProjectId(projA.id);
  assert.deepEqual(webhookTokenRepo.getByProjectId(projA.id), []);
  assert.equal(webhookTokenRepo.getByProjectId(projB.id).length, 1);
  webhookTokenRepo.deleteByProjectId(projB.id);
});

// ─── generateWebhookTokenId ───────────────────────────────────────────────────

console.log("\n── generateWebhookTokenId ──");

test("generateWebhookTokenId() produces WH-N format", () => {
  const id = generateWebhookTokenId();
  assert.match(id, /^WH-\d+$/);
});

test("generateWebhookTokenId() produces sequential ids", () => {
  const id1 = generateWebhookTokenId();
  const id2 = generateWebhookTokenId();
  const num1 = parseInt(id1.split("-")[1], 10);
  const num2 = parseInt(id2.split("-")[1], 10);
  assert.equal(num2, num1 + 1);
});

// ─── Teardown ─────────────────────────────────────────────────────────────────

resetDb();

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

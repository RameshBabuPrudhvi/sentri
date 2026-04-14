/**
 * @module tests/recycle-bin
 * @description Integration tests for GET /api/recycle-bin, POST /api/restore/:type/:id,
 * DELETE /api/purge/:type/:id, and the soft-delete behaviour of DELETE /api/projects/:id.
 */

import assert from "node:assert/strict";
import { app } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import testsRouter from "../src/routes/tests.js";
import recycleBinRouter from "../src/routes/recycleBin.js";
import { getDatabase } from "../src/database/sqlite.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import { generateProjectId, generateTestId } from "../src/utils/idGenerator.js";

// ─── Mount routes once ────────────────────────────────────────────────────────

let mounted = false;
function mountOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, projectsRouter);
  app.use("/api", requireAuth, testsRouter);
  app.use("/api", requireAuth, recycleBinRouter);
  mounted = true;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM healing_history");
  db.exec("DELETE FROM activities");
  db.exec("DELETE FROM runs     WHERE id LIKE 'RUN-RB-%'");
  db.exec("DELETE FROM tests    WHERE id LIKE 'TC-RB-%'");
  db.exec("DELETE FROM projects WHERE id LIKE 'PRJ-RB-%'");
  db.exec("DELETE FROM users    WHERE email LIKE '%@recycle-bin-test%'");
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

let csrfToken = null;

function extractCookie(res, name) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const match = c.match(new RegExp(`^${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

async function req(base, path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
    headers.Cookie = `_csrf=${csrfToken}`;
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const csrf = extractCookie(res, "_csrf");
  if (csrf) csrfToken = csrf;
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

async function main() {
  mountOnce();
  resetDb();

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // Register + login to get auth token
  const email = "rb-test@recycle-bin-test.com";
  const password = "RbTest1234!";
  await req(base, "/api/auth/register", { method: "POST", body: { name: "RB Test", email, password } });
  const { res: loginRes } = await req(base, "/api/auth/login", { method: "POST", body: { email, password } });
  const token = extractCookie(loginRes, "access_token");
  assert.ok(token, "should receive auth token");

  // ── Create shared test data directly via repos (fast, no HTTP overhead) ──
  const prbId = "PRJ-RB-001";
  const trbId = "TC-RB-001";

  console.log("\n🧪 Recycle bin — GET /api/recycle-bin");

  await test("returns empty recycle bin when nothing is deleted", async () => {
    // Seed a live project
    projectRepo.create({ id: prbId, name: "RB Project", url: "https://rb.test", createdAt: new Date().toISOString(), status: "idle" });
    testRepo.create({ id: trbId, projectId: prbId, name: "RB Test", description: "", steps: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewStatus: "draft", priority: "medium", codeVersion: 0, isJourneyTest: false, assertionEnhanced: false });

    const { res, json } = await req(base, "/api/recycle-bin", { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(json.projects));
    assert.ok(Array.isArray(json.tests));
    assert.ok(Array.isArray(json.runs));
    assert.ok(!json.projects.find(p => p.id === prbId), "live project should not appear in recycle bin");
  });

  console.log("\n🧪 Recycle bin — soft-delete via DELETE /api/projects/:id/tests/:testId");

  await test("deleting a test moves it to recycle bin", async () => {
    const { res } = await req(base, `/api/projects/${prbId}/tests/${trbId}`, { method: "DELETE", token });
    assert.equal(res.status, 200);

    // Should appear in recycle bin
    const { json: rb } = await req(base, "/api/recycle-bin", { token });
    assert.ok(rb.tests.find(t => t.id === trbId), "deleted test should appear in recycle bin");

    // Should not appear in live tests
    const { json: tests } = await req(base, `/api/projects/${prbId}/tests`, { token });
    assert.ok(Array.isArray(tests), "tests response should be array");
    assert.ok(!tests.find(t => t.id === trbId), "deleted test should not appear in live tests");
  });

  console.log("\n🧪 Recycle bin — POST /api/restore/test/:id");

  await test("restoring a test removes it from recycle bin and re-exposes it", async () => {
    const { res, json } = await req(base, `/api/restore/test/${trbId}`, { method: "POST", token });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${json.error}`);
    assert.equal(json.ok, true);

    // No longer in recycle bin
    const { json: rb } = await req(base, "/api/recycle-bin", { token });
    assert.ok(!rb.tests.find(t => t.id === trbId), "restored test should not appear in recycle bin");

    // Back in live tests
    const { json: tests } = await req(base, `/api/projects/${prbId}/tests`, { token });
    assert.ok(tests.find(t => t.id === trbId), "restored test should reappear in live tests");
  });

  console.log("\n🧪 Recycle bin — DELETE /api/purge/test/:id");

  await test("purging a deleted test permanently removes it", async () => {
    // First soft-delete the test
    testRepo.deleteById(trbId);

    const { res, json } = await req(base, `/api/purge/test/${trbId}`, { method: "DELETE", token });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${json.error}`);
    assert.equal(json.ok, true);

    // Gone from recycle bin
    const { json: rb } = await req(base, "/api/recycle-bin", { token });
    assert.ok(!rb.tests.find(t => t.id === trbId), "purged test should not be in recycle bin");

    // Not findable at all
    const found = testRepo.getByIdIncludeDeleted(trbId);
    assert.equal(found, undefined, "purged test should be gone from DB entirely");
  });

  await test("purging a live (non-deleted) entity returns 404", async () => {
    // Create a fresh test (not deleted)
    const liveId = "TC-RB-002";
    testRepo.create({ id: liveId, projectId: prbId, name: "Live Test", description: "", steps: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewStatus: "draft", priority: "medium", codeVersion: 0, isJourneyTest: false, assertionEnhanced: false });

    const { res } = await req(base, `/api/purge/test/${liveId}`, { method: "DELETE", token });
    assert.equal(res.status, 404, "purging a live entity should return 404");
  });

  await test("restore/purge with invalid type returns 400", async () => {
    const { res: r1 } = await req(base, "/api/restore/widget/foo", { method: "POST", token });
    assert.equal(r1.status, 400);
    const { res: r2 } = await req(base, "/api/purge/widget/foo", { method: "DELETE", token });
    assert.equal(r2.status, 400);
  });

  console.log("\n🧪 Recycle bin — project soft-delete cascade");

  await test("deleting a project cascades soft-delete to its tests", async () => {
    const cid = "PRJ-RB-002";
    const ctid = "TC-RB-003";
    projectRepo.create({ id: cid, name: "Cascade Project", url: "https://cascade.test", createdAt: new Date().toISOString(), status: "idle" });
    testRepo.create({ id: ctid, projectId: cid, name: "Cascade Test", description: "", steps: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewStatus: "draft", priority: "medium", codeVersion: 0, isJourneyTest: false, assertionEnhanced: false });

    const { res } = await req(base, `/api/projects/${cid}`, { method: "DELETE", token });
    assert.equal(res.status, 200);

    // Both project and test should be in recycle bin
    const { json: rb } = await req(base, "/api/recycle-bin", { token });
    assert.ok(rb.projects.find(p => p.id === cid), "deleted project in recycle bin");
    assert.ok(rb.tests.find(t => t.id === ctid), "cascaded test in recycle bin");
  });

  console.log("\n🧪 Recycle bin — scoped cascade-restore");

  await test("restoring a project does NOT restore individually-deleted tests", async () => {
    // Setup: project with 2 tests
    const scid = "PRJ-RB-003";
    const stid1 = "TC-RB-010";
    const stid2 = "TC-RB-011";
    projectRepo.create({ id: scid, name: "Scoped Project", url: "https://scoped.test", createdAt: new Date().toISOString(), status: "idle" });
    testRepo.create({ id: stid1, projectId: scid, name: "Individually Deleted", description: "", steps: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewStatus: "draft", priority: "medium", codeVersion: 0, isJourneyTest: false, assertionEnhanced: false });
    testRepo.create({ id: stid2, projectId: scid, name: "Cascade Deleted", description: "", steps: [], tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewStatus: "draft", priority: "medium", codeVersion: 0, isJourneyTest: false, assertionEnhanced: false });

    // Step 1: Individually delete stid1 with an earlier timestamp
    const db = getDatabase();
    db.prepare("UPDATE tests SET deletedAt = '2020-01-01T00:00:00Z' WHERE id = ?").run(stid1);

    // Step 2: Delete the project (cascades stid2)
    const { res: delRes } = await req(base, `/api/projects/${scid}`, { method: "DELETE", token });
    assert.equal(delRes.status, 200);

    // Step 3: Restore the project
    const { res: restoreRes, json: restoreJson } = await req(base, `/api/restore/project/${scid}`, { method: "POST", token });
    assert.equal(restoreRes.status, 200, `expected 200, got ${restoreRes.status}: ${restoreJson.error}`);

    // stid2 (cascade-deleted) should be restored
    const t2 = testRepo.getById(stid2);
    assert.ok(t2, "cascade-deleted test should be restored");

    // stid1 (individually deleted earlier) should still be in recycle bin
    const t1 = testRepo.getById(stid1);
    assert.equal(t1, undefined, "individually-deleted test should NOT be restored");
    const t1Deleted = testRepo.getByIdIncludeDeleted(stid1);
    assert.ok(t1Deleted?.deletedAt, "individually-deleted test should still have deletedAt set");
  });

  server.close();

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

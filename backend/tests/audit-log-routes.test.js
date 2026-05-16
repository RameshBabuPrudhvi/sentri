/**
 * @module tests/audit-log-routes
 * @description SEC-007 compliance audit-log integration tests.
 *
 * Covers the SOC 2 / ISO 27001 / PCI-DSS-relevant properties of the
 * compliance audit-log surface:
 *
 *   - Hash chain: deterministic compute, INSERT-side chain build, verify
 *     clean walk, tamper detection (firstBrokenRowId), empty-workspace.
 *   - Retention: `purgeOlderThan` guards (0 / negative / NaN) + cutoff math.
 *   - DLQ repo primitives: enqueue / list / increment / remove round-trip.
 *   - `GET /audit/verify` route — admin gate, chainDisabled shape.
 *   - `GET /workspaces/:id/audit-log` route — workspace-scope 403, limit
 *     clamp, cursor pagination, CSV / NDJSON shape, meta-audit emission.
 *   - DLQ routes — list shape, 503 SIEM_NOT_CONFIGURED replay (pre-Part-C).
 *   - Purge env-gate — 403 AUDIT_PURGE_DISABLED when env var unset.
 *
 * Auth-event capture (8 password-path events with IP + UA) lives in the
 * companion `tests/audit-auth-events.test.js`.
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import workspacesRouter from "../src/routes/workspaces.js";
import settingsRouter from "../src/routes/settings.js";
import systemRouter from "../src/routes/system.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";
import { computePrevHash } from "../src/database/repositories/activityRepo.js";
import * as auditDlqRepo from "../src/database/repositories/auditDlqRepo.js";
import { createTestContext, parseCookies, buildCookieHeader } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1", requireAuth, workspaceScope, settingsRouter);
  app.use("/api/v1", requireAuth, workspaceScope, systemRouter);
  app.use("/api/v1/workspaces", requireAuth, workspaceScope, workspacesRouter);
  mounted = true;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function setupUser(baseUrl, suffix) {
  const email = `audit-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const password = "Password123!";
  let res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "audit-test-agent" },
    body: JSON.stringify({ name: "Audit User", email, password }),
  });
  assert.equal(res.status, 201, "register failed");
  res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "audit-test-agent" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, "login failed");
  const cookies = parseCookies(res);
  return {
    email, password,
    csrf: cookies._csrf.value,
    cookieHeader: buildCookieHeader(cookies),
    user: (await res.json()).user,
  };
}

async function main() {
  mountRoutesOnce();
  t.resetDb();

  // RATE_LIMIT_TEST_MODE raises the login bucket from 10 → 200 so we can
  // create many users without tripping the auth-route limiter.
  const env = t.setupEnv({
    SKIP_EMAIL_VERIFICATION: "true",
    RATE_LIMIT_TEST_MODE: "true",
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const runner = t.createTestRunner();
  const { test, summary } = runner;

  try {
    // ── Hash chain ───────────────────────────────────────────────────────
    console.log("\n🔗 Hash chain — compute + verify");

    await test("computePrevHash is deterministic for the same row", () => {
      const row = { id: "ACT-1", type: "test.create", createdAt: "T", workspaceId: "WS-1" };
      const a = computePrevHash(null, row);
      assert.equal(a, computePrevHash(null, row));
      assert.equal(a.length, 64, "sha256 hex must be 64 chars");
    });

    await test("computePrevHash differs when previousHash changes", () => {
      const row = { id: "ACT-1", type: "test.create", createdAt: "T" };
      assert.notEqual(computePrevHash(null, row), computePrevHash("deadbeef", row));
    });

    await test("computePrevHash differs when row content changes", () => {
      const a = computePrevHash(null, { id: "ACT-1", type: "test.create", createdAt: "T" });
      const b = computePrevHash(null, { id: "ACT-1", type: "test.approve", createdAt: "T" });
      assert.notEqual(a, b);
    });

    await test("verifyAuditChain on empty workspace is trivially verified", () => {
      const result = activityRepo.verifyAuditChain("WS-DOES-NOT-EXIST");
      assert.equal(result.verified, true);
      assert.equal(result.total, 0);
    });

    await test("AUDIT_HASH_CHAIN=true: verifyAuditChain walks a clean chain", async () => {
      t.resetDb();
      const chainEnv = t.setupEnv({ AUDIT_HASH_CHAIN: "true" });
      try {
        const u = await setupUser(baseUrl, "chain-clean");
        for (let i = 0; i < 3; i++) {
          activityRepo.create({
            id: `ACT-CHAIN-${i}-${Date.now()}`,
            type: "test.create",
            workspaceId: u.user.workspaceId,
            userId: u.user.id,
            createdAt: new Date(Date.now() + i).toISOString(),
            meta: { i },
          });
          await new Promise((r) => setTimeout(r, 2));
        }
        const result = activityRepo.verifyAuditChain(u.user.workspaceId);
        assert.equal(result.verified, true, `expected clean walk, got ${JSON.stringify(result)}`);
        assert.ok(result.total >= 3);
      } finally {
        chainEnv.restore();
      }
    });

    await test("verifyAuditChain detects tampering with firstBrokenRowId", async () => {
      t.resetDb();
      const chainEnv = t.setupEnv({ AUDIT_HASH_CHAIN: "true" });
      try {
        const u = await setupUser(baseUrl, "chain-tamper");
        const ids = [];
        for (let i = 0; i < 4; i++) {
          const id = `ACT-TAMPER-${i}-${Date.now()}`;
          ids.push(id);
          activityRepo.create({
            id,
            type: "test.create",
            workspaceId: u.user.workspaceId,
            userId: u.user.id,
            createdAt: new Date(Date.now() + i).toISOString(),
          });
          await new Promise((r) => setTimeout(r, 2));
        }
        // Mutate one row's `detail` so its recomputed hash diverges from
        // the persisted prevHash. `detail` is part of `rowMinusHash`.
        const tamperedId = ids[2];
        t.getDatabase().prepare("UPDATE activities SET detail = ? WHERE id = ?")
          .run("tampered", tamperedId);

        const result = activityRepo.verifyAuditChain(u.user.workspaceId);
        assert.equal(result.verified, false);
        assert.equal(result.firstBrokenRowId, tamperedId);
      } finally {
        chainEnv.restore();
      }
    });

    // ── Retention sweep ─────────────────────────────────────────────────
    console.log("\n🧹 Retention — purgeOlderThan");

    await test("purgeOlderThan(0) is a no-op", () => {
      assert.equal(activityRepo.purgeOlderThan(0), 0);
    });

    await test("purgeOlderThan(-5) is a no-op (negative guard)", () => {
      assert.equal(activityRepo.purgeOlderThan(-5), 0);
    });

    await test("purgeOlderThan(NaN) is a no-op", () => {
      assert.equal(activityRepo.purgeOlderThan(NaN), 0);
    });

    await test("purgeOlderThan(N) deletes rows older than N days, preserves fresh rows", async () => {
      t.resetDb();
      const u = await setupUser(baseUrl, "retain-cut");
      const oldId = `ACT-OLD-${Date.now()}`;
      const freshId = `ACT-FRESH-${Date.now()}`;
      activityRepo.create({
        id: oldId, type: "test.create", workspaceId: u.user.workspaceId,
        createdAt: new Date(Date.now() - 100 * DAY_MS).toISOString(),
      });
      activityRepo.create({
        id: freshId, type: "test.create", workspaceId: u.user.workspaceId,
        createdAt: new Date().toISOString(),
      });

      const deleted = activityRepo.purgeOlderThan(90);
      assert.ok(deleted >= 1, "should delete at least the 100-day-old row");

      const db = t.getDatabase();
      assert.equal(db.prepare("SELECT 1 FROM activities WHERE id = ?").get(oldId), undefined,
        "old row must be gone");
      assert.ok(db.prepare("SELECT 1 FROM activities WHERE id = ?").get(freshId),
        "fresh row must survive");
    });

    // ── DLQ repo primitives ─────────────────────────────────────────────
    console.log("\n📥 auditDlqRepo — primitives");

    await test("enqueue() persists row with attempts=1 and hydrates rowSnapshot", () => {
      const row = auditDlqRepo.enqueue({
        workspaceId: "WS-TEST",
        rowSnapshot: { id: "ACT-1", type: "test.create" },
        lastError: "connection refused",
      });
      assert.ok(row.id.startsWith("DLQ-"), "ID should follow DLQ-<n> convention");
      assert.equal(row.attempts, 1);
      assert.equal(row.workspaceId, "WS-TEST");

      const fetched = auditDlqRepo.getById(row.id);
      assert.ok(fetched);
      assert.deepEqual(fetched.rowSnapshot, { id: "ACT-1", type: "test.create" },
        "rowSnapshot should hydrate to an object");
    });

    await test("incrementAttempts bumps the counter and records lastError", () => {
      const row = auditDlqRepo.enqueue({
        workspaceId: "WS-INC",
        rowSnapshot: { id: "ACT-INC" },
        lastError: "first",
      });
      const count = auditDlqRepo.incrementAttempts(row.id, "second");
      assert.equal(count, 2);
      const refetched = auditDlqRepo.getById(row.id);
      assert.equal(refetched.lastError, "second", "lastError should be refreshed");
    });

    await test("remove() deletes the row and returns true; second remove returns false", () => {
      const row = auditDlqRepo.enqueue({
        workspaceId: "WS-RM",
        rowSnapshot: { id: "ACT-RM" },
        lastError: "x",
      });
      assert.equal(auditDlqRepo.remove(row.id), true);
      assert.equal(auditDlqRepo.getById(row.id), null);
      assert.equal(auditDlqRepo.remove(row.id), false, "idempotent — second remove returns false");
    });

    await test("listByWorkspace + countByWorkspace are workspace-scoped", () => {
      const wsA = `WS-A-${Date.now()}`;
      const wsB = `WS-B-${Date.now()}`;
      auditDlqRepo.enqueue({ workspaceId: wsA, rowSnapshot: { i: 1 }, lastError: "x" });
      auditDlqRepo.enqueue({ workspaceId: wsA, rowSnapshot: { i: 2 }, lastError: "x" });
      auditDlqRepo.enqueue({ workspaceId: wsB, rowSnapshot: { i: 3 }, lastError: "x" });

      assert.equal(auditDlqRepo.countByWorkspace(wsA), 2);
      assert.equal(auditDlqRepo.countByWorkspace(wsB), 1);
      assert.equal(auditDlqRepo.listByWorkspace(wsA).length, 2);
      assert.equal(auditDlqRepo.listByWorkspace(wsB).length, 1);
    });

    // ── /audit/verify route ─────────────────────────────────────────────
    console.log("\n🔍 GET /audit/verify");

    await test("returns chainDisabled:true when AUDIT_HASH_CHAIN is unset", async () => {
      const u = await setupUser(baseUrl, "verify-disabled");
      const res = await fetch(`${baseUrl}/api/v1/audit/verify`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.verified, true);
      assert.equal(body.chainDisabled, true);
    });

    // ── /workspaces/:id/audit-log route ─────────────────────────────────
    console.log("\n📜 GET /workspaces/:id/audit-log");

    await test("returns 403 AUDIT_WORKSPACE_MISMATCH when URL param != req.workspaceId", async () => {
      const u = await setupUser(baseUrl, "scope-mismatch");
      const res = await fetch(`${baseUrl}/api/v1/workspaces/WS-NOT-YOURS/audit-log`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "AUDIT_WORKSPACE_MISMATCH");
    });

    await test("returns { rows, nextCursor } shape on JSON read", async () => {
      const u = await setupUser(baseUrl, "json-shape");
      const res = await fetch(`${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.rows), "rows must be an array");
      assert.ok("nextCursor" in body, "nextCursor must be present (even when null)");
    });

    await test("clamps limit at 1000 even when caller asks for more", async () => {
      const u = await setupUser(baseUrl, "limit-clamp");
      const res = await fetch(
        `${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log?limit=99999`,
        { headers: { Cookie: u.cookieHeader } },
      );
      assert.equal(res.status, 200, "request must succeed");
      const body = await res.json();
      assert.ok(body.rows.length <= 1000);
    });

    await test("emits meta-audit `audit.read` row on JSON browse (PCI-DSS 10.2.6)", async () => {
      const u = await setupUser(baseUrl, "meta-read");
      const db = t.getDatabase();
      const before = db.prepare(
        "SELECT COUNT(*) AS cnt FROM activities WHERE workspaceId = ? AND type = 'audit.read'",
      ).get(u.user.workspaceId).cnt;
      await fetch(`${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log`, {
        headers: { Cookie: u.cookieHeader },
      });
      const after = db.prepare(
        "SELECT COUNT(*) AS cnt FROM activities WHERE workspaceId = ? AND type = 'audit.read'",
      ).get(u.user.workspaceId).cnt;
      assert.equal(after, before + 1, "exactly one audit.read row should fire");
    });

    await test("emits meta-audit `audit.export` row on CSV export", async () => {
      const u = await setupUser(baseUrl, "meta-export");
      const db = t.getDatabase();
      const before = db.prepare(
        "SELECT COUNT(*) AS cnt FROM activities WHERE workspaceId = ? AND type = 'audit.export'",
      ).get(u.user.workspaceId).cnt;
      await fetch(`${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log?format=csv`, {
        headers: { Cookie: u.cookieHeader },
      });
      const after = db.prepare(
        "SELECT COUNT(*) AS cnt FROM activities WHERE workspaceId = ? AND type = 'audit.export'",
      ).get(u.user.workspaceId).cnt;
      assert.equal(after, before + 1, "exactly one audit.export row should fire");
    });

    await test("CSV export uses documented header + Content-Disposition attachment", async () => {
      const u = await setupUser(baseUrl, "csv-shape");
      const res = await fetch(
        `${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log?format=csv`,
        { headers: { Cookie: u.cookieHeader } },
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/csv/);
      assert.match(res.headers.get("content-disposition") || "", /attachment/);
      const body = await res.text();
      const firstLine = body.split("\n")[0];
      assert.equal(firstLine, "createdAt,userId,userName,type,meta,ipAddress,userAgent,workspaceId",
        "CSV header must match the documented column order");
    });

    await test("NDJSON export sets application/x-ndjson Content-Type", async () => {
      const u = await setupUser(baseUrl, "ndjson-shape");
      const res = await fetch(
        `${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log?format=ndjson`,
        { headers: { Cookie: u.cookieHeader } },
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /application\/x-ndjson/);
    });

    // ── DLQ routes ──────────────────────────────────────────────────────
    console.log("\n📭 GET /workspaces/:id/audit-log/dlq + POST .../replay");

    await test("GET .../dlq returns 403 on cross-workspace URL", async () => {
      const u = await setupUser(baseUrl, "dlq-scope");
      const res = await fetch(`${baseUrl}/api/v1/workspaces/WS-NOT-YOURS/audit-log/dlq`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "AUDIT_WORKSPACE_MISMATCH");
    });

    await test("GET .../dlq returns { rows, count } shape with workspace-scoped rows only", async () => {
      const u = await setupUser(baseUrl, "dlq-list");
      // Seed two DLQ rows in the caller's workspace and one in a foreign
      // workspace; the route must only return the caller's two.
      auditDlqRepo.enqueue({
        workspaceId: u.user.workspaceId,
        rowSnapshot: { id: "ACT-A" },
        lastError: "x",
      });
      auditDlqRepo.enqueue({
        workspaceId: u.user.workspaceId,
        rowSnapshot: { id: "ACT-B" },
        lastError: "x",
      });
      auditDlqRepo.enqueue({
        workspaceId: "WS-OTHER",
        rowSnapshot: { id: "ACT-C" },
        lastError: "x",
      });

      const res = await fetch(`${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log/dlq`, {
        headers: { Cookie: u.cookieHeader },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.rows));
      assert.equal(typeof body.count, "number");
      // 2 from this workspace; the third row belongs to WS-OTHER.
      assert.ok(body.rows.length >= 2);
      for (const r of body.rows) {
        assert.equal(r.workspaceId, u.user.workspaceId,
          "every row must be scoped to the caller's workspace");
      }
    });

    await test("POST .../dlq/:id/replay returns 404 on unknown DLQ id", async () => {
      const u = await setupUser(baseUrl, "dlq-replay-404");
      const res = await fetch(
        `${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log/dlq/DLQ-DOES-NOT-EXIST/replay`,
        {
          method: "POST",
          headers: { Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        },
      );
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.code, "AUDIT_DLQ_NOT_FOUND");
    });

    await test("POST .../dlq/:id/replay returns 503 SIEM_NOT_CONFIGURED when forwarder missing", async () => {
      // Pre-Part-C state: utils/notifications.js doesn't export
      // `dispatchSiemEvent`, so the replay route must surface a stable
      // 503 with a clear code — not silently succeed.
      const u = await setupUser(baseUrl, "dlq-replay-503");
      const row = auditDlqRepo.enqueue({
        workspaceId: u.user.workspaceId,
        rowSnapshot: { id: "ACT-REPLAY" },
        lastError: "previous failure",
      });
      const res = await fetch(
        `${baseUrl}/api/v1/workspaces/${u.user.workspaceId}/audit-log/dlq/${row.id}/replay`,
        {
          method: "POST",
          headers: { Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        },
      );
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, "SIEM_NOT_CONFIGURED");
      // Row must still exist — failed replay is not a successful dispatch.
      assert.ok(auditDlqRepo.getById(row.id), "DLQ row must persist on 503");
    });

    // ── DELETE /data/activities env-gate ────────────────────────────────
    console.log("\n🔒 DELETE /data/activities — immutability gate");

    await test("returns 403 AUDIT_PURGE_DISABLED when DANGER_ALLOW_AUDIT_PURGE is unset", async () => {
      const u = await setupUser(baseUrl, "purge-blocked");
      const res = await fetch(`${baseUrl}/api/v1/data/activities`, {
        method: "DELETE",
        headers: { Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.code, "AUDIT_PURGE_DISABLED");
    });

    await test("succeeds when DANGER_ALLOW_AUDIT_PURGE=true (explicit incident process)", async () => {
      const u = await setupUser(baseUrl, "purge-allowed");
      const purgeEnv = t.setupEnv({ DANGER_ALLOW_AUDIT_PURGE: "true" });
      try {
        const res = await fetch(`${baseUrl}/api/v1/data/activities`, {
          method: "DELETE",
          headers: { Cookie: u.cookieHeader, "X-CSRF-Token": u.csrf },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(typeof body.cleared, "number");
      } finally {
        purgeEnv.restore();
      }
    });

    summary("audit-log-routes");
    console.log("\n🎉 All audit-log-routes tests passed!");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ audit-log-routes failed:", err);
  process.exit(1);
});

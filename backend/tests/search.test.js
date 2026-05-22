/**
 * @module tests/search
 * @description Integration tests for GET /api/v1/search (GAP-001).
 *
 * Covers: ACL workspace scoping, prefix-vs-substring ranking, LIKE escaping,
 * empty-query short-circuit, query-length cap, per-type result cap, and the
 * `truncated` flag.
 */
import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import searchRouter from "../src/routes/search.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/v1", requireAuth, workspaceScope, searchRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // ── Workspace A: the searcher ─────────────────────────────────────────
    const a = await t.registerAndLogin(base, {
      name: "QA A", email: "search-a@example.com", password: "Password123!",
    });
    const wsA = a.payload.workspaceId;

    // ── Workspace B: cross-tenant control row that MUST NOT leak ──────────
    const b = await t.registerAndLogin(base, {
      name: "QA B", email: "search-b@example.com", password: "Password123!",
    });
    const wsB = b.payload.workspaceId;

    const nowIso = new Date().toISOString();

    // Seed workspace A
    projectRepo.create({
      id: "PRJ-A1", workspaceId: wsA, name: "Checkout flow", url: "https://shop.example.com",
      createdAt: nowIso, status: "idle",
    });
    projectRepo.create({
      id: "PRJ-A2", workspaceId: wsA, name: "Stock dashboard", url: "https://stock.example.com",
      createdAt: nowIso, status: "idle",
    });
    testRepo.create({
      id: "TC-A1", projectId: "PRJ-A1", workspaceId: wsA, createdAt: nowIso,
      name: "Checkout: card payment", reviewStatus: "approved",
    });
    testRepo.create({
      id: "TC-A2", projectId: "PRJ-A2", workspaceId: wsA, createdAt: nowIso,
      name: "Stock check refresh", reviewStatus: "draft",
    });
    // Test with LIKE metachars in name — must match literally, not as wildcards.
    testRepo.create({
      id: "TC-A3", projectId: "PRJ-A1", workspaceId: wsA, createdAt: nowIso,
      name: "50%_off promo", reviewStatus: "draft",
    });
    runRepo.create({
      id: "RUN-A1", projectId: "PRJ-A1", type: "test_run", status: "completed",
      startedAt: nowIso,
    });

    // Seed workspace B (cross-tenant)
    projectRepo.create({
      id: "PRJ-B1", workspaceId: wsB, name: "Checkout secret", url: "https://b.example.com",
      createdAt: nowIso, status: "idle",
    });
    testRepo.create({
      id: "TC-B1", projectId: "PRJ-B1", workspaceId: wsB, createdAt: nowIso,
      name: "Checkout admin override", reviewStatus: "approved",
    });

    // ── Empty query → empty result, no error ──────────────────────────────
    let out = await t.req(base, "/api/v1/search?q=", { method: "GET", token: a.token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.totalCount, 0);
    assert.deepEqual(out.json.groups.projects, []);
    assert.deepEqual(out.json.groups.tests, []);
    assert.deepEqual(out.json.groups.runs, []);

    // ── Query below MIN_QUERY_LEN (=2) → empty result ─────────────────────
    out = await t.req(base, "/api/v1/search?q=c", { method: "GET", token: a.token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.totalCount, 0);

    // ── Real query: prefix-first ranking on projects ──────────────────────
    out = await t.req(base, "/api/v1/search?q=Check", { method: "GET", token: a.token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.groups.projects.length, 1);
    assert.equal(out.json.groups.projects[0].id, "PRJ-A1");
    assert.equal(out.json.groups.projects[0].name, "Checkout flow");
    // Tests: prefix "Check" matches "Checkout: card payment" (prefix) AND
    // — case-insensitively for SQLite LIKE — "Stock check refresh" is NOT a
    // prefix match. Confirm only the prefix-match appears at the top.
    assert.equal(out.json.groups.tests[0].id, "TC-A1");

    // ── Cross-tenant isolation: ws A search must NOT return ws B rows ─────
    const aIds = new Set(out.json.groups.projects.map((p) => p.id));
    assert.equal(aIds.has("PRJ-B1"), false, "ws B project must not leak");
    const aTestIds = new Set(out.json.groups.tests.map((t) => t.id));
    assert.equal(aTestIds.has("TC-B1"), false, "ws B test must not leak");

    // ── LIKE escaping: query "50%" must match the literal "50%_off promo" ─
    // without `%` being interpreted as a wildcard (which would match every
    // other row in the workspace).
    out = await t.req(base, "/api/v1/search?q=50%25_off", { method: "GET", token: a.token });
    assert.equal(out.res.status, 200);
    // Single test row matches; no project / run matches.
    assert.equal(out.json.groups.tests.length, 1);
    assert.equal(out.json.groups.tests[0].id, "TC-A3");

    // ── Run lookup by id paste ────────────────────────────────────────────
    out = await t.req(base, "/api/v1/search?q=RUN-A1", { method: "GET", token: a.token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.groups.runs.length, 1);
    assert.equal(out.json.groups.runs[0].id, "RUN-A1");
    assert.equal(out.json.groups.runs[0].projectName, "Checkout flow");

    // ── Query-length cap → 400 ────────────────────────────────────────────
    const huge = "a".repeat(201);
    out = await t.req(base, `/api/v1/search?q=${huge}`, { method: "GET", token: a.token });
    assert.equal(out.res.status, 400);

    // ── Per-type cap + truncated flag ─────────────────────────────────────
    // Seed 7 projects matching "perf" — only 5 should come back, truncated=true.
    for (let i = 0; i < 7; i++) {
      projectRepo.create({
        id: `PRJ-PERF-${i}`, workspaceId: wsA, name: `Perf project ${i}`, url: `https://p${i}.test`,
        createdAt: nowIso, status: "idle",
      });
    }
    out = await t.req(base, "/api/v1/search?q=Perf", { method: "GET", token: a.token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.groups.projects.length, 5, "MAX_PER_TYPE = 5");
    assert.equal(out.json.truncated, true);
  } finally {
    env.restore();
    await new Promise((r) => server.close(r));
  }
}

main().then(() => console.log("search.test.js passed")).catch((e) => { console.error(e); process.exit(1); });

/**
 * @module tests/api-versioning
 * @description Integration tests for INF-005 API versioning, DIF-011 testsByUrl, and AUTO-016b dashboard rollups.
 *
 * Verifies:
 * - Legacy /api/* paths are 308-redirected to /api/v1/*
 * - Versioned /api/v1/* endpoints respond correctly
 * - Dashboard response includes testsByUrl (DIF-011)
 * - Dashboard response includes topAccessibilityOffenders (AUTO-016b)
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import dashboardRouter from "../src/routes/dashboard.js";

const t = createTestContext();
const { app, req, workspaceScope } = t;
const { test, summary } = t.createTestRunner();

let mounted = false;

function mountRoutesOnce() {
  if (mounted) return;
  // Mount auth at BOTH paths: /api/auth (for test-base.js registerAndLogin helper)
  // and /api/v1/auth (the versioned path we're testing).
  app.use("/api/auth", authRouter);
  app.use("/api/v1/auth", authRouter);
  // Mount dashboard at versioned path with auth + workspace scope
  app.use("/api/v1", requireAuth, workspaceScope, dashboardRouter);
  // Legacy redirect handler (mirrors index.js) — only for non-auth paths
  // since auth is mounted at both prefixes above.
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/v1")) return next();
    // Auth is already mounted at /api/auth — only redirect other paths
    if (req.path.startsWith("/auth")) return next();
    const newUrl = `/api/v1${req.path}${req._parsedUrl?.search || ""}`;
    res.redirect(308, newUrl);
  });
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();

  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // Register and login to get auth token
    const { token } = await t.registerAndLogin(base, {
      name: "Versioning User",
      email: `versioning-${Date.now()}@test.local`,
      password: "Password123!",
    });

    console.log("\n🧪 INF-005: Legacy redirect");

    await test("GET /api/dashboard redirects to /api/v1/dashboard with 308", async () => {
      const res = await fetch(`${base}/api/dashboard`, { redirect: "manual" });
      assert.equal(res.status, 308, `Expected 308, got ${res.status}`);
      const location = res.headers.get("location");
      assert.ok(location.includes("/api/v1/dashboard"), `Expected redirect to /api/v1/dashboard, got ${location}`);
    });

    await test("GET /api/v1/dashboard does NOT redirect (serves directly)", async () => {
      const out = await req(base, "/api/v1/dashboard", { token });
      assert.equal(out.res.status, 200, `Expected 200, got ${out.res.status}`);
    });

    console.log("\n🧪 INF-005: Versioned endpoints work");

    await test("GET /api/v1/dashboard returns valid JSON with auth", async () => {
      const out = await req(base, "/api/v1/dashboard", { token });
      assert.equal(out.res.status, 200, `Expected 200, got ${out.res.status}`);
      assert.ok(out.json.totalProjects !== undefined, "Expected totalProjects in response");
      assert.ok(out.json.totalTests !== undefined, "Expected totalTests in response");
    });

    await test("GET /api/v1/dashboard returns 401 without auth", async () => {
      const out = await req(base, "/api/v1/dashboard");
      assert.equal(out.res.status, 401, `Expected 401, got ${out.res.status}`);
    });

    console.log("\n🧪 DIF-011: testsByUrl in dashboard response");

    await test("dashboard response includes testsByUrl object", async () => {
      const out = await req(base, "/api/v1/dashboard", { token });
      assert.equal(out.res.status, 200);
      assert.ok("testsByUrl" in out.json, "Expected testsByUrl key in dashboard response");
      assert.equal(typeof out.json.testsByUrl, "object", "testsByUrl should be an object");
    });

    await test("testsByUrl is empty when no approved tests exist", async () => {
      const out = await req(base, "/api/v1/dashboard", { token });
      assert.equal(out.res.status, 200);
      assert.deepEqual(out.json.testsByUrl, {}, "testsByUrl should be empty with no approved tests");
    });

    console.log("\n🧪 AUTO-016b: topAccessibilityOffenders in dashboard response");

    await test("dashboard response includes topAccessibilityOffenders array", async () => {
      const out = await req(base, "/api/v1/dashboard", { token });
      assert.equal(out.res.status, 200);
      assert.ok("topAccessibilityOffenders" in out.json, "Expected topAccessibilityOffenders key in dashboard response");
      assert.equal(Array.isArray(out.json.topAccessibilityOffenders), true, "topAccessibilityOffenders should be an array");
    });

    await test("topAccessibilityOffenders aggregates per project, sorts desc, caps at 5", async () => {
      // Register a fresh user and seed data in their workspace so the dashboard
      // (scoped by req.workspaceId) returns the seeded offenders.
      const seeder = await t.registerAndLogin(base, {
        name: "Offender Seeder",
        email: `offender-${Date.now()}@test.local`,
        password: "Password123!",
      });
      const workspaceId = seeder.payload.workspaceId;
      assert.ok(workspaceId, "test user should have a workspaceId in JWT");

      const db = t.getDatabase();
      const accessibilityViolationRepo = await import(
        "../src/database/repositories/accessibilityViolationRepo.js"
      );

      // Seed 6 projects with descending violation counts to exercise both
      // the desc sort and the slice(0, 5) cap.
      const now = new Date().toISOString();
      const counts = [60, 50, 40, 30, 20, 10];
      for (let i = 0; i < counts.length; i++) {
        const projectId = `PRJ-A11Y-${i}`;
        const runId = `RUN-A11Y-${i}`;
        db.prepare(
          "INSERT INTO projects (id, name, url, createdAt, status, workspaceId) VALUES (?, ?, ?, ?, 'idle', ?)"
        ).run(projectId, `A11y Project ${i}`, "https://example.com", now, workspaceId);
        db.prepare(
          "INSERT INTO runs (id, projectId, type, status, startedAt, workspaceId) VALUES (?, ?, 'crawl', 'completed', ?, ?)"
        ).run(runId, projectId, now, workspaceId);
        const rows = Array.from({ length: counts[i] }, (_, k) => ({
          runId, pageUrl: "https://example.com", ruleId: `rule-${k}`,
          impact: "minor", wcagCriterion: null, help: "", description: "", nodesJson: "[]",
        }));
        accessibilityViolationRepo.bulkCreate(rows);
      }

      const out = await req(base, "/api/v1/dashboard", { token: seeder.token });
      assert.equal(out.res.status, 200);
      const list = out.json.topAccessibilityOffenders;
      assert.equal(list.length, 5, "should be capped at 5 entries");
      assert.deepEqual(
        list.map((o) => o.violations),
        [60, 50, 40, 30, 20],
        "should be sorted by violation count descending",
      );
      assert.equal(list[0].projectName, "A11y Project 0");
    });

  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }

  summary("API versioning");
}

main().catch((err) => {
  console.error("❌ api-versioning test crashed:", err);
  process.exit(1);
});

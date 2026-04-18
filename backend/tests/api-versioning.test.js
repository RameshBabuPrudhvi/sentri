/**
 * @module tests/api-versioning
 * @description Integration tests for INF-005 API versioning and DIF-011 testsByUrl.
 *
 * Verifies:
 * - Legacy /api/* paths are 301-redirected to /api/v1/*
 * - Versioned /api/v1/* endpoints respond correctly
 * - Dashboard response includes testsByUrl (DIF-011)
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import dashboardRouter from "../src/routes/dashboard.js";

const t = createTestContext();
const { app, req, workspaceScope } = t;

let mounted = false;

function mountRoutesOnce() {
  if (mounted) return;
  // Mount auth at versioned path
  app.use("/api/v1/auth", authRouter);
  // Mount dashboard at versioned path with auth + workspace scope
  app.use("/api/v1", requireAuth, workspaceScope, dashboardRouter);
  // Legacy redirect handler (mirrors index.js)
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/v1")) return next();
    const newUrl = `/api/v1${req.path}${req._parsedUrl?.search || ""}`;
    res.redirect(301, newUrl);
  });
  mounted = true;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
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

    await test("GET /api/dashboard redirects to /api/v1/dashboard with 301", async () => {
      const res = await fetch(`${base}/api/dashboard`, { redirect: "manual" });
      assert.equal(res.status, 301, `Expected 301, got ${res.status}`);
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

    console.log("✅ api-versioning: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("\n──────────────────────────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("\n⚠️  API versioning tests failed");
    process.exit(1);
  }

  console.log("\n🎉 API versioning tests passed");
}

main().catch((err) => {
  console.error("❌ api-versioning test crashed:", err);
  process.exit(1);
});

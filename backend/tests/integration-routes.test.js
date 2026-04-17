/**
 * @module tests/integration-routes
 * @description Integration checks for authenticated dashboard/system/settings routes.
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import dashboardRouter from "../src/routes/dashboard.js";
import settingsRouter from "../src/routes/settings.js";
import systemRouter from "../src/routes/system.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req } = t;

let mounted = false;

function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, dashboardRouter);
  app.use("/api", requireAuth, settingsRouter);
  app.use("/api", requireAuth, systemRouter);
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
    const { token } = await t.registerAndLogin(base, {
      name: "Integration User",
      email: `integration-${Date.now()}@test.local`,
      password: "Password123!",
    });

    let out = await req(base, "/api/dashboard");
    assert.equal(out.res.status, 401);

    projectRepo.create({
      id: "PRJ-100",
      name: "Coverage App",
      url: "https://example.com",
      createdAt: new Date().toISOString(),
    });
    testRepo.create({
      id: "TC-100",
      projectId: "PRJ-100",
      name: "Sample test",
      description: "A sample test for integration coverage",
      type: "functional",
      reviewStatus: "approved",
      createdAt: new Date().toISOString(),
      steps: ["Open home page"],
    });
    runRepo.create({
      id: "RUN-100",
      projectId: "PRJ-100",
      type: "test_run",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      total: 1,
      passed: 1,
      failed: 0,
      logs: [],
      tests: ["TC-100"],
      results: [
        {
          testId: "TC-100",
          status: "passed",
          durationMs: 200,
        },
      ],
    });

    out = await req(base, "/api/dashboard", { token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.totalProjects, 1);
    assert.equal(out.json.totalTests, 1);

    out = await req(base, "/api/system", { token });
    assert.equal(out.res.status, 200);
    assert.equal(typeof out.json.nodeVersion, "string");
    assert.equal(typeof out.json.projects, "number");

    out = await req(base, "/api/settings", { token });
    assert.equal(out.res.status, 200);
    assert.ok(Object.hasOwn(out.json, "activeProvider"));

    console.log("✅ integration-routes: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ integration-routes failed:", err);
  process.exit(1);
});

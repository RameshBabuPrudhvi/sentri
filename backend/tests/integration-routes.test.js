/**
 * @module tests/integration-routes
 * @description Integration checks for authenticated dashboard/system/settings routes.
 */

import assert from "node:assert/strict";
import { app } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import dashboardRouter from "../src/routes/dashboard.js";
import settingsRouter from "../src/routes/settings.js";
import systemRouter from "../src/routes/system.js";
import { getDb } from "../src/db.js";

let mounted = false;

function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, dashboardRouter);
  app.use("/api", requireAuth, settingsRouter);
  app.use("/api", requireAuth, systemRouter);
  mounted = true;
}

function resetDb() {
  const db = getDb();
  db.users = {};
  db.oauthIds = {};
  db.projects = {};
  db.tests = {};
  db.runs = {};
  db.activities = {};
  db.healingHistory = {};
  return db;
}

async function req(base, path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function main() {
  mountRoutesOnce();
  const db = resetDb();

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const email = `integration-${Date.now()}@example.com`;

    let out = await req(base, "/api/auth/register", {
      method: "POST",
      body: { name: "Integration User", email, password: "Password123!" },
    });
    assert.equal(out.res.status, 201);

    out = await req(base, "/api/auth/login", {
      method: "POST",
      body: { email, password: "Password123!" },
    });
    assert.equal(out.res.status, 200);
    const token = out.json.token;
    assert.ok(token);

    out = await req(base, "/api/dashboard");
    assert.equal(out.res.status, 401);

    db.projects["PRJ-100"] = {
      id: "PRJ-100",
      name: "Coverage App",
      url: "https://example.com",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.tests["TC-100"] = {
      id: "TC-100",
      projectId: "PRJ-100",
      name: "Sample test",
      status: "active",
      reviewStatus: "approved",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 1,
      passCount: 1,
      failCount: 0,
      flaky: false,
      steps: ["Open home page"],
    };
    db.runs["RUN-100"] = {
      id: "RUN-100",
      projectId: "PRJ-100",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      total: 1,
      passed: 1,
      failed: 0,
      logs: [],
      tests: [
        {
          testId: "TC-100",
          status: "passed",
          durationMs: 200,
        },
      ],
    };

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
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ integration-routes failed:", err);
  process.exit(1);
});

/**
 * @module tests/api-flow
 * @description End-to-end API lifecycle smoke test without external framework.
 *
 * API flow integration smoke tests (no external framework).
 *
 * Covers: auth -> project create -> test create -> approve -> run guard -> abort lifecycle.
 */

import assert from "node:assert/strict";
import { app } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import testsRouter from "../src/routes/tests.js";
import runsRouter from "../src/routes/runs.js";
import sseRouter from "../src/routes/sse.js";
import { getDb } from "../src/db.js";

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, projectsRouter);
  app.use("/api", requireAuth, testsRouter);
  app.use("/api", requireAuth, runsRouter);
  app.use("/api", requireAuth, sseRouter);
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
    const email = `qa-${Date.now()}@example.com`;

    let out = await req(base, "/api/auth/register", {
      method: "POST",
      body: { name: "QA User", email, password: "Password123!" },
    });
    assert.equal(out.res.status, 201);

    out = await req(base, "/api/auth/login", {
      method: "POST",
      body: { email, password: "Password123!" },
    });
    assert.equal(out.res.status, 200);
    const token = out.json.token;
    assert.ok(token);

    out = await req(base, "/api/projects", {
      method: "POST",
      token,
      body: { name: "Flow App", url: "https://example.com" },
    });
    assert.equal(out.res.status, 201);
    const projectId = out.json.id;
    assert.ok(projectId);

    out = await req(base, `/api/projects/${projectId}/tests`, {
      method: "POST",
      token,
      body: { name: "Login test", steps: ["Open app", "Click login"] },
    });
    assert.equal(out.res.status, 201);
    const testId = out.json.id;

    out = await req(base, `/api/projects/${projectId}/tests/${testId}/approve`, {
      method: "PATCH",
      token,
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.reviewStatus, "approved");

    // Seed an active run and verify duplicate-run guard (409).
    db.runs.RUN_ACTIVE = {
      id: "RUN_ACTIVE",
      projectId,
      type: "test_run",
      status: "running",
      startedAt: new Date().toISOString(),
      logs: [],
    };

    out = await req(base, `/api/projects/${projectId}/run`, { method: "POST", token });
    assert.equal(out.res.status, 409);

    // Abort lifecycle should transition run to aborted.
    out = await req(base, "/api/runs/RUN_ACTIVE/abort", { method: "POST", token });
    assert.equal(out.res.status, 200);

    out = await req(base, "/api/runs/RUN_ACTIVE", { token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.status, "aborted");

    console.log("✅ api-flow: all checks passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ api-flow failed:", err);
  process.exit(1);
});

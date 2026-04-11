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
import { getDatabase } from "../src/database/sqlite.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";

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
  const db = getDatabase();
  db.exec("DELETE FROM healing_history");
  db.exec("DELETE FROM activities");
  db.exec("DELETE FROM runs");
  db.exec("DELETE FROM tests");
  db.exec("DELETE FROM oauth_ids");
  db.exec("DELETE FROM projects");
  db.exec("DELETE FROM users");
  db.exec("UPDATE counters SET value = 0");
}

/** Extract a named cookie value from a fetch Response's Set-Cookie header. */
function extractCookie(res, name) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const match = c.match(new RegExp(`^${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

/** Shared CSRF token — captured from the first server response that sets it. */
let csrfToken = null;

async function req(base, path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // CSRF double-submit: send both the cookie and the header so the middleware
  // can compare them. Plain fetch() does not auto-send cookies.
  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
    headers.Cookie = (headers.Cookie ? headers.Cookie + "; " : "") + `_csrf=${csrfToken}`;
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Capture CSRF cookie from any response that sets it
  const csrf = extractCookie(res, "_csrf");
  if (csrf) csrfToken = csrf;
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function main() {
  mountRoutesOnce();
  resetDb();

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const email = `qa-${Date.now()}@test.local`;

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
    const token = extractCookie(out.res, "access_token");
    assert.ok(token, "Login response should set access_token cookie");

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
    runRepo.create({
      id: "RUN_ACTIVE",
      projectId,
      type: "test_run",
      status: "running",
      startedAt: new Date().toISOString(),
      logs: [],
      tests: [],
      results: [],
    });

    out = await req(base, `/api/projects/${projectId}/run`, { method: "POST", token });
    assert.equal(out.res.status, 409);

    // Abort lifecycle should transition run to aborted.
    out = await req(base, "/api/runs/RUN_ACTIVE/abort", { method: "POST", token });
    assert.equal(out.res.status, 200);

    out = await req(base, "/api/runs/RUN_ACTIVE", { token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.status, "aborted");

    // ── Bulk approve with per-test audit trail (PR #66) ──────────────────
    // Create a second test so we can bulk-approve both and verify individual
    // activity log entries are created for each test.
    out = await req(base, `/api/projects/${projectId}/tests`, {
      method: "POST",
      token,
      body: { name: "Signup test", steps: ["Open app", "Click signup"] },
    });
    assert.equal(out.res.status, 201);
    const testId2 = out.json.id;

    // Restore both tests to draft first (testId was approved above)
    await req(base, `/api/projects/${projectId}/tests/${testId}/restore`, { method: "PATCH", token });

    // Bulk approve both tests
    out = await req(base, `/api/projects/${projectId}/tests/bulk`, {
      method: "POST",
      token,
      body: { testIds: [testId, testId2], action: "approve" },
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.updated, 2, "Should approve 2 tests");

    // Verify per-test activity entries were created
    const activities = activityRepo.getAll();
    const perTestApprovals = activities.filter(a =>
      a.type === "test.approve" && a.detail?.includes("(bulk)")
    );
    assert.ok(perTestApprovals.length >= 2, `Should have ≥2 per-test audit entries, got ${perTestApprovals.length}`);

    console.log("✅ api-flow: all checks passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ api-flow failed:", err);
  process.exit(1);
});

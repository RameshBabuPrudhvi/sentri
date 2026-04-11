/**
 * @module tests/test-fix
 * @description Integration tests for the AI test fix endpoints.
 *
 * Covers:
 *   - POST /api/tests/:testId/fix (SSE streaming)
 *   - POST /api/tests/:testId/apply-fix
 *   - Error cases: missing test, no code, missing body
 */

import assert from "node:assert/strict";
import { app } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import testFixRouter from "../src/routes/testFix.js";
import { getDatabase } from "../src/database/sqlite.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";

let mounted = false;

function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, testFixRouter);
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

/** Extract the sentri_auth cookie value from a fetch Response's Set-Cookie header. */
function extractAuthCookie(res) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const match = c.match(/^sentri_auth=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

async function req(base, path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function reqJson(base, path, opts = {}) {
  const res = await req(base, path, opts);
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
    // ── Register + login ──────────────────────────────────────────────────
    const email = `fix-${Date.now()}@test.local`;

    let out = await reqJson(base, "/api/auth/register", {
      method: "POST",
      body: { name: "Fix User", email, password: "Password123!" },
    });
    assert.equal(out.res.status, 201);

    out = await reqJson(base, "/api/auth/login", {
      method: "POST",
      body: { email, password: "Password123!" },
    });
    assert.equal(out.res.status, 200);
    const token = out.json.token;
    assert.ok(token);

    // ── Seed test data ────────────────────────────────────────────────────
    projectRepo.create({
      id: "PRJ-FIX",
      name: "Fix App",
      url: "https://example.com",
      createdAt: new Date().toISOString(),
    });

    testRepo.create({
      id: "TC-FIX1",
      projectId: "PRJ-FIX",
      name: "Failing login test",
      description: "Tests the login flow",
      steps: ["Open login page", "Enter credentials", "Click submit"],
      playwrightCode: `test('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n  await page.fill('#email', 'user@test.com');\n  await page.click('#submit');\n  await expect(page).toHaveURL('/dashboard');\n});`,
      sourceUrl: "https://example.com/login",
      lastResult: "failed",
      reviewStatus: "approved",
      createdAt: new Date().toISOString(),
    });

    testRepo.create({
      id: "TC-FIX2",
      projectId: "PRJ-FIX",
      name: "No code test",
      description: "",
      steps: ["Step 1"],
      playwrightCode: null,
      lastResult: "failed",
      reviewStatus: "draft",
      createdAt: new Date().toISOString(),
    });

    // Seed a run with a failed result for TC-FIX1
    runRepo.create({
      id: "RUN-FIX",
      projectId: "PRJ-FIX",
      type: "test_run",
      status: "completed",
      startedAt: new Date().toISOString(),
      logs: [],
      tests: ["TC-FIX1"],
      results: [
        {
          testId: "TC-FIX1",
          testName: "Failing login test",
          status: "failed",
          error: "Timed out waiting for selector '#submit'",
          durationMs: 30000,
          steps: ["Open login page", "Enter credentials", "Click submit"],
        },
      ],
    });

    // ── Test: apply-fix with missing test ──────────────────────────────────
    out = await reqJson(base, "/api/tests/TC-NONEXISTENT/apply-fix", {
      method: "POST",
      token,
      body: { code: "test('x', async () => {});" },
    });
    assert.equal(out.res.status, 404, "apply-fix should 404 for missing test");

    // ── Test: apply-fix with missing code ─────────────────────────────────
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: {},
    });
    assert.equal(out.res.status, 400, "apply-fix should 400 without code");

    // ── Test: apply-fix with empty code ───────────────────────────────────
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: { code: "   " },
    });
    assert.equal(out.res.status, 400, "apply-fix should 400 with whitespace-only code");

    // ── Test: apply-fix success ───────────────────────────────────────────
    const originalCode = testRepo.getById("TC-FIX1").playwrightCode;
    const newCode = `test('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n  await page.fill('#email', 'user@test.com');\n  await page.getByRole('button', { name: 'Submit' }).click();\n  await expect(page).toHaveURL('/dashboard');\n});`;

    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: { code: newCode },
    });
    assert.equal(out.res.status, 200, "apply-fix should succeed");
    assert.equal(out.json.playwrightCode, newCode, "code should be updated");
    assert.equal(out.json.playwrightCodePrev, originalCode, "previous code should be stored");
    assert.equal(out.json.codeVersion, 1, "version should be bumped to 1");
    assert.ok(out.json.aiFixAppliedAt, "aiFixAppliedAt should be set");
    assert.ok(out.json.updatedAt, "updatedAt should be set");

    // Verify activity was logged
    const activities = activityRepo.getAll();
    const fixActivity = activities.find(a => a.type === "test.ai_fix" && a.testId === "TC-FIX1");
    assert.ok(fixActivity, "AI fix activity should be logged");
    assert.ok(fixActivity.detail.includes("version 1"), "Activity should mention version");

    // ── Test: apply-fix bumps version on second apply ─────────────────────
    const secondCode = newCode.replace("Submit", "Log In");
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: { code: secondCode },
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.codeVersion, 2, "version should be bumped to 2");
    assert.equal(out.json.playwrightCodePrev, newCode, "prev should be the first fix");

    // ── Test: fix endpoint returns 404 for missing test ───────────────────
    const fixRes = await req(base, "/api/tests/TC-NONEXISTENT/fix", {
      method: "POST",
      token,
    });
    assert.equal(fixRes.status, 404, "fix should 404 for missing test");

    // ── Test: fix endpoint returns 400 for test without code ──────────────
    const noCodeRes = await req(base, "/api/tests/TC-FIX2/fix", {
      method: "POST",
      token,
    });
    assert.equal(noCodeRes.status, 400, "fix should 400 for test without code");

    // ── Test: fix endpoint requires auth ──────────────────────────────────
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      body: { code: "test('x', async () => {});" },
    });
    assert.equal(out.res.status, 401, "apply-fix should require auth");

    // ── Test: apply-fix rejects code without test() call ──────────────────
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: { code: "async function doStuff() { await page.click('#x'); }" },
    });
    assert.equal(out.res.status, 400, "apply-fix should 400 for code without test()");
    assert.ok(out.json.error.includes("valid Playwright test"), "Error should mention valid Playwright test");

    // ── Test: apply-fix rejects code without async ────────────────────────
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: { code: "test('sync test', ({ page }) => { page.click('#x'); });" },
    });
    assert.equal(out.res.status, 400, "apply-fix should 400 for code without async");

    // ── Test: apply-fix accepts test.only() variant ───────────────────────
    const onlyCode = `test.only('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n  await page.fill('#email', 'user@test.com');\n  await expect(page).toHaveURL('/dashboard');\n});`;
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: { code: onlyCode },
    });
    assert.equal(out.res.status, 200, "apply-fix should accept test.only()");

    // ── Test: apply-fix accepts test.skip() variant ───────────────────────
    const skipCode = `test.skip('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n});`;
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: { code: skipCode },
    });
    assert.equal(out.res.status, 200, "apply-fix should accept test.skip()");

    // ── Test: apply-fix strips markdown fences from code ──────────────────
    const fencedCode = "```javascript\ntest('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n  await expect(page).toHaveURL('/dashboard');\n});\n```";
    out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
      method: "POST",
      token,
      body: { code: fencedCode },
    });
    assert.equal(out.res.status, 200, "apply-fix should strip markdown fences");
    assert.ok(!out.json.playwrightCode.includes("```"), "Stored code should not contain fences");

    console.log("✅ test-fix: all checks passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ test-fix failed:", err);
  process.exit(1);
});

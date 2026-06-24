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
import authRouter, { requireAuth } from "../src/routes/auth.js";
import testFixRouter from "../src/routes/testFix.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as activityRepo from "../src/database/repositories/activityRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const runner = t.createTestRunner();
const { app, workspaceScope } = t;
// Alias: t.req() returns { res, json }; reqJson is the same thing.
const reqJson = t.req;

let mounted = false;

function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, workspaceScope, testFixRouter);
  mounted = true;
}

// Wrapper that returns only the Response (for SSE / non-JSON endpoints)
async function req(base, path, opts = {}) {
  const { res } = await t.req(base, path, opts);
  return res;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();

  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // ── Register + login ──────────────────────────────────────────────────
    const { token, payload } = await t.registerAndLogin(base, {
      name: "Fix User",
      email: `fix-${Date.now()}@test.local`,
      password: "Password123!",
    });
    const workspaceId = payload.workspaceId;

    // ── Seed test data ────────────────────────────────────────────────────
    projectRepo.create({
      id: "PRJ-FIX",
      name: "Fix App",
      url: "https://example.com",
      createdAt: new Date().toISOString(),
      workspaceId,
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

    await runner.test("apply-fix should 404 for missing test", async () => {
      const out = await reqJson(base, "/api/tests/TC-NONEXISTENT/apply-fix", {
        method: "POST",
        token,
        body: { code: "test('x', async () => {});" },
      });
      assert.equal(out.res.status, 404, "apply-fix should 404 for missing test");
    });

    await runner.test("apply-fix should 400 without code", async () => {
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        token,
        body: {},
      });
      assert.equal(out.res.status, 400, "apply-fix should 400 without code");
    });

    await runner.test("apply-fix should 400 with whitespace-only code", async () => {
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        token,
        body: { code: "   " },
      });
      assert.equal(out.res.status, 400, "apply-fix should 400 with whitespace-only code");
    });

    // Shared between the success case and the version-bump case below.
    const originalCode = testRepo.getById("TC-FIX1").playwrightCode;
    const newCode = `test('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n  await page.fill('#email', 'user@test.com');\n  await page.getByRole('button', { name: 'Submit' }).click();\n  await expect(page).toHaveURL('/dashboard');\n});`;

    await runner.test("apply-fix success: updates code, stores prev, bumps to version 1, logs activity", async () => {
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
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
    });

    await runner.test("apply-fix bumps version on second apply", async () => {
      const secondCode = newCode.replace("Submit", "Log In");
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        token,
        body: { code: secondCode },
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.codeVersion, 2, "version should be bumped to 2");
      assert.equal(out.json.playwrightCodePrev, newCode, "prev should be the first fix");
    });

    await runner.test("fix endpoint returns 404 for missing test", async () => {
      const fixRes = await req(base, "/api/tests/TC-NONEXISTENT/fix", {
        method: "POST",
        token,
      });
      assert.equal(fixRes.status, 404, "fix should 404 for missing test");
    });

    await runner.test("fix endpoint returns 400 for test without code", async () => {
      const noCodeRes = await req(base, "/api/tests/TC-FIX2/fix", {
        method: "POST",
        token,
      });
      assert.equal(noCodeRes.status, 400, "fix should 400 for test without code");
    });

    await runner.test("apply-fix requires auth (401 without token)", async () => {
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        body: { code: "test('x', async () => {});" },
      });
      assert.equal(out.res.status, 401, "apply-fix should require auth");
    });

    await runner.test("apply-fix rejects code without test() call", async () => {
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        token,
        body: { code: "async function doStuff() { await page.click('#x'); }" },
      });
      assert.equal(out.res.status, 400, "apply-fix should 400 for code without test()");
      assert.ok(out.json.error.includes("valid Playwright test"), "Error should mention valid Playwright test");
    });

    await runner.test("apply-fix rejects code without async", async () => {
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        token,
        body: { code: "test('sync test', ({ page }) => { page.click('#x'); });" },
      });
      assert.equal(out.res.status, 400, "apply-fix should 400 for code without async");
    });

    await runner.test("apply-fix accepts test.only() variant", async () => {
      const onlyCode = `test.only('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n  await page.fill('#email', 'user@test.com');\n  await expect(page).toHaveURL('/dashboard');\n});`;
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        token,
        body: { code: onlyCode },
      });
      assert.equal(out.res.status, 200, "apply-fix should accept test.only()");
    });

    await runner.test("apply-fix accepts test.skip() variant", async () => {
      const skipCode = `test.skip('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n});`;
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        token,
        body: { code: skipCode },
      });
      assert.equal(out.res.status, 200, "apply-fix should accept test.skip()");
    });

    await runner.test("apply-fix strips markdown fences from code", async () => {
      const fencedCode = "```javascript\ntest('Failing login test', async ({ page }) => {\n  await page.goto('https://example.com/login');\n  await expect(page).toHaveURL('/dashboard');\n});\n```";
      const out = await reqJson(base, "/api/tests/TC-FIX1/apply-fix", {
        method: "POST",
        token,
        body: { code: fencedCode },
      });
      assert.equal(out.res.status, 200, "apply-fix should strip markdown fences");
      assert.ok(!out.json.playwrightCode.includes("```"), "Stored code should not contain fences");
    });

    runner.summary("test-fix");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ test-fix failed:", err);
  process.exit(1);
});

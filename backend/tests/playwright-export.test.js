import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestContext } from "./helpers/test-base.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import testsRouter from "../src/routes/tests.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";

const t = createTestContext();
const { app, req, workspaceScope } = t;
const { test, summary } = t.createTestRunner();

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/v1", requireAuth, workspaceScope, testsRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const { token, payload } = await t.registerAndLogin(base, {
      name: "Export User",
      email: `export-${Date.now()}@test.local`,
      password: "Password123!",
    });

    await test("GET /api/v1/projects/:id/export/playwright returns 404 for missing project", async () => {
      const out = await req(base, "/api/v1/projects/PRJ-missing/export/playwright", { token });
      assert.equal(out.res.status, 404);
    });

    projectRepo.create({
      id: "PRJ-EXPORT",
      name: "Export App",
      url: "https://example.com",
      createdAt: new Date().toISOString(),
      workspaceId: payload.workspaceId,
    });

    testRepo.create({
      id: "TC-APPROVED",
      projectId: "PRJ-EXPORT",
      name: "Approved Test",
      description: "approved",
      reviewStatus: "approved",
      steps: ["Open page"],
      playwrightCode: "await page.goto('/');\nawait expect(page).toHaveTitle(/Example/);",
      createdAt: new Date().toISOString(),
    });

    testRepo.create({
      id: "TC-DRAFT",
      projectId: "PRJ-EXPORT",
      name: "Draft Test",
      description: "draft",
      reviewStatus: "draft",
      steps: ["Draft step"],
      playwrightCode: "await page.goto('/draft');",
      createdAt: new Date().toISOString(),
    });

    await test("playwright export returns application/zip and approved tests only", async () => {
      const res = await fetch(`${base}/api/v1/projects/PRJ-EXPORT/export/playwright`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/zip");
      const cd = res.headers.get("content-disposition") || "";
      assert.ok(cd.includes("playwright.zip"));

      const buffer = Buffer.from(await res.arrayBuffer());
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentri-export-test-"));
      const zipPath = path.join(tmpDir, "out.zip");
      fs.writeFileSync(zipPath, buffer);
      const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
      assert.ok(listing.includes("playwright.config.ts"));
      assert.ok(listing.includes("README.md"));
      assert.ok(listing.includes("tests/approved-test.spec.ts"));
      assert.ok(!listing.includes("tests/draft-test.spec.ts"));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Regression: previously, when the body-extraction regex failed to match
    // but `rawCode` was already a complete Playwright spec (import + test()),
    // the fallback re-wrapped it in ANOTHER import+test wrapper, producing a
    // .spec.ts with nested `import { test, expect } from '@playwright/test'`
    // lines and a `test()` call inside another `test()`. The exported spec
    // wouldn't parse. The fix detects this case and writes the rawCode
    // verbatim.
    testRepo.create({
      id: "TC-COMPLETE-SPEC",
      projectId: "PRJ-EXPORT",
      name: "Complete Spec Test",
      description: "already a full spec file",
      reviewStatus: "approved",
      steps: ["Navigate"],
      // `async function` wrapper — the extraction regex only matches arrow
      // functions (`async (…) =>`), so this trips the edge-case path.
      playwrightCode: `import { test, expect } from '@playwright/test';

test('complete spec', async function ({ page }) {
  await page.goto('/');
  await expect(page).toHaveTitle(/Example/);
});
`,
      createdAt: new Date().toISOString(),
    });

    await test("already-complete spec files are NOT re-wrapped (no nested import / test)", async () => {
      const res = await fetch(`${base}/api/v1/projects/PRJ-EXPORT/export/playwright`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);

      const buffer = Buffer.from(await res.arrayBuffer());
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentri-export-test-"));
      const zipPath = path.join(tmpDir, "out.zip");
      fs.writeFileSync(zipPath, buffer);
      // Extract just the spec file we care about so we can inspect its contents.
      execFileSync("unzip", ["-q", zipPath, "tests/complete-spec-test.spec.ts", "-d", tmpDir]);
      const specPath = path.join(tmpDir, "tests/complete-spec-test.spec.ts");
      const contents = fs.readFileSync(specPath, "utf8");

      // Exactly one import from @playwright/test (not two).
      const importMatches = contents.match(/import\s*\{[^}]*\}\s*from\s*['"]@playwright\/test['"]/g) || [];
      assert.equal(importMatches.length, 1, `expected 1 playwright import, found ${importMatches.length}:\n${contents}`);

      // Exactly one `test(` call (not two).
      const testMatches = contents.match(/\btest\s*\(/g) || [];
      assert.equal(testMatches.length, 1, `expected 1 test() call, found ${testMatches.length}:\n${contents}`);

      // The original `async function` signature survives — i.e. we didn't
      // extract and re-wrap the body through the arrow-function path.
      assert.ok(contents.includes("async function"), `expected original async function form:\n${contents}`);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  } finally {
    env.restore();
    await new Promise(resolve => server.close(resolve));
  }

  summary("playwright-export");
}

main().catch((err) => {
  console.error("❌ playwright-export failed:", err);
  process.exit(1);
});

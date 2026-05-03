/**
 * Tests for GET /api/v1/projects/:id/pages — Recorder Start-URL dropdown.
 *
 * Contract:
 *   - Empty crawl history → returns [seed].
 *   - Latest successful crawl with pages → returns [seed, ...pages] deduped.
 *   - Unknown project id → 404.
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import { generateRunId } from "../src/utils/idGenerator.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/v1/projects", requireAuth, workspaceScope, projectsRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { test, summary } = t.createTestRunner();

  try {
    const { token } = await t.registerAndLogin(base, {
      name: "Pages User",
      email: `pages-${Date.now()}@test.local`,
      password: "Password123!",
    });
    const authCookie = `access_token=${token}`;

    // Helper: create a project via the API so workspaceId is correctly wired
    // through the same scope the GET endpoint uses.
    async function createProject(url) {
      const out = await req(base, "/api/v1/projects", {
        method: "POST", cookie: authCookie,
        body: { name: "P", url },
      });
      assert.equal(out.res.status, 201, `create project failed: ${JSON.stringify(out.json)}`);
      return out.json.id;
    }

    await test("GET /projects/:id/pages — empty crawl history returns just the seed URL", async () => {
      const id = await createProject("https://seed.example");
      const out = await req(base, `/api/v1/projects/${id}/pages`, { cookie: authCookie });
      assert.equal(out.res.status, 200);
      assert.deepEqual(out.json.urls, ["https://seed.example"]);
    });

    await test("GET /projects/:id/pages — latest crawl pages prepended with seed and deduped", async () => {
      const id = await createProject("https://seed2.example");
      runRepo.create({
        id: generateRunId(), projectId: id, type: "crawl", status: "completed",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        pages: [
          { url: "https://seed2.example" }, // dup of seed → deduped
          { url: "https://seed2.example/a" },
          { url: "https://seed2.example/b" },
          { url: "" }, // filtered
        ],
      });
      const out = await req(base, `/api/v1/projects/${id}/pages`, { cookie: authCookie });
      assert.equal(out.res.status, 200);
      assert.deepEqual(out.json.urls, [
        "https://seed2.example",
        "https://seed2.example/a",
        "https://seed2.example/b",
      ]);
    });

    await test("GET /projects/:id/pages — unknown project id returns 404", async () => {
      const out = await req(base, `/api/v1/projects/PRJ-does-not-exist/pages`, { cookie: authCookie });
      assert.equal(out.res.status, 404);
    });
  } finally {
    summary("projects-pages");
    env.restore();
    await new Promise((r) => server.close(r));
  }
}

main().catch((err) => {
  console.error("❌ projects-pages failed:", err);
  process.exit(1);
});
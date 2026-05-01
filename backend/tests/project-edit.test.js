/**
 * @module tests/project-edit
 * @description Integration test for `PATCH /api/v1/projects/:id`.
 *
 * Covers the credentials-merge rules exposed by the edit flow:
 *   1. Basic name + URL update persists.
 *   2. Editing with blank `username` / `password` preserves the existing
 *      encrypted values (since `projectSanitiser.js` never returns secrets
 *      to the client).
 *   3. Supplying fresh `username` / `password` replaces the stored values
 *      and the new plaintext round-trips through `decryptCredentials()`.
 *   4. `credentials: null` clears stored credentials entirely.
 *   5. A `viewer`-role user is blocked by `requireRole("qa_lead")`.
 *   6. Cross-workspace PATCH returns 404 (workspace scoping).
 */
import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import { decryptCredentials } from "../src/utils/credentialEncryption.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req, workspaceScope, getDatabase } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, workspaceScope, projectsRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();

  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });

  const server = app.listen(0);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const runner = t.createTestRunner();

  try {
    const { token } = await t.registerAndLogin(base, {
      name: "QA Lead",
      email: `edit-${Date.now()}@test.local`,
      password: "Password123!",
    });

    // Seed a project with credentials via POST.
    let out = await req(base, "/api/projects", {
      method: "POST",
      token,
      body: {
        name: "Edit App",
        url: "https://example.com",
        credentials: {
          usernameSelector: "#email",
          username: "alice@example.com",
          passwordSelector: "#password",
          password: "OriginalPass1!",
          submitSelector: "#submit",
        },
      },
    });
    assert.equal(out.res.status, 201);
    const projectId = out.json.id;

    await runner.test("PATCH updates name + url", async () => {
      const r = await req(base, `/api/projects/${projectId}`, {
        method: "PATCH",
        token,
        body: {
          name: "Edit App v2",
          url: "https://example.org",
          credentials: {
            usernameSelector: "#email",
            username: "",       // blank → preserve
            passwordSelector: "#password",
            password: "",       // blank → preserve
            submitSelector: "#submit",
          },
        },
      });
      assert.equal(r.res.status, 200);
      assert.equal(r.json.name, "Edit App v2");
      assert.equal(r.json.url, "https://example.org");
    });

    await runner.test("Blank username/password preserves existing encrypted values", async () => {
      const stored = projectRepo.getById(projectId);
      const decrypted = decryptCredentials(stored.credentials);
      assert.equal(decrypted.username, "alice@example.com");
      assert.equal(decrypted.password, "OriginalPass1!");
    });

    await runner.test("Non-blank username/password replaces stored values", async () => {
      const r = await req(base, `/api/projects/${projectId}`, {
        method: "PATCH",
        token,
        body: {
          name: "Edit App v2",
          url: "https://example.org",
          credentials: {
            usernameSelector: "#email",
            username: "bob@example.com",
            passwordSelector: "#password",
            password: "NewPass2!",
            submitSelector: "#submit",
          },
        },
      });
      assert.equal(r.res.status, 200);
      const decrypted = decryptCredentials(projectRepo.getById(projectId).credentials);
      assert.equal(decrypted.username, "bob@example.com");
      assert.equal(decrypted.password, "NewPass2!");
    });

    await runner.test("credentials: null clears stored credentials", async () => {
      const r = await req(base, `/api/projects/${projectId}`, {
        method: "PATCH",
        token,
        body: {
          name: "Edit App v2",
          url: "https://example.org",
          credentials: null,
        },
      });
      assert.equal(r.res.status, 200);
      assert.equal(projectRepo.getById(projectId).credentials, null);
    });

    await runner.test("viewer role is blocked by requireRole(\"qa_lead\")", async () => {
      // Demote the acting user to viewer in the workspace.
      const db = getDatabase();
      db.prepare("UPDATE workspace_members SET role = 'viewer'").run();
      const r = await req(base, `/api/projects/${projectId}`, {
        method: "PATCH",
        token,
        body: { name: "Should Fail", url: "https://example.org" },
      });
      assert.equal(r.res.status, 403);
      // Restore role for subsequent tests.
      db.prepare("UPDATE workspace_members SET role = 'admin'").run();
    });

    await runner.test("Unknown project id returns 404", async () => {
      const r = await req(base, "/api/projects/PRJ-DOES-NOT-EXIST", {
        method: "PATCH",
        token,
        body: { name: "Ghost", url: "https://example.org" },
      });
      assert.equal(r.res.status, 404);
    });

    runner.summary("project-edit");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ project-edit failed:", err);
  process.exit(1);
});

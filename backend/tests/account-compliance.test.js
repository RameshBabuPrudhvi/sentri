/**
 * @module tests/account-compliance
 * @description Integration coverage for SEC-002, SEC-003, and FEA-001 API gaps.
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import { app } from "../src/middleware/appSetup.js";
import * as userRepo from "../src/database/repositories/userRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { req, workspaceScope } = t;

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

  try {
    const email = `privacy-${Date.now()}@test.local`;
    const password = "Password123!";

    const { token } = await t.registerAndLogin(base, {
      name: "Privacy User",
      email,
      password,
    });

    // SEC-002: CSP header should include nonce and avoid unsafe-inline scripts.
    let out = await req(base, "/api/auth/me", { token });
    assert.equal(out.res.status, 200);
    const csp = out.res.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src[^;]*'nonce-[^']+'/, "CSP script-src should include a nonce");
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "CSP script-src must not include unsafe-inline");

    // Create one project so export + deletion have owned data to operate on.
    out = await req(base, "/api/projects", {
      method: "POST",
      token,
      body: { name: "Privacy App", url: "https://example.com" },
    });
    assert.equal(out.res.status, 201);
    const projectId = out.json.id;

    // FEA-001: notification settings CRUD + validation.
    out = await req(base, `/api/projects/${projectId}/notifications`, {
      method: "PATCH",
      token,
      body: { teamsWebhookUrl: "", emailRecipients: "", webhookUrl: "", enabled: true },
    });
    assert.equal(out.res.status, 400, "At least one channel is required");

    out = await req(base, `/api/projects/${projectId}/notifications`, {
      method: "PATCH",
      token,
      body: { teamsWebhookUrl: "https://teams.example/webhook", emailRecipients: "qa@example.com", enabled: true },
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.notifications.enabled, true);

    out = await req(base, `/api/projects/${projectId}/notifications`, { token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.notifications.projectId, projectId);

    out = await req(base, `/api/projects/${projectId}/notifications`, { method: "DELETE", token });
    assert.equal(out.res.status, 200);

    // SEC-003 export: requires password confirmation.
    out = await fetch(`${base}/api/auth/export`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }).then(async (res) => ({ res, json: await res.json().catch(() => ({})) }));
    assert.equal(out.res.status, 400);

    out = await fetch(`${base}/api/auth/export`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Account-Password": password,
      },
    }).then(async (res) => ({ res, json: await res.json().catch(() => ({})) }));
    assert.equal(out.res.status, 200);
    assert.equal(out.json.user.email, email);
    assert.ok(Array.isArray(out.json.projects), "Export payload should include projects array");

    // Recreate project to verify delete cascade on owned data.
    out = await req(base, "/api/projects", {
      method: "POST",
      token,
      body: { name: "Delete Me", url: "https://example.com/delete" },
    });
    assert.equal(out.res.status, 201);
    const doomedProjectId = out.json.id;

    // SEC-003 delete: wrong password fails, correct password succeeds.
    out = await req(base, "/api/auth/account", {
      method: "DELETE",
      token,
      body: { password: "WrongPass123!" },
    });
    assert.equal(out.res.status, 401);

    out = await req(base, "/api/auth/account", {
      method: "DELETE",
      token,
      body: { password },
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.ok, true);

    const userAfterDelete = userRepo.getByEmail(email);
    const projectAfterDelete = projectRepo.getById(doomedProjectId);
    assert.equal(userAfterDelete, undefined, "User should be hard-deleted");
    assert.equal(projectAfterDelete, undefined, "Owned project should be deleted with account");

    console.log("✅ account-compliance: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ account-compliance failed:", err);
  process.exit(1);
});

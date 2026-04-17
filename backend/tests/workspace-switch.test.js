/**
 * @module tests/workspace-switch
 * @description Verifies multi-workspace selection and switching flows.
 */

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import { workspaceScope } from "../src/middleware/workspaceScope.js";
import workspacesRouter from "../src/routes/workspaces.js";
import * as workspaceRepo from "../src/database/repositories/workspaceRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req } = t;

let mounted = false;

function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/workspaces", requireAuth, workspaceScope, workspacesRouter);
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
    const rameshEmail = `ramesh-${Date.now()}@test.local`;
    const parniEmail = `parni-${Date.now()}@test.local`;
    const password = "Password123!";

    const ramesh = await t.registerAndLogin(base, {
      name: "Ramesh",
      email: rameshEmail,
      password,
    });
    const parniInitial = await t.registerAndLogin(base, {
      name: "Parni",
      email: parniEmail,
      password,
    });

    const rameshWorkspaceId = ramesh.payload.workspaceId;
    const parniWorkspaceId = parniInitial.payload.workspaceId;
    assert.ok(rameshWorkspaceId);
    assert.ok(parniWorkspaceId);
    assert.notEqual(rameshWorkspaceId, parniWorkspaceId);

    let out = await req(base, "/api/workspaces/current/members", {
      method: "POST",
      token: ramesh.token,
      body: { email: parniEmail, role: "viewer" },
    });
    assert.equal(out.res.status, 201);

    // Parni logs in after being added to Ramesh's workspace.
    out = await req(base, "/api/auth/login", {
      method: "POST",
      body: { email: parniEmail, password },
    });
    assert.equal(out.res.status, 200);
    const parniToken = t.extractCookie(out.res, "access_token");
    const parniPayload = t.decodeJwtPayload(parniToken);

    // Login should keep Parni in her own (owned) workspace by default.
    assert.equal(parniPayload.workspaceId, parniWorkspaceId);

    out = await req(base, "/api/workspaces", { token: parniToken });
    assert.equal(out.res.status, 200);
    assert.equal(Array.isArray(out.json), true);
    assert.equal(out.json.length >= 2, true);

    // Switch to Ramesh's workspace.
    out = await req(base, "/api/workspaces/switch", {
      method: "POST",
      token: parniToken,
      body: { workspaceId: rameshWorkspaceId },
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.workspaceId, rameshWorkspaceId);
    const switchedToken = t.extractCookie(out.res, "access_token");
    assert.ok(switchedToken);

    out = await req(base, "/api/workspaces/current", { token: switchedToken });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.id, rameshWorkspaceId);

    // Switch back to Parni's workspace.
    out = await req(base, "/api/workspaces/switch", {
      method: "POST",
      token: switchedToken,
      body: { workspaceId: parniWorkspaceId },
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.workspaceId, parniWorkspaceId);
    const switchedBackToken = t.extractCookie(out.res, "access_token");
    assert.ok(switchedBackToken);

    out = await req(base, "/api/workspaces/current", { token: switchedBackToken });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.id, parniWorkspaceId);

    // Sanity check: role in Ramesh workspace stays viewer.
    const membership = workspaceRepo.getMembership(rameshWorkspaceId, parniPayload.sub);
    assert.equal(membership?.role, "viewer");

    console.log("✅ workspace-switch: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ workspace-switch failed:", err);
  process.exit(1);
});


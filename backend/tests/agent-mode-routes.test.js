/**
 * @module tests/agent-mode-routes
 * @description AUTO-023 B4.4 — integration coverage for the
 * `/api/v1/settings/agent-mode` endpoints + `workspaceRepo.{getAgentMode,
 * setAgentMode}` unit pins.
 *
 * Required by REVIEW.md ("New or changed API endpoint → Integration test:
 * status codes, response shape, auth, error cases") — the prior PR shipped
 * the routes + the migration without test coverage. This file closes that
 * gap.
 *
 * Pins:
 *   • GET returns `{ mode: "pipeline" }` on a fresh workspace (default
 *     matches `agentMode.js#getAgentMode()` env-var fallback).
 *   • PATCH with valid mode updates + returns the new mode.
 *   • PATCH with invalid mode returns 400 + does NOT mutate the column.
 *   • Cross-workspace isolation — admin in workspace A cannot read or
 *     mutate workspace B's mode.
 *   • Repo layer: getAgentMode/setAgentMode round-trip; invalid-mode
 *     argument coerces to `"pipeline"` (defence-in-depth).
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import settingsRouter from "../src/routes/settings.js";
import { createTestContext } from "./helpers/test-base.js";
import * as workspaceRepo from "../src/database/repositories/workspaceRepo.js";

const t = createTestContext();
const { req: apiReq } = t;
const { test, summary } = t.createTestRunner();

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  t.app.use("/api/auth", authRouter);
  t.app.use("/api", requireAuth, t.workspaceScope, settingsRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  const server = createServer(t.app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = await t.registerAndLogin(base, { name: "Admin A", email: `am-a-${Date.now()}@x.test`, password: "Password123!" });
    const b = await t.registerAndLogin(base, { name: "Admin B", email: `am-b-${Date.now()}@x.test`, password: "Password123!" });
    const cookieA = `access_token=${a.token}`;
    const cookieB = `access_token=${b.token}`;

    await test("GET /settings/agent-mode returns pipeline by default", async () => {
      const out = await apiReq(base, "/api/settings/agent-mode", { cookie: cookieA });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.mode, "pipeline", "fresh workspace defaults to pipeline (matches env-var default)");
    });

    await test("PATCH /settings/agent-mode accepts valid modes + persists", async () => {
      for (const mode of ["envelope", "autonomous", "pipeline"]) {
        const patch = await apiReq(base, "/api/settings/agent-mode", {
          method: "PATCH", cookie: cookieA, body: { mode },
        });
        assert.equal(patch.res.status, 200, `PATCH ${mode} → 200`);
        assert.equal(patch.json.mode, mode);
        // Re-read to confirm persistence (not just an echo response).
        const get = await apiReq(base, "/api/settings/agent-mode", { cookie: cookieA });
        assert.equal(get.json.mode, mode, `GET reflects PATCH for ${mode}`);
      }
    });

    await test("PATCH /settings/agent-mode rejects invalid mode with 400", async () => {
      // Snapshot current mode so we can verify it didn't mutate.
      const before = await apiReq(base, "/api/settings/agent-mode", { cookie: cookieA });
      const invalid = await apiReq(base, "/api/settings/agent-mode", {
        method: "PATCH", cookie: cookieA, body: { mode: "supervisor_god_mode" },
      });
      assert.equal(invalid.res.status, 400, "invalid mode → 400");
      assert.ok(invalid.json.error?.includes("mode must be one of"), "error message lists valid modes");
      const after = await apiReq(base, "/api/settings/agent-mode", { cookie: cookieA });
      assert.equal(after.json.mode, before.json.mode, "invalid PATCH does NOT mutate the column");
    });

    await test("PATCH /settings/agent-mode rejects empty/missing mode with 400", async () => {
      const out = await apiReq(base, "/api/settings/agent-mode", {
        method: "PATCH", cookie: cookieA, body: {},
      });
      assert.equal(out.res.status, 400);
    });

    await test("cross-workspace isolation — admin B sees their own default, NOT A's last PATCH", async () => {
      // A set autonomous earlier; B's workspace should still be at the
      // baseline default. Defence-in-depth on the `req.workspaceId`
      // gate inside the route handler.
      await apiReq(base, "/api/settings/agent-mode", {
        method: "PATCH", cookie: cookieA, body: { mode: "autonomous" },
      });
      const bMode = await apiReq(base, "/api/settings/agent-mode", { cookie: cookieB });
      assert.equal(bMode.res.status, 200);
      assert.equal(bMode.json.mode, "pipeline", "workspace B's mode is isolated from workspace A's PATCH");
    });

    await test("repo layer: getAgentMode round-trips through setAgentMode", async () => {
      const ws = a.workspaceId;
      workspaceRepo.setAgentMode(ws, "envelope");
      assert.equal(workspaceRepo.getAgentMode(ws), "envelope");
      workspaceRepo.setAgentMode(ws, "autonomous");
      assert.equal(workspaceRepo.getAgentMode(ws), "autonomous");
      // Defence-in-depth: invalid mode arg coerces to "pipeline" rather
      // than throwing or writing garbage. Matches the route-layer 400
      // guard but defends direct repo callers (background jobs, eval
      // harness) that might bypass the route validation.
      workspaceRepo.setAgentMode(ws, "not_a_real_mode");
      assert.equal(workspaceRepo.getAgentMode(ws), "pipeline", "invalid mode coerces to pipeline at the repo layer");
    });

    await test("getAgentMode returns 'pipeline' for null workspaceId (smoke-test path)", () => {
      assert.equal(workspaceRepo.getAgentMode(null), "pipeline");
      assert.equal(workspaceRepo.getAgentMode(undefined), "pipeline");
      assert.equal(workspaceRepo.getAgentMode(""), "pipeline");
    });

    summary("agent-mode-routes");
  } finally { await new Promise((r) => server.close(r)); }
}

main().catch((err) => { console.error(err); process.exit(1); });

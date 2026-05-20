import assert from "node:assert/strict";
import { createServer } from "node:http";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import settingsRouter from "../src/routes/settings.js";
import { createTestContext } from "./helpers/test-base.js";

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
    const { token } = await t.registerAndLogin(base, { name: "Admin", email: `ac-${Date.now()}@x.test`, password: "Password123!" });
    const cookie = `access_token=${token}`;

    await test("CRUD round-trip", async () => {
      let out = await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie, body: { role: "planner", provider: "openai", fallbackRole: "critic" } });
      assert.equal(out.res.status, 201);
      out = await apiReq(base, "/api/settings/agent-roles", { cookie });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.roles.length, 1);
      out = await apiReq(base, "/api/settings/agent-roles/planner", { method: "PATCH", cookie, body: { model: "gpt-4o-mini" } });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.model, "gpt-4o-mini");
      out = await apiReq(base, "/api/settings/agent-roles/planner", { method: "DELETE", cookie });
      assert.equal(out.res.status, 200);
    });

    await test("role-name allowlist enforced", async () => {
      const out = await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie, body: { role: "hacker" } });
      assert.equal(out.res.status, 400);
    });

    await test("fallback cycle detection", async () => {
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie, body: { role: "planner", fallbackRole: "critic" } });
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie, body: { role: "critic", fallbackRole: "codegen" } });
      const out = await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie, body: { role: "codegen", fallbackRole: "planner" } });
      assert.equal(out.res.status, 400);
    });

    summary("agent-config-routes");
  } finally { await new Promise((r) => server.close(r)); }
}

main().catch((err) => { console.error(err); process.exit(1); });

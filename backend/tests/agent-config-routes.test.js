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
    const a = await t.registerAndLogin(base, { name: "Admin A", email: `aca-${Date.now()}@x.test`, password: "Password123!" });
    const b = await t.registerAndLogin(base, { name: "Admin B", email: `acb-${Date.now()}@x.test`, password: "Password123!" });
    const cookieA = `access_token=${a.token}`;
    const cookieB = `access_token=${b.token}`;

    await test("CRUD round-trip", async () => {
      let out = await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "planner", provider: "openai", fallbackRole: "reviewer" } });
      assert.equal(out.res.status, 201);
      out = await apiReq(base, "/api/settings/agent-roles", { cookie: cookieA });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.roles.length, 1);
      out = await apiReq(base, "/api/settings/agent-roles/planner", { method: "PATCH", cookie: cookieA, body: { model: "gpt-4o-mini" } });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.model, "gpt-4o-mini");
      out = await apiReq(base, "/api/settings/agent-roles/planner", { method: "DELETE", cookie: cookieA });
      assert.equal(out.res.status, 200);
    });

    await test("cross-workspace ACL isolation", async () => {
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "reviewer", provider: "anthropic" } });
      const own = await apiReq(base, "/api/settings/agent-roles", { cookie: cookieA });
      const other = await apiReq(base, "/api/settings/agent-roles", { cookie: cookieB });
      assert.equal(own.res.status, 200);
      assert.equal(other.res.status, 200);
      assert.ok((own.json.roles || []).some((r) => r.role === "reviewer"));
      assert.ok(!(other.json.roles || []).some((r) => r.role === "reviewer"));
    });

    await test("role-name allowlist enforced", async () => {
      const out = await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "hacker" } });
      assert.equal(out.res.status, 400);
    });

    await test("PATCH coerces non-numeric temperature/maxTokens", async () => {
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "oracle", temperature: 0.5, maxTokens: 256 } });
      const out = await apiReq(base, "/api/settings/agent-roles/oracle", { method: "PATCH", cookie: cookieA, body: { temperature: "not_a_number", maxTokens: "evil" } });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.temperature, 0.5);
      assert.equal(out.json.maxTokens, 256);
    });

    await test("rejects oversized systemPromptOverride", async () => {
      const huge = "x".repeat(32_001);
      let out = await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "triager", systemPromptOverride: huge } });
      assert.equal(out.res.status, 400);
      // PATCH path too — establish the row first with a small prompt, then attempt to balloon it.
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "triager", systemPromptOverride: "small" } });
      out = await apiReq(base, "/api/settings/agent-roles/triager", { method: "PATCH", cookie: cookieA, body: { systemPromptOverride: huge } });
      assert.equal(out.res.status, 400);
    });

    await test("deleting a role clears dangling fallbackRole refs in siblings", async () => {
      // planner → healer; deleting healer should null planner.fallbackRole
      // so AI-005 dispatch never resolves a dangling reference.
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "healer" } });
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "planner", fallbackRole: "healer" } });
      let out = await apiReq(base, "/api/settings/agent-roles/healer", { method: "DELETE", cookie: cookieA });
      assert.equal(out.res.status, 200);
      out = await apiReq(base, "/api/settings/agent-roles", { cookie: cookieA });
      const planner = (out.json.roles || []).find((r) => r.role === "planner");
      assert.ok(planner, "planner row should still exist");
      assert.equal(planner.fallbackRole, null, "planner.fallbackRole should be nulled after healer delete");
    });

    await test("fallback cycle detection", async () => {
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "planner", fallbackRole: "reviewer" } });
      await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "reviewer", fallbackRole: "author" } });
      const out = await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "author", fallbackRole: "planner" } });
      assert.equal(out.res.status, 400);
    });

    summary("agent-config-routes");
  } finally { await new Promise((r) => server.close(r)); }
}

main().catch((err) => { console.error(err); process.exit(1); });

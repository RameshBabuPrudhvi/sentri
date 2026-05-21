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
      // B2.1 — `agent_configs.provider` + `model` columns were dropped
      // in migration 048. The role's dispatch target now lives on a
      // `provider_routes` row referenced by `routeId`. POST below
      // creates the role; the PATCH assignment exercises the new
      // route-driven update surface instead of the dropped `model`
      // field.
      let out = await apiReq(base, "/api/settings/agent-roles", { method: "POST", cookie: cookieA, body: { role: "planner", fallbackRole: "reviewer" } });
      assert.equal(out.res.status, 201);
      out = await apiReq(base, "/api/settings/agent-roles", { cookie: cookieA });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.roles.length, 1);
      // Create a real `provider_routes` row in workspace A so the PATCH
      // below has a valid routeId target. `providerRouteRepo.upsert` is
      // workspace-scoped by `agentConfigRepo.upsert`'s validation, so
      // creating in A and PATCHing planner@A is the canonical flow an
      // admin would use from Settings → Provider Routes → Agent Roles.
      const routeRes = await apiReq(base, "/api/settings/provider-routes", {
        method: "POST",
        cookie: cookieA,
        body: {
          name: "openai-gpt-4o-mini",
          family: "openai",
          protocol: "openai",
          model: "gpt-4o-mini",
        },
      });
      assert.equal(routeRes.res.status, 201);
      const routeId = routeRes.json.id;
      assert.ok(routeId?.startsWith("pr-"), "provider_routes upsert must return pr-... id");
      out = await apiReq(base, "/api/settings/agent-roles/planner", { method: "PATCH", cookie: cookieA, body: { routeId } });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.routeId, routeId, "routeId persists on the agent_configs row post-PATCH");
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

    // B4.3 — `agent_configs.fallbackRole` was dropped by migration 053.
    // The role-level cascade-null and the cycle detector were both
    // removed; the canonical per-route fallback now lives on
    // `provider_routes.fallbackRouteId` with cycle protection enforced
    // in `providerRouteRepo.upsert` (ERR_ROUTE_FALLBACK_CYCLE). The two
    // tests that lived here ("deleting a role clears dangling
    // fallbackRole refs in siblings" + "fallback cycle detection")
    // exercised behaviour that no longer exists at the column level and
    // are intentionally removed rather than ported — re-adding them
    // would test dead code.

    summary("agent-config-routes");
  } finally { await new Promise((r) => server.close(r)); }
}

main().catch((err) => { console.error(err); process.exit(1); });

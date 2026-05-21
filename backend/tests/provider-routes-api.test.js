/**
 * @module tests/provider-routes-api
 * @description B3.11 — Provider Routes HTTP CRUD + probe + rotate-key
 *   endpoints, admin gating. Integration test against the real Express
 *   routes with an in-memory SQLite DB.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");
process.env.SKIP_EMAIL_VERIFICATION = "true";
const { createTestContext } = await import("./helpers/test-base.js");
const t = createTestContext();
const { test, summary } = t.createTestRunner();
let base, server, cookie;
// Boot
t.resetDb();
const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true", ANTHROPIC_API_KEY: "sk-test-anthropic-key-1234567890" });
t.app.use("/api", (await import("../src/middleware/authenticate.js")).default, t.workspaceScope, (await import("../src/routes/settings.js")).default);
server = t.app.listen(0);
base = `http://127.0.0.1:${server.address().port}`;
const auth = await t.registerAndLogin(base, { name: "Admin", email: `admin-${Date.now()}@test.local`, password: "Password123!" });
cookie = `access_token=${auth.token}`;
// ── CRUD ──────────────────────────────────────────────────────────────────────
test("POST /settings/provider-routes creates a route", async () => {
  const { res, json } = await t.req(base, "/api/settings/provider-routes", {
    method: "POST", cookie,
    body: { name: "test-route-1", family: "openai", protocol: "openai", model: "gpt-4o-mini", apiKey: "sk-test-create-key-1234567890" },
  });
  assert.equal(res.status, 201);
  assert.ok(json.id?.startsWith("pr-"));
  assert.equal(json.name, "test-route-1");
  assert.equal(json.family, "openai");
  assert.equal(json.apiKeyLastFour, "7890");
  // Secret blobs must NOT be in the response
  assert.equal(json.apiKeyEncrypted, undefined);
  assert.equal(json.apiKeyNonce, undefined);
});
test("GET /settings/provider-routes lists routes", async () => {
  const { res, json } = await t.req(base, "/api/settings/provider-routes", { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(json.routes));
  assert.ok(json.routes.length >= 1);
  assert.equal(json.routes[0].apiKeyEncrypted, undefined, "secret blob must not leak in list");
});
test("PATCH /settings/provider-routes/:id updates a route", async () => {
  const list = await t.req(base, "/api/settings/provider-routes", { cookie });
  const routeId = list.json.routes[0].id;
  const { res, json } = await t.req(base, `/api/settings/provider-routes/${routeId}`, {
    method: "PATCH", cookie,
    body: { name: "renamed-route" },
  });
  assert.equal(res.status, 200);
  assert.equal(json.name, "renamed-route");
});
test("PATCH rejects apiKey field (must use rotate-key)", async () => {
  const list = await t.req(base, "/api/settings/provider-routes", { cookie });
  const routeId = list.json.routes[0].id;
  const { res } = await t.req(base, `/api/settings/provider-routes/${routeId}`, {
    method: "PATCH", cookie,
    body: { apiKey: "sk-new-key-should-be-rejected" },
  });
  assert.equal(res.status, 400);
});
test("DELETE /settings/provider-routes/:id deletes a route", async () => {
  // Create a throwaway route to delete
  const create = await t.req(base, "/api/settings/provider-routes", {
    method: "POST", cookie,
    body: { name: `del-${Date.now()}`, family: "openai", protocol: "openai", model: "gpt-4o-mini" },
  });
  const { res } = await t.req(base, `/api/settings/provider-routes/${create.json.id}`, {
    method: "DELETE", cookie,
  });
  assert.equal(res.status, 200);
});
test("DELETE refuses when agent_configs references the route", async () => {
  const create = await t.req(base, "/api/settings/provider-routes", {
    method: "POST", cookie,
    body: { name: `pinned-${Date.now()}`, family: "anthropic", protocol: "anthropic", model: "claude-3-5-sonnet" },
  });
  // Pin the route to an agent role
  await t.req(base, "/api/settings/agent-roles", {
    method: "POST", cookie,
    body: { role: "planner", routeId: create.json.id },
  });
  const { res } = await t.req(base, `/api/settings/provider-routes/${create.json.id}`, {
    method: "DELETE", cookie,
  });
  assert.equal(res.status, 409, "should refuse deletion when route is in use");
});
test("POST with invalid family returns 400", async () => {
  const { res } = await t.req(base, "/api/settings/provider-routes", {
    method: "POST", cookie,
    body: { name: "bad-family", family: "invalid", protocol: "openai", model: "m" },
  });
  assert.equal(res.status, 400);
});
// ── Audit log ─────────────────────────────────────────────────────────────────
test("GET /settings/provider-routes/audit returns audit entries", async () => {
  const { res, json } = await t.req(base, "/api/settings/provider-routes/audit", { cookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(json.items));
  assert.ok(json.items.length >= 1, "should have at least one audit entry from creates above");
});
// Cleanup
await new Promise((r) => server.close(r));
env.restore();
summary("Provider Routes API (B3.11)");

/**
 * @module tests/routes-import-export
 * @description B3.11 — JSON import/export round-trip, mode semantics,
 *   secret redaction, schema version validation.
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
t.resetDb();
const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true", ANTHROPIC_API_KEY: "sk-test-anthropic-key-1234567890" });
const authRouter = (await import("../src/routes/auth.js")).default;
const { requireAuth } = await import("../src/routes/auth.js");
const settingsRouter = (await import("../src/routes/settings.js")).default;
t.app.use("/api/auth", authRouter);
t.app.use("/api", requireAuth, t.workspaceScope, settingsRouter);
server = t.app.listen(0);
base = `http://127.0.0.1:${server.address().port}`;
const auth = await t.registerAndLogin(base, { name: "Admin", email: `admin-${Date.now()}@test.local`, password: "Password123!" });
cookie = `access_token=${auth.token}`;
// Seed two routes
await t.req(base, "/api/settings/provider-routes", {
  method: "POST", cookie,
  body: { name: "export-route-1", family: "openai", protocol: "openai", model: "gpt-4o-mini", apiKey: "sk-export-test-key-1234567890" },
});
await t.req(base, "/api/settings/provider-routes", {
  method: "POST", cookie,
  body: { name: "export-route-2", family: "anthropic", protocol: "anthropic", model: "claude-3-5-sonnet" },
});
test("GET /settings/provider-routes/export returns schema-v1 payload", async () => {
  const { res, json } = await t.req(base, "/api/settings/provider-routes/export", { cookie });
  assert.equal(res.status, 200);
  assert.equal(json.schemaVersion, 1);
  assert.ok(Array.isArray(json.routes));
  assert.equal(json.routes.length, 2);
  // Secrets must be redacted — only apiKeyLastFour round-trips
  for (const r of json.routes) {
    assert.equal(r.apiKeyEncrypted, undefined, "ciphertext must not be in export");
    assert.equal(r.apiKeyNonce, undefined, "nonce must not be in export");
  }
});
test("POST /settings/provider-routes/import with mode=skip skips existing names", async () => {
  const exp = await t.req(base, "/api/settings/provider-routes/export", { cookie });
  const { res, json } = await t.req(base, "/api/settings/provider-routes/import", {
    method: "POST", cookie,
    body: { ...exp.json, mode: "skip" },
  });
  assert.equal(res.status, 200);
  assert.equal(json.skipped, 2, "both existing routes should be skipped");
  assert.equal(json.created, 0);
});
test("POST /settings/provider-routes/import with mode=rename creates suffixed copies", async () => {
  const exp = await t.req(base, "/api/settings/provider-routes/export", { cookie });
  const { res, json } = await t.req(base, "/api/settings/provider-routes/import", {
    method: "POST", cookie,
    body: { ...exp.json, mode: "rename" },
  });
  assert.equal(res.status, 200);
  assert.equal(json.renamed, 2, "both routes should be renamed");
  // Verify the renamed routes exist
  const list = await t.req(base, "/api/settings/provider-routes", { cookie });
  const names = list.json.routes.map((r) => r.name);
  assert.ok(names.includes("export-route-1-2"), "renamed route should have -2 suffix");
});
test("POST /settings/provider-routes/import rejects unsupported schemaVersion", async () => {
  const { res } = await t.req(base, "/api/settings/provider-routes/import", {
    method: "POST", cookie,
    body: { schemaVersion: 999, routes: [], mode: "skip" },
  });
  assert.equal(res.status, 400);
});
test("POST /settings/provider-routes/import rejects missing mode", async () => {
  const { res } = await t.req(base, "/api/settings/provider-routes/import", {
    method: "POST", cookie,
    body: { schemaVersion: 1, routes: [] },
  });
  assert.equal(res.status, 400);
});
await new Promise((r) => server.close(r));
env.restore();
summary("Routes import/export (B3.11)");

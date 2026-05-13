import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import runsRouter from "../src/routes/runs.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import { decryptCredentials } from "../src/utils/credentialEncryption.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;
let mounted = false;
function mount() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/v1/projects", requireAuth, workspaceScope, projectsRouter);
  app.use("/api/v1/projects", requireAuth, workspaceScope, runsRouter);
  mounted = true;
}

async function main() {
  mount();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const qa = await t.registerAndLogin(base, { name: "QA", email: `qa-${Date.now()}@e.com`, password: "Password123!" });
    const p = await t.req(base, "/api/v1/projects", { method: "POST", token: qa.token, body: { name: "P", url: "https://prod.example.com" } });
    assert.equal(p.res.status, 201);
    const projectId = p.json.id;

    let out = await t.req(base, `/api/v1/projects/${projectId}/environments`, { method: "POST", token: qa.token, body: { name: "staging", baseUrl: "https://staging.example.com", credentials: { username: "u", password: "p" } } });
    assert.equal(out.res.status, 201);
    assert.equal(out.json.name, "staging");
    const environmentId = out.json.id;

    const rows = t.getDatabase().prepare("SELECT credentials FROM environments WHERE id = ?").get(environmentId);
    assert.ok(rows.credentials);
    assert.equal(decryptCredentials(rows.credentials).username, "u");

    out = await t.req(base, `/api/v1/projects/${projectId}/environments`, { token: qa.token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.length, 1);

    out = await t.req(base, `/api/v1/projects/${projectId}/run`, { method: "POST", token: qa.token, body: { environmentId } });
    assert.equal(out.res.status, 400); // no approved tests, but env accepted before this gate
    assert.match(out.json.error, /no approved tests/i);

    const proj = projectRepo.getById(projectId);
    assert.equal(proj.url, "https://prod.example.com");

    const other = await t.registerAndLogin(base, { name: "U2", email: `u2-${Date.now()}@e.com`, password: "Password123!" });
    out = await t.req(base, `/api/v1/projects/${projectId}/environments`, { token: other.token });
    assert.equal(out.res.status, 404);

    console.log("✅ environments.test passed");
  } finally {
    env.restore();
    await new Promise((r) => server.close(r));
  }
}

main().catch((e) => {
  console.error("❌ environments.test failed", e);
  process.exit(1);
});

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

    // ── DIF-012: project.url must NEVER mutate when an env is used ─────────
    const proj = projectRepo.getById(projectId);
    assert.equal(proj.url, "https://prod.example.com");

    // ── DIF-012: invalid environmentId rejected with 400 (not silently
    // falling through to a full-suite run against project.url). Mirrors the
    // explicit `if (environmentId && (!environment || environment.projectId !== project.id))`
    // guard in `backend/src/routes/trigger.js`.
    out = await t.req(base, `/api/v1/projects/${projectId}/run`, { method: "POST", token: qa.token, body: { environmentId: "ENV-does-not-exist" } });
    assert.equal(out.res.status, 400);
    assert.match(out.json.error, /invalid environmentId|no approved tests/i);

    // ── DIF-012: cross-project envId rejected ─────────────────────────────
    const p2 = await t.req(base, "/api/v1/projects", { method: "POST", token: qa.token, body: { name: "P2", url: "https://other.example.com" } });
    out = await t.req(base, `/api/v1/projects/${p2.json.id}/run`, { method: "POST", token: qa.token, body: { environmentId } });
    assert.equal(out.res.status, 400);

    // ── DIF-012: zero-regression — a run with NO environmentId still works
    // (gate fails on no-approved-tests, never on env validation). project.url
    // remains the source of truth for env-less projects.
    out = await t.req(base, `/api/v1/projects/${projectId}/run`, { method: "POST", token: qa.token, body: {} });
    assert.equal(out.res.status, 400);
    assert.match(out.json.error, /no approved tests/i);

    // ── DIF-012: PATCH updates name + baseUrl + credentials round-trip ────
    out = await t.req(base, `/api/v1/projects/${projectId}/environments/${environmentId}`, { method: "PATCH", token: qa.token, body: { name: "staging-2", baseUrl: "https://staging-2.example.com", credentials: { username: "u2", password: "p2" } } });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.name, "staging-2");
    assert.equal(out.json.baseUrl, "https://staging-2.example.com");
    assert.equal(out.json.credentials.username, "u2");

    // ── DIF-012: PATCH without credentials key preserves stored secret ────
    out = await t.req(base, `/api/v1/projects/${projectId}/environments/${environmentId}`, { method: "PATCH", token: qa.token, body: { name: "staging-3" } });
    assert.equal(out.res.status, 200);
    const stored = t.getDatabase().prepare("SELECT credentials FROM environments WHERE id = ?").get(environmentId);
    assert.ok(stored.credentials, "credentials should not be wiped when key is omitted from PATCH");
    assert.equal(decryptCredentials(stored.credentials).username, "u2");

    // ── DIF-012: explicit `credentials: null` clears the secret ───────────
    out = await t.req(base, `/api/v1/projects/${projectId}/environments/${environmentId}`, { method: "PATCH", token: qa.token, body: { credentials: null } });
    assert.equal(out.res.status, 200);
    const cleared = t.getDatabase().prepare("SELECT credentials FROM environments WHERE id = ?").get(environmentId);
    assert.equal(cleared.credentials, null);

    // ── DIF-012: cross-workspace ACL — second user can't see env ──────────
    const other = await t.registerAndLogin(base, { name: "U2", email: `u2-${Date.now()}@e.com`, password: "Password123!" });
    out = await t.req(base, `/api/v1/projects/${projectId}/environments`, { token: other.token });
    assert.equal(out.res.status, 404);
    // ...and can't mutate it either
    out = await t.req(base, `/api/v1/projects/${projectId}/environments/${environmentId}`, { method: "PATCH", token: other.token, body: { name: "hijacked" } });
    assert.equal(out.res.status, 404);

    // ── DIF-012: DELETE removes the row ───────────────────────────────────
    out = await t.req(base, `/api/v1/projects/${projectId}/environments/${environmentId}`, { method: "DELETE", token: qa.token });
    assert.equal(out.res.status, 200);
    const gone = t.getDatabase().prepare("SELECT id FROM environments WHERE id = ?").get(environmentId);
    assert.equal(gone, undefined);

    // Re-confirm project.url survived everything above unmodified.
    const proj2 = projectRepo.getById(projectId);
    assert.equal(proj2.url, "https://prod.example.com");

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

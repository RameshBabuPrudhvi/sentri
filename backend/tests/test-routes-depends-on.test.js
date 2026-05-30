import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import testsRouter from "../src/routes/tests.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/v1/projects", requireAuth, workspaceScope, projectsRouter);
  app.use("/api/v1", requireAuth, workspaceScope, testsRouter);
  mounted = true;
}

function seedTest(projectId, id, overrides = {}) {
  testRepo.create({
    id,
    projectId,
    name: id,
    steps: [],
    reviewStatus: "draft",
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

async function createProject(base, token, name) {
  const out = await t.req(base, "/api/v1/projects", {
    method: "POST",
    token,
    body: { name, url: "https://example.com" },
  });
  assert.equal(out.res.status, 201, out.json.error);
  return out.json.id;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { token } = await t.registerAndLogin(base, {
      name: "QA", email: `qa-deps-${Date.now()}@example.com`, password: "Password123!",
    });
    const projectId = await createProject(base, token, "Deps");
    seedTest(projectId, "TC-A");
    seedTest(projectId, "TC-B", { dependsOn: ["TC-A"] });

    let out = await t.req(base, `/api/v1/tests/TC-A`, {
      method: "PATCH",
      token,
      body: { dependsOn: "TC-B" },
    });
    assert.equal(out.res.status, 400);
    assert.equal(out.json.code, "INVALID_DEPENDS_ON");

    out = await t.req(base, `/api/v1/tests/TC-A`, {
      method: "PATCH",
      token,
      body: { dependsOn: [42] },
    });
    assert.equal(out.res.status, 400);
    assert.equal(out.json.code, "INVALID_DEPENDS_ON");
    assert.equal(out.json.index, 0);

    out = await t.req(base, `/api/v1/tests/TC-A`, {
      method: "PATCH",
      token,
      body: { dependsOn: ["TC-NOPE"] },
    });
    assert.equal(out.res.status, 400);
    assert.equal(out.json.code, "MISSING_UPSTREAM");
    assert.equal(out.json.testId, "TC-NOPE");

    out = await t.req(base, `/api/v1/tests/TC-A`, {
      method: "PATCH",
      token,
      body: { dependsOn: ["TC-A"] },
    });
    assert.equal(out.res.status, 400);
    assert.equal(out.json.code, "CYCLE_DETECTED");
    assert.deepEqual(out.json.path, ["TC-A", "TC-A"]);

    out = await t.req(base, `/api/v1/tests/TC-A`, {
      method: "PATCH",
      token,
      body: { dependsOn: ["TC-B"] },
    });
    assert.equal(out.res.status, 400);
    assert.equal(out.json.code, "CYCLE_DETECTED");
    assert.deepEqual(out.json.path, ["TC-A", "TC-B", "TC-A"]);
    assert.deepEqual(testRepo.getById("TC-A").dependsOn, null);

    out = await t.req(base, `/api/v1/tests/TC-B`, {
      method: "PATCH",
      token,
      body: { dependsOn: [] },
    });
    assert.equal(out.res.status, 200, out.json.error);
    assert.deepEqual(out.json.dependsOn, []);

    out = await t.req(base, `/api/v1/tests/TC-B`, {
      method: "PATCH",
      token,
      body: { dependsOn: ["TC-A"] },
    });
    assert.equal(out.res.status, 200, out.json.error);
    assert.deepEqual(out.json.dependsOn, ["TC-A"]);

    out = await t.req(base, `/api/v1/projects/${projectId}/tests`, {
      method: "POST",
      token,
      body: { name: "Manual dependent", steps: [], dependsOn: ["TC-A"] },
    });
    assert.equal(out.res.status, 201, out.json.error);
    assert.deepEqual(out.json.dependsOn, ["TC-A"]);

    const { token: otherToken } = await t.registerAndLogin(base, {
      name: "Other", email: `other-deps-${Date.now()}@example.com`, password: "Password123!",
    });
    out = await t.req(base, `/api/v1/tests/TC-A`, {
      method: "PATCH",
      token: otherToken,
      body: { dependsOn: [] },
    });
    assert.equal(out.res.status, 404);
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import runsRouter from "../src/routes/runs.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, req, workspaceScope } = t;

app.use("/api/auth", authRouter);
app.use("/api/projects", requireAuth, workspaceScope, projectsRouter);
app.use("/api", requireAuth, workspaceScope, runsRouter);

async function main() {
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const { token } = await t.registerAndLogin(base, { name: "U", email: `u-${Date.now()}@x.local`, password: "Password123!" });
    let out = await req(base, "/api/projects", { method: "POST", token, body: { name: "P", url: "https://example.com" } });
    assert.equal(out.res.status, 201);
    const projectId = out.json.id;

    runRepo.create({ id: "RUN_NEW", projectId, type: "test_run", status: "completed", results: [
      { testId: "T1", testName: "A", status: "failed" },
      { testId: "T2", testName: "B", status: "passed" },
      { testId: "T3", testName: "C", status: "passed" },
    ] });
    runRepo.create({ id: "RUN_OLD", projectId, type: "test_run", status: "completed", results: [
      { testId: "T1", testName: "A", status: "passed" },
      { testId: "T2", testName: "B", status: "passed" },
      { testId: "T4", testName: "D", status: "failed" },
    ] });

    out = await req(base, "/api/runs/RUN_NEW/compare/RUN_OLD", { token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.summary.flipped, 1);
    assert.equal(out.json.summary.added, 1);
    assert.equal(out.json.summary.removed, 1);

    out = await req(base, "/api/runs/RUN_NEW/compare/NOPE", { token });
    assert.equal(out.res.status, 404);

    console.log("✅ run-compare: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ run-compare failed:", err);
  process.exit(1);
});

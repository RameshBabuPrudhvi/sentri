// Integration tests for CAP-001 HTTP routes:
//   - GET  /api/v1/tests/:testId/fixtures  (anyAuthenticatedMember)
//   - POST /api/v1/tests/:testId/fixtures  (qa_lead+, format allowlist)
//
// Companion to backend/tests/fixture-iteration.test.js, which covers the
// repo + helpers in isolation. This file exercises the actual Express
// handlers end-to-end so the route guards, workspace scoping, format
// allowlist, and CSV / JSON / iteration-cap branches are covered.

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

function seedTest(projectId, overrides = {}) {
  const id = overrides.id || `TST-FIX-${Math.random().toString(36).slice(2, 8)}`;
  testRepo.create({
    id,
    projectId,
    name: overrides.name || "fixture target",
    steps: [],
    reviewStatus: "approved",
    reviewedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    codeVersion: overrides.codeVersion ?? 1,
    ...overrides,
  });
  return id;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  // Fixtures table is outside the helper's RESET_TABLES list — clear it
  // ourselves so a leftover row from a previous run doesn't bleed in.
  try { t.getDatabase().exec("DELETE FROM test_fixtures"); } catch { /* table may not exist */ }
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { token } = await t.registerAndLogin(base, {
      name: "QA", email: `qa-${Date.now()}@example.com`, password: "Password123!",
    });

    const created = await t.req(base, "/api/v1/projects", {
      method: "POST", token, body: { name: "P", url: "https://example.com" },
    });
    assert.equal(created.res.status, 201);
    const projectId = created.json.id;
    const testId = seedTest(projectId);

    // ── GET on a test with no fixtures yet returns [] (not 404) ───────────
    let out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, { token });
    assert.equal(out.res.status, 200);
    assert.deepEqual(out.json, []);

    // ── POST JSON happy path: version mirrors test.codeVersion ────────────
    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, {
      method: "POST", token,
      body: { format: "json", rows: [{ email: "a@x.com" }, { email: "b@x.com" }] },
    });
    assert.equal(out.res.status, 201);
    assert.equal(out.json.format, "json");
    assert.equal(out.json.version, 1);
    assert.equal(out.json.rows.length, 2);
    assert.equal(out.json.capApplied, 10); // default cap
    assert.equal(out.json.truncated, false);

    // ── GET reflects the upload ───────────────────────────────────────────
    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, { token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.length, 1);
    assert.equal(out.json[0].version, 1);

    // ── POST CSV happy path: header + 2 data rows → 2 row objects ─────────
    const csvTestId = seedTest(projectId, { codeVersion: 2 });
    out = await t.req(base, `/api/v1/tests/${csvTestId}/fixtures`, {
      method: "POST", token,
      body: { format: "csv", csvText: "email,role\na@x.com,admin\nb@x.com,viewer" },
    });
    assert.equal(out.res.status, 201);
    assert.equal(out.json.version, 2); // mirrors test.codeVersion=2
    assert.deepEqual(out.json.rows, [
      { email: "a@x.com", role: "admin" },
      { email: "b@x.com", role: "viewer" },
    ]);

    // ── POST format allowlist: rejects unknown format ─────────────────────
    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, {
      method: "POST", token,
      body: { format: "xml", rows: [{ x: 1 }] },
    });
    assert.equal(out.res.status, 400);
    assert.match(out.json.error, /format must be/);

    // ── POST rejects empty / missing rows ─────────────────────────────────
    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, {
      method: "POST", token,
      body: { format: "json", rows: [] },
    });
    assert.equal(out.res.status, 400);

    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, {
      method: "POST", token,
      body: { format: "csv", csvText: "" },
    });
    assert.equal(out.res.status, 400);

    // ── POST honours per-request iteration cap override + reports truncation
    const rows15 = Array.from({ length: 15 }, (_, i) => ({ idx: i }));
    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, {
      method: "POST", token,
      body: { format: "json", rows: rows15, iterationCap: 5 },
    });
    assert.equal(out.res.status, 201);
    assert.equal(out.json.capApplied, 5);
    assert.equal(out.json.truncated, true);
    assert.equal(out.json.rows.length, 5);

    // ── POST clamps an out-of-range cap to [1, 100] without 400 ───────────
    // (clampIterationCap is intentionally permissive on the runtime side —
    // bad inputs fall back to the default rather than rejecting.)
    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, {
      method: "POST", token,
      body: { format: "json", rows: [{ x: 1 }], iterationCap: 9999 },
    });
    assert.equal(out.res.status, 201);
    assert.equal(out.json.capApplied, 100);

    // ── 404: unknown testId ───────────────────────────────────────────────
    out = await t.req(base, `/api/v1/tests/NOPE/fixtures`, { token });
    assert.equal(out.res.status, 404);
    out = await t.req(base, `/api/v1/tests/NOPE/fixtures`, {
      method: "POST", token, body: { format: "json", rows: [{ x: 1 }] },
    });
    assert.equal(out.res.status, 404);

    // ── 404: cross-workspace ACL (second user can't see this test) ────────
    const { token: otherToken } = await t.registerAndLogin(base, {
      name: "U2", email: `u2-${Date.now()}@example.com`, password: "Password123!",
    });
    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, { token: otherToken });
    assert.equal(out.res.status, 404);
    out = await t.req(base, `/api/v1/tests/${testId}/fixtures`, {
      method: "POST", token: otherToken, body: { format: "json", rows: [{ x: 1 }] },
    });
    assert.equal(out.res.status, 404);

    console.log("✅ test-fixtures-routes: all checks passed");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("❌ test-fixtures-routes failed:", err);
  process.exit(1);
});

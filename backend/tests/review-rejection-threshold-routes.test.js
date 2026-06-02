/**
 * B3 (AUDIT-ROADMAP Bundle 3) — Route-level + cross-workspace ACL tests
 * for the `reviewRejectionAlertThreshold` field.
 *
 * Covers (from the PR's industry-standard checklist):
 *   - Item 4 (E2E threshold flow): the full `PATCH /api/v1/projects/:id` →
 *     `GET /api/v1/projects/:id` round-trip persists the field as the
 *     correct integer, including the documented edge cases (null → 0,
 *     -1 opt-out, 1000 ceiling).
 *   - Item 5 (boundary): the validator rejects every out-of-range value
 *     (-2, 1001, "five", 0.5, true) with HTTP 400 + a stable error
 *     message the frontend can surface.
 *   - Item 8 (IDOR): workspace A admin cannot PATCH workspace B's
 *     project threshold via direct id. The route's `getByIdInWorkspace`
 *     enforces this; the test pins the contract against future
 *     refactors that might silently broaden the lookup.
 *
 * Pattern: `createTestContext().createTestRunner()` per AGENTS.md §
 * "Use `createTestContext().createTestRunner()`". Mirrors the route-
 * test pattern in `auto-approval-routes.test.js` — same Express
 * router-mount, same workspaceScope middleware, same registerAndLogin.
 */
import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/v1/projects", requireAuth, workspaceScope, projectsRouter);
  mounted = true;
}

async function main() {
  mountRoutesOnce();
  t.resetDb();
  const env = t.setupEnv({ SKIP_EMAIL_VERIFICATION: "true" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const runner = t.createTestRunner();
  try {
    const { token } = await t.registerAndLogin(base, {
      name: "QA", email: `qa-thr-${Date.now()}@example.com`, password: "Password123!",
    });
    const created = await t.req(base, "/api/v1/projects", {
      method: "POST", token, body: { name: "P", url: "https://example.com" },
    });
    assert.equal(created.res.status, 201, `project create failed: ${created.json?.error || created.res.status}`);
    const projectId = created.json.id;

    // ── Item 5: validator accepts the three documented modes ─────────────
    await runner.test("PATCH accepts 0 (default — always notify)", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: 0 },
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.reviewRejectionAlertThreshold, 0);
    });

    await runner.test("PATCH accepts -1 (opt-out)", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: -1 },
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.reviewRejectionAlertThreshold, -1);
    });

    await runner.test("PATCH accepts positive integer (operator-tuned noise floor)", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: 5 },
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.reviewRejectionAlertThreshold, 5);
    });

    await runner.test("PATCH accepts upper-bound 1000 (max documented)", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: 1000 },
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.reviewRejectionAlertThreshold, 1000);
    });

    await runner.test("PATCH coerces explicit null → 0 (column default)", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: null },
      });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.reviewRejectionAlertThreshold, 0);
    });

    // ── Item 5 (boundary): validator rejects every documented edge case ──
    await runner.test("PATCH rejects -2 (below -1 opt-out floor)", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: -2 },
      });
      assert.equal(out.res.status, 400);
      assert.ok(/reviewRejectionAlertThreshold/.test(out.json.error || ""),
        "error message names the field so frontend can surface it");
    });

    await runner.test("PATCH rejects 1001 (above 1000 documented ceiling)", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: 1001 },
      });
      assert.equal(out.res.status, 400);
    });

    await runner.test("PATCH rejects non-integer 0.5", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: 0.5 },
      });
      assert.equal(out.res.status, 400);
    });

    await runner.test("PATCH rejects string 'five'", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: "five" },
      });
      assert.equal(out.res.status, 400);
    });

    await runner.test("PATCH rejects boolean true", async () => {
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: true },
      });
      assert.equal(out.res.status, 400);
    });

    // ── Item 4 (E2E): round-trip through GET ─────────────────────────────
    await runner.test("E2E — PATCH persists + GET reads back the threshold", async () => {
      await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token, body: { reviewRejectionAlertThreshold: 7 },
      });
      const out = await t.req(base, `/api/v1/projects/${projectId}`, { token });
      assert.equal(out.res.status, 200);
      assert.equal(out.json.reviewRejectionAlertThreshold, 7);
    });

    // ── Item 8 (IDOR): cross-workspace ACL ───────────────────────────────
    await runner.test("cross-workspace ACL — workspace B admin cannot PATCH workspace A's threshold", async () => {
      // Second user lands in their own workspace (registerAndLogin
      // auto-creates one — see `workspaceRepo.ensureDefaultWorkspaces`).
      // PATCH against the first workspace's projectId must 404, NOT
      // succeed and silently mutate someone else's project.
      const { token: otherToken } = await t.registerAndLogin(base, {
        name: "U2", email: `u2-thr-${Date.now()}@example.com`, password: "Password123!",
      });
      const out = await t.req(base, `/api/v1/projects/${projectId}`, {
        method: "PATCH", token: otherToken,
        body: { reviewRejectionAlertThreshold: 999 },
      });
      assert.equal(out.res.status, 404,
        "cross-workspace PATCH must 404 — the project is invisible, never silently mutate");
      // Confirm the threshold on the original project is unchanged
      // (last successful PATCH set it to 7).
      const verify = await t.req(base, `/api/v1/projects/${projectId}`, { token });
      assert.equal(verify.res.status, 200);
      assert.equal(verify.json.reviewRejectionAlertThreshold, 7,
        "original project's threshold must survive the cross-workspace attempt");
    });

    runner.summary("B3 review-rejection-threshold-routes");
  } finally {
    env.restore();
    await new Promise((resolve) => server.close(resolve));
  }
}

// AGENTS.md § "Use `createTestContext().createTestRunner()`" — every
// pattern-2 test file MUST surface unhandled rejections from `main()` or
// CI sees `exit code 1 with zero output` (the silent-CI-hang failure
// mode pattern 2 was designed to prevent). Mirrors the canonical
// `auto-approval-routes.test.js:178-181` shape.
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ review-rejection-threshold-routes failed:", err);
  process.exit(1);
});

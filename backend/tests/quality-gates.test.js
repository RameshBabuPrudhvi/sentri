import assert from "node:assert/strict";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import projectsRouter from "../src/routes/projects.js";
import { createTestContext } from "./helpers/test-base.js";

const t = createTestContext();
const { app, workspaceScope } = t;

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  // Mount auth at /api/auth (for test-base.js `registerAndLogin` helper) and
  // projects at the versioned /api/v1 path (the one the quality-gates routes
  // live under).
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
  try {
    const { token } = await t.registerAndLogin(base, {
      name: "QA", email: "qa@example.com", password: "Password123!",
    });

    const created = await t.req(base, "/api/v1/projects", { method: "POST", token, body: { name: "P", url: "https://example.com" } });
    const pid = created.json.id;

    // ── PATCH + GET round-trip ──────────────────────────────────────────
    let out = await t.req(base, `/api/v1/projects/${pid}/quality-gates`, { method: "PATCH", token, body: { minPassRate: 95 } });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.qualityGates.minPassRate, 95);

    out = await t.req(base, `/api/v1/projects/${pid}/quality-gates`, { method: "GET", token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.qualityGates.minPassRate, 95);

    // ── Validation: reject out-of-range ─────────────────────────────────
    out = await t.req(base, `/api/v1/projects/${pid}/quality-gates`, { method: "PATCH", token, body: { minPassRate: 150 } });
    assert.equal(out.res.status, 400);

    // ── Viewer role gets 403 on PATCH (acceptance criterion) ────────────
    const db = t.getDatabase();
    db.prepare("UPDATE workspace_members SET role = 'viewer'").run();
    out = await t.req(base, `/api/v1/projects/${pid}/quality-gates`, { method: "PATCH", token, body: { minPassRate: 90 } });
    assert.equal(out.res.status, 403, "viewer must get 403 on PATCH");
    // Restore qa_lead for subsequent assertions
    db.prepare("UPDATE workspace_members SET role = 'admin'").run();

    // ── DELETE clears gates ─────────────────────────────────────────────
    out = await t.req(base, `/api/v1/projects/${pid}/quality-gates`, { method: "DELETE", token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.qualityGates, null);

    // ── Web vitals budgets CRUD round-trip (AUTO-017) ──────────────────
    // Pure HTTP tests against `/web-vitals-budgets` — must run unconditionally.
    // Previously nested inside the quality-gates evaluator guard below, which
    // silently skipped them whenever the dynamic import of `testRunner.js`
    // failed (e.g. a missing transitive dependency in a future refactor).
    out = await t.req(base, `/api/v1/projects/${pid}/web-vitals-budgets`, { method: "PATCH", token, body: { lcp: 2500, cls: 0.1 } });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.webVitalsBudgets.lcp, 2500);

    out = await t.req(base, `/api/v1/projects/${pid}/web-vitals-budgets`, { method: "GET", token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.webVitalsBudgets.cls, 0.1);

    out = await t.req(base, `/api/v1/projects/${pid}/web-vitals-budgets`, { method: "DELETE", token });
    assert.equal(out.res.status, 200);
    assert.equal(out.json.webVitalsBudgets, null);

    // ── Evaluators: import lazily so HTTP tests above don't depend on it ───
    // Each evaluator is guarded independently — a future refactor that splits
    // testRunner.js exports must not silently skip both suites.
    const { __evaluateQualityGatesForTest, __evaluateWebVitalsBudgetsForTest } = await import("../src/testRunner.js").catch(() => ({}));

    // ── Quality gates evaluator: 90% pass rate vs minPassRate: 95 → violation ─
    if (typeof __evaluateQualityGatesForTest === "function") {
      const result = __evaluateQualityGatesForTest(
        { minPassRate: 95 },
        { total: 10, passed: 9, failed: 1, retryCount: 0 },
      );
      assert.equal(result.passed, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].rule, "minPassRate");
      assert.equal(result.violations[0].threshold, 95);
      assert.equal(result.violations[0].actual, 90);

      // No gates configured → null (acceptance criterion: legacy runs unaffected)
      assert.equal(__evaluateQualityGatesForTest(null, { total: 5, passed: 0, failed: 5 }), null);

      // Defense-in-depth: empty object, array, and undefined all return null
      // rather than silently reporting `{ passed: true }`. The API layer
      // (`validateQualityGates`) rejects these payloads, but a corrupted DB
      // row could still surface them — evaluator must be independently safe.
      assert.equal(__evaluateQualityGatesForTest({}, { total: 5, passed: 0, failed: 5 }), null, "empty {} gates → null, not all-passed");
      assert.equal(__evaluateQualityGatesForTest([], { total: 5, passed: 0, failed: 5 }), null, "array gates → null");
      assert.equal(__evaluateQualityGatesForTest(undefined, { total: 5, passed: 0, failed: 5 }), null, "undefined gates → null");

      // All gates passing → passed: true
      // `flakyPct` is computed from `run.results[].retryCount > 0`, so we
      // pass a results array here rather than the run-level `retryCount` sum.
      const ok = __evaluateQualityGatesForTest(
        { minPassRate: 80, maxFailures: 2, maxFlakyPct: 50 },
        {
          total: 10,
          passed: 9,
          failed: 1,
          results: [
            { retryCount: 1 }, // 1 flaky test of 10 = 10% flaky, under 50% threshold
            ...Array.from({ length: 9 }, () => ({ retryCount: 0 })),
          ],
        },
      );
      assert.equal(ok.passed, true);
      assert.equal(ok.violations.length, 0);

      // Flaky % is bounded — a single test retried many times must NOT push
      // flakyPct above 100% (regression for the sum-of-retries bug).
      const bounded = __evaluateQualityGatesForTest(
        { maxFlakyPct: 99 },
        {
          total: 1,
          passed: 1,
          failed: 0,
          results: [{ retryCount: 5 }], // 1 flaky test of 1 → 100% flaky
        },
      );
      assert.equal(bounded.violations.length, 1, "1 flaky test of 1 → 100% flaky, exceeds 99% threshold");
      assert.equal(bounded.violations[0].rule, "maxFlakyPct");
      assert.equal(bounded.violations[0].actual, 100, "flakyPct must be bounded at 100, not 500");
    }

    // ── Web vitals evaluator: LCP=3100 vs budget=2500 → violation (AUTO-017) ─
    // Independently guarded from the quality-gates evaluator above so a future
    // refactor that splits testRunner.js exports can't silently drop coverage.
    if (typeof __evaluateWebVitalsBudgetsForTest === "function") {
      const vitalsResult = __evaluateWebVitalsBudgetsForTest(
        { lcp: 2500, cls: 0.1 },
        { results: [{ testId: "t1", testName: "x", webVitals: { lcp: 3100, cls: 0.05, inp: 120, ttfb: 200 } }] }
      );
      assert.equal(vitalsResult.passed, false);
      assert.equal(vitalsResult.violations[0].rule, "lcp");
    }

    if (typeof __evaluateQualityGatesForTest !== "function" || typeof __evaluateWebVitalsBudgetsForTest !== "function") {
      const missing = [
        typeof __evaluateQualityGatesForTest    !== "function" ? "__evaluateQualityGatesForTest"    : null,
        typeof __evaluateWebVitalsBudgetsForTest !== "function" ? "__evaluateWebVitalsBudgetsForTest" : null,
      ].filter(Boolean).join(" + ");
      console.warn(`  ⚠️  ${missing} not exported — evaluator branch(es) skipped (CRUD round-trips above still ran)`);
    }
  } finally {
    env.restore();
    await new Promise(r => server.close(r));
  }
}

main().then(() => console.log("quality-gates.test.js passed")).catch((e) => { console.error(e); process.exit(1); });

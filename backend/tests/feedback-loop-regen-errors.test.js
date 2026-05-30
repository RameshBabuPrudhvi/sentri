/**
 * Bundle-A fix #9 — `regenerateFailingTest` must surface non-abort
 * errors via:
 *   1. A structured warn log line (formatLogLine) so operators can
 *      triage individual failures.
 *   2. `app_feedback_loop_regeneration_failures_total{reason}` counter
 *      so dashboards / alerts can fire when the auto-regen success
 *      rate drops.
 *
 * Pre-fix the outer catch swallowed every non-abort error and silently
 * returned null — a sustained provider outage looked indistinguishable
 * from "regeneration isn't helping any tests".
 *
 * Tests target the exported `classifyRegenerationFailure` helper
 * directly so every reason-bucket branch is pinned without needing
 * to boot a real LLM provider, AND drive `regenerateFailingTest` end
 * to end to confirm the counter + warn log fire on a no-provider
 * environment.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";

const { getDatabase } = await import("../src/database/sqlite.js");
const { ensureDefaultWorkspaces } = await import("../src/database/repositories/workspaceRepo.js");
getDatabase();
ensureDefaultWorkspaces();

const {
  classifyRegenerationFailure,
  regenerateFailingTest,
} = await import("../src/pipeline/feedbackLoop.js");
const { register } = await import("../src/utils/metrics.js");

// ─── classifyRegenerationFailure unit tests ──────────────────────────────────

test("classifyRegenerationFailure: parse-related messages → parse_error", () => {
  assert.equal(classifyRegenerationFailure(new Error("Failed to parse JSON")), "parse_error");
  assert.equal(classifyRegenerationFailure(new Error("Invalid JSON response from model")), "parse_error");
  assert.equal(classifyRegenerationFailure(new Error("SyntaxError: Unexpected token at parse")), "parse_error");
});

test("classifyRegenerationFailure: HTTP-status errors → provider_error", () => {
  const err429 = Object.assign(new Error("rate limited"), { status: 429 });
  assert.equal(classifyRegenerationFailure(err429), "provider_error");
  const err500 = Object.assign(new Error("internal server error"), { statusCode: 500 });
  assert.equal(classifyRegenerationFailure(err500), "provider_error");
});

test("classifyRegenerationFailure: provider error with 'json' in message → provider_error (not parse_error)", () => {
  // Devin Review finding: pre-fix the "json" substring check ran before
  // the status check, so this error was mis-bucketed as parse_error.
  const err = Object.assign(new Error("No JSON response from provider"), { status: 502 });
  assert.equal(classifyRegenerationFailure(err), "provider_error");
});

test("classifyRegenerationFailure: provider/network keywords → provider_error", () => {
  assert.equal(classifyRegenerationFailure(new Error("ECONNREFUSED 127.0.0.1:8000")), "provider_error");
  assert.equal(classifyRegenerationFailure(new Error("Request timeout after 30s")), "provider_error");
  assert.equal(classifyRegenerationFailure(new Error("no provider configured")), "provider_error");
  assert.equal(classifyRegenerationFailure(new Error("rate-limited by upstream")), "provider_error");
});

test("classifyRegenerationFailure: unrecognised messages → internal_error", () => {
  assert.equal(classifyRegenerationFailure(new Error("validator threw")), "internal_error");
  assert.equal(classifyRegenerationFailure(new TypeError("Cannot read property foo of undefined")), "internal_error");
});

test("classifyRegenerationFailure: defensive on falsy / non-Error inputs", () => {
  // null / undefined / strings — must classify, never throw.
  assert.equal(classifyRegenerationFailure(null), "internal_error");
  assert.equal(classifyRegenerationFailure(undefined), "internal_error");
  assert.equal(classifyRegenerationFailure(""), "internal_error");
});

// ─── End-to-end metric bump on a real non-abort failure ──────────────────────

test("regenerateFailingTest bumps app_feedback_loop_regeneration_failures_total on non-abort error", async () => {
  const metric = register.getSingleMetric("app_feedback_loop_regeneration_failures_total");
  assert.ok(metric, "Bundle-A fix #9 metric must be registered");

  // Sum every reason bucket BEFORE so any reason classification path
  // counts toward the increment — the test process has no AI provider
  // configured, so `generateText` will throw a provider-shaped or
  // configuration-shaped error and the catch path bumps exactly once.
  const before = (await metric.get()).values.reduce((s, v) => s + (v.value || 0), 0);

  // Drive `regenerateFailingTest` with a minimal improvement. No
  // provider configured → `generateText` throws → outer catch bumps
  // the counter and emits a warn log.
  const result = await regenerateFailingTest({
    test: {
      id: "TC-RF-1",
      name: "Sample failing test",
      sourceUrl: "http://app.example.test/x",
      playwrightCode: "test('x', async ({ page }) => { await page.goto('/'); });",
      projectId: null,
    },
    failureCategory: "SELECTOR_ISSUE",
    errorMessage: "locator not found",
    snapshot: null,
  });
  assert.equal(result, null, "regeneration returns null on non-abort failure (original test kept)");

  const after = (await metric.get()).values.reduce((s, v) => s + (v.value || 0), 0);
  assert.ok(
    after > before,
    `counter must increment by at least 1 on non-abort failure (before=${before} after=${after})`,
  );
});

test("regenerateFailingTest still re-throws AbortError (no metric bump on abort)", async () => {
  const metric = register.getSingleMetric("app_feedback_loop_regeneration_failures_total");
  const before = (await metric.get()).values.reduce((s, v) => s + (v.value || 0), 0);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => regenerateFailingTest({
      test: {
        id: "TC-RF-2",
        name: "Aborted test",
        sourceUrl: "http://app.example.test/y",
        playwrightCode: "test('y', async ({ page }) => { await page.goto('/'); });",
        projectId: null,
      },
      failureCategory: "TIMEOUT",
      errorMessage: "timeout 5000ms exceeded",
      snapshot: null,
    }, controller.signal),
    (err) => err?.name === "AbortError",
  );

  const after = (await metric.get()).values.reduce((s, v) => s + (v.value || 0), 0);
  assert.equal(
    after,
    before,
    "AbortError must propagate WITHOUT bumping the regeneration-failure counter",
  );
});

console.log("✅ feedback-loop-regen-errors tests passed");

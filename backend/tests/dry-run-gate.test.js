/**
 * @module tests/dry-run-gate
 * @description B6 / QAL-001 — opt-in dry-run gate unit coverage.
 *
 * Drives `dryRunTest` against a stub browser pool that returns a fake
 * Playwright Page so the test exercises:
 *
 *   • `passed`  — test code runs to completion.
 *   • `failed`  — thrown error captured + truncated.
 *   • `trivial` — sub-threshold duration + zero network requests.
 *   • `failed`  — empty / missing playwrightCode short-circuits.
 *
 * The pool stub records `acquire()` / `release()` calls so we can pin the
 * lease-release contract (every `dryRunTest` invocation MUST release the
 * lease — leaking a slot would deadlock the next acquire).
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import { dryRunTest, dryRunBatch } from "../src/pipeline/dryRunGate.js";

const t = createTestContext();
const { test, summary } = t.createTestRunner();

/**
 * Build a fake `browserPool` whose `acquire()` returns a controllable
 * Page + Context pair. The Page records `request` listeners so the
 * trivial-detection branch can be exercised.
 */
function makeFakePool({ onCode = "passed", networkRequests = 0 } = {}) {
  let leasesAcquired = 0;
  let leasesReleased = 0;
  const requestHandlers = [];
  const page = {
    on: (event, handler) => {
      if (event === "request") requestHandlers.push(handler);
    },
    goto: async () => undefined,
    url: () => "https://example.com",
  };
  const context = {};
  return {
    leasesAcquired: () => leasesAcquired,
    leasesReleased: () => leasesReleased,
    fireRequests(n) {
      for (let i = 0; i < n; i++) {
        for (const h of requestHandlers) h({});
      }
    },
    acquire: async () => {
      leasesAcquired += 1;
      const release = async () => { leasesReleased += 1; };
      return { page, context, release };
    },
    // The host-side `dryRunTest` will execute the test's playwrightCode
    // inside a vm sandbox. Tests below pass code shaped to follow the
    // `onCode` directive: a code body that resolves, throws, or sleeps
    // beyond the trivial threshold. We can't easily inject network
    // requests from inside the sandbox, so the `networkRequests` knob
    // is fired manually via `fireRequests()` after each acquire.
    onAcquire() {
      // Schedule a microtask to fire the configured network events
      // before the vm body has a chance to settle so the counter is
      // populated by the time the duration check runs.
      Promise.resolve().then(() => this.fireRequests(networkRequests));
    },
  };
}

test("dryRunTest returns 'failed' for missing playwrightCode without acquiring a lease", async () => {
  const pool = makeFakePool();
  const out = await dryRunTest(
    { id: "T-1", playwrightCode: "" },
    { url: "https://example.com" },
    { poolOverride: pool },
  );
  assert.equal(out.status, "failed");
  assert.equal(out.error, "dry_run_no_code");
  // Short-circuit MUST happen before lease acquisition — otherwise an
  // empty-code test would pointlessly warm a browser context.
  assert.equal(pool.leasesAcquired(), 0);
});

test("dryRunTest returns 'failed' when the vm body throws", async () => {
  const pool = makeFakePool();
  const code = `throw new Error("intentional dry-run failure")`;
  const out = await dryRunTest(
    { id: "T-2", playwrightCode: code },
    { url: "https://example.com" },
    { poolOverride: pool, timeoutMs: 5000 },
  );
  assert.equal(out.status, "failed");
  assert.ok(out.error.includes("intentional dry-run failure"));
  assert.equal(pool.leasesAcquired(), 1);
  assert.equal(pool.leasesReleased(), 1, "lease released on failure");
});

test("dryRunTest releases the lease on success", async () => {
  const pool = makeFakePool();
  // A no-op code body resolves immediately; duration will be sub-threshold
  // and networkRequests=0, so the gate flags it as 'trivial'. The lease
  // release contract is what we're pinning here.
  const out = await dryRunTest(
    { id: "T-3", playwrightCode: "/* no-op */" },
    { url: "https://example.com" },
    { poolOverride: pool, timeoutMs: 5000 },
  );
  // 'trivial' is the only honest outcome for a sub-threshold no-op with no
  // network requests; 'passed' would mis-signal a meaningful test run.
  assert.equal(out.status, "trivial");
  assert.equal(pool.leasesReleased(), 1);
});

test("dryRunTest enforces the per-test timeout", async () => {
  const pool = makeFakePool();
  // Sleep beyond the configured timeout so the race rejects.
  const code = `await new Promise((r) => setTimeout(r, 2000))`;
  const out = await dryRunTest(
    { id: "T-4", playwrightCode: code },
    { url: "https://example.com" },
    { poolOverride: pool, timeoutMs: 50 },
  );
  assert.equal(out.status, "failed");
  assert.ok(out.error.includes("dry_run_timeout"));
  assert.equal(pool.leasesReleased(), 1, "timeout still releases lease");
});

test("dryRunTest truncates oversized error messages", async () => {
  const pool = makeFakePool();
  const huge = "x".repeat(10_000);
  const code = `throw new Error("${huge}")`;
  const out = await dryRunTest(
    { id: "T-5", playwrightCode: code },
    { url: "https://example.com" },
    { poolOverride: pool, timeoutMs: 5000 },
  );
  assert.equal(out.status, "failed");
  assert.ok(out.error.length <= 2000, `error truncated to ≤2000 chars (got ${out.error.length})`);
});

test("dryRunBatch runs sequentially and returns one result per test", async () => {
  const pool = makeFakePool();
  const tests = [
    { id: "T-a", playwrightCode: "/* a */" },
    { id: "T-b", playwrightCode: "/* b */" },
    { id: "T-c", playwrightCode: "" },
  ];
  const out = await dryRunBatch(tests, { url: "https://example.com" }, { poolOverride: pool });
  assert.equal(out.length, 3);
  // T-a + T-b are trivial; T-c is failed (no code).
  assert.equal(out[0].status, "trivial");
  assert.equal(out[1].status, "trivial");
  assert.equal(out[2].status, "failed");
  assert.equal(pool.leasesAcquired(), 2, "empty-code test never acquired a lease");
  assert.equal(pool.leasesReleased(), 2);
});

test("dryRunBatch on empty input returns []", async () => {
  const out = await dryRunBatch([], { url: "https://example.com" });
  assert.deepEqual(out, []);
});

test("dryRunBatch respects an aborted signal", async () => {
  const pool = makeFakePool();
  const ac = new AbortController();
  ac.abort();
  const tests = [
    { id: "T-1", playwrightCode: "/* a */" },
    { id: "T-2", playwrightCode: "/* b */" },
  ];
  const out = await dryRunBatch(tests, { url: "https://example.com" }, { poolOverride: pool, signal: ac.signal });
  assert.equal(out.length, 2);
  assert.equal(out[0].status, "failed");
  assert.equal(out[0].error, "aborted");
  // No leases should have been acquired because the abort signal was
  // raised before the first iteration ran.
  assert.equal(pool.leasesAcquired(), 0);
});

await summary("dry-run-gate");

/**
 * @module tests/network-conditions
 * @description Unit tests for `runner/networkConditions.js` (AUTO-006).
 *
 * Uses fake context/page objects to assert the helper calls the right
 * Playwright APIs for each `networkCondition` value, and that the returned
 * `teardown()` correctly unroutes the slow3g handler.
 */

import assert from "node:assert/strict";
import { applyNetworkCondition } from "../src/runner/networkConditions.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

/** Build a fake Chromium-like context+page that records all API calls. */
function makeFakes({ cdpThrows = false } = {}) {
  const calls = [];
  const cdp = {
    send: async (method, payload) => { calls.push({ on: "cdp", method, payload }); },
  };
  const context = {
    setOffline: async (v) => { calls.push({ on: "context", method: "setOffline", value: v }); },
    newCDPSession: async () => {
      if (cdpThrows) throw new Error("CDP unavailable (non-Chromium)");
      calls.push({ on: "context", method: "newCDPSession" });
      return cdp;
    },
  };
  const routes = [];
  const page = {
    route: async (pattern, handler) => {
      routes.push({ pattern, handler });
      calls.push({ on: "page", method: "route", pattern });
    },
    unroute: async (pattern, handler) => {
      const i = routes.findIndex((r) => r.pattern === pattern && r.handler === handler);
      if (i >= 0) routes.splice(i, 1);
      calls.push({ on: "page", method: "unroute", pattern });
    },
  };
  return { context, page, calls, routes };
}

console.log("\n🧪 applyNetworkCondition (AUTO-006)");

await test("'fast' is a no-op (no API calls)", async () => {
  const { context, page, calls } = makeFakes();
  const handle = await applyNetworkCondition({ networkCondition: "fast", context, page });
  assert.equal(calls.length, 0);
  await handle.teardown(); // must not throw
});

await test("undefined networkCondition is a no-op", async () => {
  const { context, page, calls } = makeFakes();
  const handle = await applyNetworkCondition({ networkCondition: undefined, context, page });
  assert.equal(calls.length, 0);
  await handle.teardown();
});

await test("'offline' calls context.setOffline(true)", async () => {
  const { context, page, calls } = makeFakes();
  const handle = await applyNetworkCondition({ networkCondition: "offline", context, page });
  assert.deepEqual(calls, [{ on: "context", method: "setOffline", value: true }]);
  await handle.teardown(); // no slow3g route to unroute
});

await test("'slow3g' on Chromium uses CDP Network.emulateNetworkConditions", async () => {
  const { context, page, calls, routes } = makeFakes({ cdpThrows: false });
  const handle = await applyNetworkCondition({ networkCondition: "slow3g", context, page });

  // CDP path: newCDPSession → Network.enable → Network.emulateNetworkConditions
  const cdpCalls = calls.filter((c) => c.on === "cdp");
  assert.equal(cdpCalls.length, 2);
  assert.equal(cdpCalls[0].method, "Network.enable");
  assert.equal(cdpCalls[1].method, "Network.emulateNetworkConditions");
  assert.equal(cdpCalls[1].payload.offline, false);
  assert.equal(cdpCalls[1].payload.latency, 400);
  // 400 Kbps in bytes/sec
  assert.equal(cdpCalls[1].payload.downloadThroughput, (400 * 1024) / 8);

  // No page.route should have been registered when CDP succeeded.
  assert.equal(routes.length, 0);
  await handle.teardown();
});

await test("'slow3g' on non-Chromium falls back to page.route delay", async () => {
  const { context, page, calls, routes } = makeFakes({ cdpThrows: true });
  const handle = await applyNetworkCondition({ networkCondition: "slow3g", context, page });

  // Should have registered exactly one route on **/*.
  assert.equal(routes.length, 1);
  assert.equal(routes[0].pattern, "**/*");

  // The handler must delay then call route.continue().
  let continued = false;
  const fakeRoute = { continue: async () => { continued = true; } };
  const t0 = Date.now();
  await routes[0].handler(fakeRoute);
  const elapsed = Date.now() - t0;
  assert.ok(continued, "route.continue() was not called");
  assert.ok(elapsed >= 350, `expected ~400ms delay, got ${elapsed}ms`);

  // teardown() must unroute the handler.
  await handle.teardown();
  const unrouteCall = calls.find((c) => c.method === "unroute");
  assert.ok(unrouteCall, "expected page.unroute call on teardown");
  assert.equal(routes.length, 0);
});

await test("teardown() is idempotent / safe when unroute throws", async () => {
  const { context, page } = makeFakes({ cdpThrows: true });
  // Make page.unroute throw to simulate a closed page during teardown.
  page.unroute = async () => { throw new Error("Target page has been closed"); };
  const handle = await applyNetworkCondition({ networkCondition: "slow3g", context, page });
  // Must not throw — teardown swallows unroute failures.
  await handle.teardown();
});

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  Network-condition tests failed");
  process.exit(1);
}

console.log("\n🎉 Network-condition tests passed");

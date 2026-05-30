/**
 * @module tests/browser-pool
 * @description Unit coverage for the MNT-015 warm BrowserPool.
 */

import assert from "node:assert/strict";
import { BrowserPool } from "../src/runner/browserPool.js";

function createFakeLauncher() {
  let launches = 0;
  const contexts = [];
  const browsers = [];
  return {
    get launches() { return launches; },
    contexts,
    browsers,
    async launch() {
      launches += 1;
      const listeners = new Map();
      const browser = {
        closed: false,
        isConnected: () => !browser.closed,
        on(event, fn) {
          const arr = listeners.get(event) || [];
          arr.push(fn);
          listeners.set(event, arr);
        },
        emit(event, ...args) {
          for (const fn of listeners.get(event) || []) fn(...args);
        },
        async newContext(options) {
          const pages = [];
          const context = {
            options,
            closed: false,
            pages: () => pages,
            async newPage() {
              const page = { closed: false, async close() { this.closed = true; } };
              pages.push(page);
              return page;
            },
            async close() {
              this.closed = true;
              for (const page of pages) page.closed = true;
            },
          };
          contexts.push(context);
          return context;
        },
        async close() {
          browser.closed = true;
          browser.emit("disconnected");
        },
      };
      browsers.push(browser);
      return browser;
    },
  };
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function run(name, fn) {
    try { await fn(); passed++; console.log(`  ✅  ${name}`); }
    catch (err) { failed++; console.log(`  ❌  ${name}\n      ${err.stack || err.message}`); }
  }

  await run("reuses the browser process while isolating contexts", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 2, launcher: fake.launch });
    const first = await pool.acquire({ browserType: "chromium", contextOptions: { locale: "en-US" } });
    await first.release();
    const second = await pool.acquire({ browserType: "chromium", contextOptions: { locale: "en-US" } });
    assert.equal(fake.launches, 1);
    assert.equal(fake.contexts.length, 2);
    assert.notEqual(second.context, first.context);
    assert.equal(first.context.closed, true);
    await second.release();
    await pool.drainAndClose();
  });

  await run("ten sequential acquisitions launch one browser", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 3, launcher: fake.launch });
    for (let i = 0; i < 10; i += 1) {
      const lease = await pool.acquire({ browserType: "chromium", contextOptions: { viewport: { width: 1280, height: 720 } } });
      await lease.release();
    }
    assert.equal(fake.launches, 1);
    assert.equal(fake.launches <= 3, true);
    await pool.drainAndClose();
  });

  await run("waits FIFO when pool is full", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 1, launcher: fake.launch });
    const first = await pool.acquire({ browserType: "chromium" });
    const order = [];
    const secondPromise = pool.acquire({ browserType: "chromium" }).then((lease) => { order.push("second"); return lease; });
    const thirdPromise = pool.acquire({ browserType: "chromium" }).then((lease) => { order.push("third"); return lease; });
    assert.equal(pool.getStats()[0].queued, 2);
    await first.release();
    const second = await secondPromise;
    assert.deepEqual(order, ["second"]);
    await second.release();
    const third = await thirdPromise;
    assert.deepEqual(order, ["second", "third"]);
    await third.release();
    await pool.drainAndClose();
  });

  await run("passes viewport and locale options to fresh contexts", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 2, launcher: fake.launch });
    const en = await pool.acquire({ browserType: "chromium", contextOptions: { locale: "en-US", viewport: { width: 800, height: 600 } } });
    const it = await pool.acquire({ browserType: "chromium", contextOptions: { locale: "it-IT", viewport: { width: 390, height: 844 } } });
    assert.deepEqual(en.context.options.viewport, { width: 800, height: 600 });
    assert.equal(it.context.options.locale, "it-IT");
    assert.equal(pool.getStats()[0].inUse, 2);
    await en.release();
    await it.release();
    await pool.drainAndClose();
  });

  await run("evicts the browser on disconnected and relaunches on next acquire", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 2, launcher: fake.launch });
    const first = await pool.acquire({ browserType: "chromium" });
    await first.release();
    // Simulate an unexpected Chromium crash / CDP socket drop.
    fake.browsers[0].closed = true;
    fake.browsers[0].emit("disconnected");
    const second = await pool.acquire({ browserType: "chromium" });
    assert.equal(fake.launches, 2);
    assert.notEqual(fake.browsers[1], fake.browsers[0]);
    await second.release();
    await pool.drainAndClose();
  });

  await run("drain closes active contexts and browser", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 1, launcher: fake.launch });
    const lease = await pool.acquire({ browserType: "chromium" });
    await pool.drainAndClose();
    assert.equal(lease.context.closed, true);
    assert.equal(fake.browsers[0].closed, true);
    assert.equal(pool.getStats().length, 0);
  });

  await run("post-drain acquire rejects so SIGTERM cannot leak a zombie browser", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 1, launcher: fake.launch });
    await pool.drainAndClose();
    await assert.rejects(
      () => pool.acquire({ browserType: "chromium" }),
      /draining/i,
    );
    await assert.rejects(
      () => pool.acquireSharedBrowser("chromium"),
      /draining/i,
    );
    assert.equal(fake.launches, 0);
  });

  await run("isBrowserConnected reflects the cached browser's real state", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 1, launcher: fake.launch });
    // Pre-launch: report connected so callers' first acquire isn't blocked.
    assert.equal(pool.isBrowserConnected("chromium"), true);
    const lease = await pool.acquire({ browserType: "chromium" });
    assert.equal(pool.isBrowserConnected("chromium"), true);
    // Simulate a Chromium crash + disconnect after acquire.
    fake.browsers[0].closed = true;
    fake.browsers[0].emit("disconnected");
    assert.equal(pool.isBrowserConnected("chromium"), true); // bucket evicted, treated as pre-launch
    await lease.release();
    await pool.drainAndClose();
  });

  await run("acquireSharedBrowser does not occupy a pool slot (deadlock fix)", async () => {
    const fake = createFakeLauncher();
    // Pool sized to 1 reproduces the testRunner.js trace-context deadlock
    // when the trace lease was routed through `acquire()`. With
    // `acquireSharedBrowser` the trace context shares the warm browser
    // without consuming a slot, so per-test acquires still proceed.
    const pool = new BrowserPool({ size: 1, launcher: fake.launch });
    const sharedBrowser = await pool.acquireSharedBrowser("chromium");
    const sharedContext = await sharedBrowser.newContext({});
    assert.equal(pool.getStats()[0].inUse, 0);
    const testLease = await pool.acquire({ browserType: "chromium" });
    assert.equal(pool.getStats()[0].inUse, 1);
    assert.equal(fake.launches, 1);
    await testLease.release();
    await sharedContext.close();
    await pool.drainAndClose();
  });

  if (failed) process.exit(1);
  console.log(`browser-pool.test.js: ${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });

/**
 * @module runner/browserPool
 * @description Warm Playwright browser-process pool for isolated test contexts.
 */

import { DEFAULT_PARALLEL_WORKERS, launchBrowser, resolveBrowser } from "./config.js";
import {
  browserPoolAcquiresTotal,
  browserPoolAcquireWaitSeconds,
  browserPoolDisconnectsTotal,
  browserPoolInUse,
  browserPoolSize,
} from "../utils/metrics.js";
import { formatLogLine } from "../utils/logFormatter.js";

// MAX_WORKERS governs BullMQ run-job concurrency (per-replica). PARALLEL_WORKERS
// governs concurrent browser contexts inside ONE run (1–10). The pool must
// have enough warm slots to serve the *larger* of the two so a single
// parallel run on a quiet queue doesn't queue every test behind a tiny pool.
// `BROWSER_POOL_SIZE` is the explicit operator override.
function parsePoolSize() {
  const raw = process.env.BROWSER_POOL_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed)) return Math.max(1, Math.min(50, parsed));
  const maxWorkers = Number.parseInt(process.env.MAX_WORKERS, 10);
  const workerConcurrency = Number.parseInt(process.env.WORKER_CONCURRENCY, 10);
  const derived = Math.max(
    DEFAULT_PARALLEL_WORKERS,
    Number.isFinite(maxWorkers) ? maxWorkers : 0,
    Number.isFinite(workerConcurrency) ? workerConcurrency : 0,
    2,
  );
  return Math.max(1, Math.min(50, derived));
}

function normaliseContextOptions({ contextOptions = {}, viewport, locale, timezone } = {}) {
  return {
    ...contextOptions,
    ...(viewport ? { viewport } : {}),
    ...(locale ? { locale } : {}),
    ...(timezone ? { timezoneId: timezone } : {}),
  };
}

/**
 * @typedef {Object} BrowserPoolLease
 * @property {Object} context - Checked-out Playwright BrowserContext.
 * @property {Object|null} page - Fresh page created inside the context unless disabled by caller.
 * @property {Function} release - Idempotent function returning the slot to the pool.
 */

/**
 * Maintains bounded warm browser processes while giving every test a fresh context.
 *
 * Reusing a BrowserContext leaks storage state (localStorage / IndexedDB) across
 * customer tests, and Playwright video/tracing options are context-scoped. The
 * pool therefore keeps the expensive browser process warm and caps concurrent
 * contexts per browser type, but closes each context on release for isolation.
 */
export class BrowserPool {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.size]
   * @param {Function} [opts.launcher]
   */
  constructor(opts = {}) {
    this.size = Math.max(1, Number.parseInt(opts.size, 10) || parsePoolSize());
    this.launcher = opts.launcher || launchBrowser;
    this.buckets = new Map();
    this.draining = false;
  }

  _getBucket(browserType) {
    const { name } = resolveBrowser(browserType);
    if (!this.buckets.has(name)) {
      this.buckets.set(name, {
        type: name,
        browser: null,
        launching: null,
        inUse: 0,
        waiters: [],
        contexts: new Set(),
      });
      browserPoolSize.set({ type: name }, this.size);
      browserPoolInUse.set({ type: name }, 0);
    }
    return this.buckets.get(name);
  }

  async _ensureBrowser(bucket) {
    if (bucket.browser && (!bucket.browser.isConnected || bucket.browser.isConnected())) return { browser: bucket.browser, launched: false };
    if (!bucket.launching) {
      bucket.launching = this.launcher({ browser: bucket.type })
        .then((browser) => {
          bucket.browser = browser;
          // Eagerly evict the cached browser on `disconnected` so the next
          // `acquire()` re-launches instead of handing out a dead handle.
          // Without this hook the only check is `isConnected()` at acquire
          // time — a disconnect mid-test (Chromium OOM kill, CDP socket
          // hang-up) would surface only at the next acquire, AFTER N more
          // tests had already tried to lease a dead browser. Best-effort:
          // browsers without an `.on()` (test doubles, future Playwright
          // shape change) skip the wire-up.
          if (typeof browser.on === "function") {
            browser.on("disconnected", () => {
              if (bucket.browser === browser) {
                browserPoolDisconnectsTotal.inc({ type: bucket.type });
                console.warn(formatLogLine("warn", null,
                  `[browserPool] ${bucket.type} disconnected — evicting from pool, next acquire will relaunch`));
                bucket.browser = null;
              }
            });
          }
          return browser;
        })
        .finally(() => { bucket.launching = null; });
    }
    return { browser: await bucket.launching, launched: true };
  }

  async _createLease(bucket, args = {}, opts = {}) {
    bucket.inUse += 1;
    browserPoolInUse.set({ type: bucket.type }, bucket.inUse);
    let context = null;
    try {
      const { browser, launched } = await this._ensureBrowser(bucket);
      // Skip the hit/miss bump when this lease was triggered by a queued
      // waiter — `acquire()` already counted it as `outcome: "queue"`. Without
      // this guard every queued acquire double-counts the total counter
      // (once as `queue` at queue-time, once as `hit`/`miss` at wake-time),
      // inflating throughput dashboards and corrupting the hit/miss/queue
      // ratio operators rely on for capacity planning.
      if (!opts.fromWaiter) {
        browserPoolAcquiresTotal.inc({ type: bucket.type, outcome: launched ? "miss" : "hit" });
      }
      context = await browser.newContext(normaliseContextOptions(args));
      bucket.contexts.add(context);
      const page = args.createPage === false ? null : await context.newPage();
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await this._release(bucket, context);
      };
      context.__sentriPoolRelease = release;
      context.__sentriPooled = true;
      return { context, page, release };
    } catch (err) {
      if (context) await context.close?.().catch(() => {});
      bucket.inUse = Math.max(0, bucket.inUse - 1);
      browserPoolInUse.set({ type: bucket.type }, bucket.inUse);
      this._wakeNext(bucket);
      throw err;
    }
  }

  _wakeNext(bucket) {
    if (this.draining || bucket.waiters.length === 0 || bucket.inUse >= this.size) return;
    const waiter = bucket.waiters.shift();
    // `fromWaiter: true` so `_createLease` skips the inner hit/miss bump —
    // `acquire()` already counted this request as `outcome: "queue"`.
    this._createLease(bucket, waiter.args, { fromWaiter: true }).then(waiter.resolve, waiter.reject);
  }

  /**
   * Acquire an isolated context, waiting FIFO when all slots for the browser are busy.
   *
   * @param {Object} [args]
   * @param {string} [args.browserType]
   * @param {Object} [args.contextOptions]
   * @param {Object} [args.viewport]
   * @param {string} [args.locale]
   * @param {string} [args.timezone]
   * @param {boolean} [args.createPage]
   * @returns {Promise<BrowserPoolLease>}
   */
  async acquire(args = {}) {
    if (this.draining) throw new Error("Browser pool is draining");
    const bucket = this._getBucket(args.browserType);
    const startNs = process.hrtime.bigint();
    if (bucket.inUse < this.size) {
      const lease = await this._createLease(bucket, args);
      const elapsed = Number(process.hrtime.bigint() - startNs) / 1e9;
      // Distinguish hit (browser already warm) vs miss (cold launch). The
      // counter inside `_createLease` is the canonical hit/miss source;
      // we infer from `inUse` here because the lease shape doesn't carry
      // the flag. Cheap proxy: a wait of <50 ms is effectively a hit.
      browserPoolAcquireWaitSeconds.observe(
        { type: bucket.type, outcome: elapsed < 0.05 ? "hit" : "miss" },
        elapsed,
      );
      return lease;
    }
    browserPoolAcquiresTotal.inc({ type: bucket.type, outcome: "queue" });
    return new Promise((resolve, reject) => {
      bucket.waiters.push({
        args,
        resolve: (lease) => {
          const elapsed = Number(process.hrtime.bigint() - startNs) / 1e9;
          browserPoolAcquireWaitSeconds.observe({ type: bucket.type, outcome: "queue" }, elapsed);
          resolve(lease);
        },
        reject,
      });
    });
  }

  async _release(bucket, context) {
    bucket.contexts.delete(context);
    try { await context.close?.(); } catch { /* best-effort */ }
    bucket.inUse = Math.max(0, bucket.inUse - 1);
    browserPoolInUse.set({ type: bucket.type }, bucket.inUse);
    this._wakeNext(bucket);
  }

  /**
   * Acquire the warm browser for this type WITHOUT consuming a pool slot.
   *
   * Long-lived contexts (e.g. the per-run shared tracing context in
   * `testRunner.js`) need to share the warm browser process but must not
   * occupy a slot for the entire run — that would silently reduce effective
   * test parallelism by 1, and outright deadlock the run when the pool size
   * is 1 (every per-test `acquire()` queues forever waiting for the trace
   * context to release). Callers are responsible for closing the resulting
   * context themselves; the pool only owns the underlying browser process.
   *
   * @param {string} [browserType]
   * @returns {Promise<Object>} Playwright Browser
   */
  async acquireSharedBrowser(browserType) {
    if (this.draining) throw new Error("Browser pool is draining");
    const bucket = this._getBucket(browserType);
    const { browser } = await this._ensureBrowser(bucket);
    return browser;
  }

  /**
   * Read-only `isConnected()` probe for the cached warm browser of a type.
   *
   * Returns `true` when no browser has been launched for this type yet
   * (so callers' health probes treat "pre-launch" as connected and let
   * the first `acquire()` surface launch errors via its own path).
   * Returns the underlying `browser.isConnected()` once a warm handle
   * is cached so callers see a real disconnect (Chromium OOM kill,
   * CDP socket drop) before paying the `newContext()` round-trip.
   *
   * @param {string} [browserType]
   * @returns {boolean}
   */
  isBrowserConnected(browserType) {
    try {
      const { name } = resolveBrowser(browserType);
      const bucket = this.buckets.get(name);
      if (!bucket || !bucket.browser) return true;
      return typeof bucket.browser.isConnected === "function" ? bucket.browser.isConnected() : true;
    } catch {
      return true;
    }
  }

  /**
   * Close all active contexts/browsers and reject queued waiters.
   *
   * After drain the pool is permanently sealed for this process — subsequent
   * `acquire()` calls throw rather than launching a fresh browser the
   * shutdown sequence has no way to clean up. Tests that exercise drain+
   * reuse construct a new `BrowserPool` instance.
   *
   * @returns {Promise<void>}
   */
  async drainAndClose() {
    this.draining = true;
    const closes = [];
    for (const bucket of this.buckets.values()) {
      while (bucket.waiters.length > 0) bucket.waiters.shift().reject(new Error("Browser pool drained"));
      for (const context of bucket.contexts) closes.push(context.close?.().catch(() => {}));
      bucket.contexts.clear();
      if (bucket.browser) closes.push(bucket.browser.close?.().catch(() => {}));
      bucket.browser = null;
      bucket.inUse = 0;
      browserPoolInUse.set({ type: bucket.type }, 0);
    }
    await Promise.allSettled(closes);
    this.buckets.clear();
    // NOTE: deliberately keep `draining = true` so post-shutdown acquires
    // reject loudly. Resetting to false here would silently re-arm the
    // pool and let an in-flight job leak a zombie Chromium past the
    // graceful-shutdown sequence.
  }

  /**
   * Return low-cardinality pool stats for telemetry and tests.
   *
   * @returns {Array<{type: string, size: number, inUse: number, active: number, queued: number}>}
   */
  getStats() {
    return [...this.buckets.values()].map((bucket) => ({
      type: bucket.type,
      size: this.size,
      inUse: bucket.inUse,
      active: bucket.contexts.size,
      queued: bucket.waiters.length,
    }));
  }
}

export const browserPool = new BrowserPool();

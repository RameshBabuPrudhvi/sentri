/**
 * @module utils/metrics
 * @description INF-007 — Prometheus metrics registry and custom counters.
 *
 * Extracted from `middleware/appSetup.js` so call-sites (testRunner, crawler,
 * runRepo) can import the counters without pulling Express + Helmet + the
 * entire request-pipeline graph through their dependency tree.
 *
 * The registry is owned here; `appSetup.js` imports `register` to expose
 * `GET /metrics`. Default Node.js process metrics (heap, GC, event-loop lag,
 * file descriptors) are auto-collected via `prom-client.collectDefaultMetrics`.
 *
 * ### Naming convention
 * Counter names use a brand-neutral `app_` prefix per `docs/guide/rebranding.md`
 * — every product-name token in the codebase is a rebranding-surface item, and
 * Prometheus metric names baked into operator dashboards / alerts are
 * particularly painful to migrate after the fact. JS export identifiers
 * mirror the metric names (no product prefix) for the same reason.
 *
 * ### Custom counters
 * | Counter                    | Incremented at                                  |
 * |----------------------------|-------------------------------------------------|
 * | `app_runs_total`           | Every `runRepo.create()` call (all run types)   |
 * | `app_tests_executed_total` | Each result appended in `testRunner` / shard    |
 * | `app_crawl_pages_total`    | Each page persisted by `crawler.js`             |
 *
 * Counters are best-effort: `.inc()` is wrapped at call sites in `try/catch`
 * so a metric-registry hiccup never fails an actual run.
 */

import client from "prom-client";

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const runsTotal = new client.Counter({
  name: "app_runs_total",
  help: "Total run records created (all types: crawl, test_run, generate, record).",
  registers: [register],
});

export const testsExecutedTotal = new client.Counter({
  name: "app_tests_executed_total",
  help: "Total individual test executions completed (passed + failed; excludes skipped).",
  registers: [register],
});

export const crawlPagesTotal = new client.Counter({
  name: "app_crawl_pages_total",
  help: "Total pages discovered by the crawler across all crawl runs.",
  registers: [register],
});

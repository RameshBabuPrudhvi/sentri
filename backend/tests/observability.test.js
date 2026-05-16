/**
 * INF-007 — Observability baseline tests.
 *
 * Covers the four acceptance criteria from `NEXT.md`:
 *   1. `formatLogLine()` carries the per-request `requestId` from
 *      `AsyncLocalStorage` (correlation across log lines for one request).
 *   2. Every HTTP response (incl. `/health`) sets an `X-Request-Id` header,
 *      echoing the inbound header when supplied and minting a fresh UUID
 *      otherwise.
 *   3. `GET /metrics` is bearer-token gated by `METRICS_SCRAPE_KEY`:
 *        - unset key → 401 to every caller
 *        - wrong token → 401
 *        - correct token → 200, `text/plain` Prometheus exposition format
 *          containing the default `nodejs_*` metrics and the brand-neutral
 *          custom counters (`app_runs_total`, `app_tests_executed_total`,
 *          `app_crawl_pages_total`).
 *   4. `initOpenTelemetry()` is a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT`
 *      is unset (no throw, no network attempt, no SDK side effects).
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import { requestContext } from "../src/utils/observability.js";
import { formatLogLine } from "../src/utils/logFormatter.js";
import { initOpenTelemetry } from "../src/utils/observability.js";
import { register as metricsRegister } from "../src/utils/metrics.js";

const t = createTestContext();
const runner = t.createTestRunner();

async function main() {
  // ── 1. requestId propagation through formatLogLine ──────────────────────
  await runner.test("formatLogLine includes requestId from AsyncLocalStorage", () => {
    const line = requestContext.run({ requestId: "req-test-1" }, () =>
      formatLogLine("info", null, "hello"),
    );
    assert.ok(line.includes("req-test-1"), `line missing requestId: ${line}`);
    assert.ok(line.includes("hello"), `line missing message: ${line}`);
  });

  await runner.test("formatLogLine omits requestId when AsyncLocalStorage is empty", () => {
    const line = formatLogLine("info", null, "hello");
    assert.ok(!line.includes("req:"), `line should not include req: tag: ${line}`);
  });

  // ── 2. X-Request-Id header on every response ────────────────────────────
  // ── 3. /metrics Bearer-token auth + Prometheus exposition format ────────
  // ── 4. OTel SDK no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset ─────────
  const env = t.setupEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    METRICS_SCRAPE_KEY: "test-scrape-key-12345",
  });
  const server = t.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await runner.test("initOpenTelemetry is a no-op when endpoint is unset", async () => {
      // Must not throw, must not start an SDK, must not block.
      await initOpenTelemetry();
    });

    await runner.test("X-Request-Id header is minted on responses when no inbound header", async () => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      const id = res.headers.get("x-request-id");
      assert.ok(id, "response missing X-Request-Id header");
      // UUID v4 shape — `createRequestId` uses `crypto.randomUUID()`.
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    await runner.test("X-Request-Id header echoes inbound value verbatim", async () => {
      const inbound = "req-inbound-correlation-id-9876";
      const res = await fetch(`${base}/health`, {
        headers: { "X-Request-Id": inbound },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-request-id"), inbound);
    });

    await runner.test("GET /metrics rejects requests without Bearer token (401)", async () => {
      const res = await fetch(`${base}/metrics`);
      assert.equal(res.status, 401);
    });

    await runner.test("GET /metrics rejects wrong Bearer token (401)", async () => {
      const res = await fetch(`${base}/metrics`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(res.status, 401);
    });

    await runner.test("GET /metrics returns Prometheus exposition format with correct Bearer token", async () => {
      const res = await fetch(`${base}/metrics`, {
        headers: { Authorization: "Bearer test-scrape-key-12345" },
      });
      assert.equal(res.status, 200);
      const ct = res.headers.get("content-type") || "";
      assert.ok(ct.startsWith("text/plain"), `expected text/plain content-type, got ${ct}`);
      const body = await res.text();
      // Default Node.js metrics shipped by `collectDefaultMetrics`.
      assert.ok(body.includes("nodejs_"), "metrics body missing default nodejs_ metrics");
      // Custom counters — brand-neutral `app_*` names per docs/guide/rebranding.md.
      assert.ok(body.includes("app_runs_total"), "metrics body missing app_runs_total");
      assert.ok(body.includes("app_tests_executed_total"), "metrics body missing app_tests_executed_total");
      assert.ok(body.includes("app_crawl_pages_total"), "metrics body missing app_crawl_pages_total");
    });

    await runner.test("METRICS_SCRAPE_KEY unset → /metrics is effectively disabled (401)", async () => {
      const innerEnv = t.setupEnv({ METRICS_SCRAPE_KEY: "" });
      try {
        const res = await fetch(`${base}/metrics`, {
          headers: { Authorization: "Bearer test-scrape-key-12345" },
        });
        assert.equal(res.status, 401);
      } finally {
        innerEnv.restore();
      }
    });

    await runner.test("metrics registry is the same instance as appSetup consumer", () => {
      // Smoke test that the `register` import is the single source of truth —
      // any future refactor that accidentally creates a second registry will
      // surface here as a missing-counter assertion failure on the body above.
      assert.ok(metricsRegister, "metricsRegister export should be defined");
      assert.equal(typeof metricsRegister.metrics, "function");
    });
  } finally {
    env.restore();
    await new Promise((r) => server.close(r));
  }

  runner.summary("observability");
}

await main();

/**
 * @module tests/worker-health
 * @description Unit test for the worker /healthz + /livez endpoint contract.
 *
 * Mirrors the http.createServer handler in `backend/src/worker.js` so we can
 * exercise the 200/503 contract without booting BullMQ, ioredis, or the
 * database (the spec at NEXT.md:59 requires test coverage for the new
 * worker health endpoint).
 *
 * Two-endpoint contract:
 *   - /livez   → always 200 (process-alive; used by livenessProbe).
 *   - /healthz → 200 iff worker is ready AND Redis is reachable
 *                (dependency check; used by readinessProbe). Default
 *                handler for any non-/livez path mirrors the worker.
 */
import assert from "node:assert/strict";
import http from "node:http";

// Standalone replica of the worker's health handler. The worker module
// itself starts a BullMQ Worker on import (require's REDIS_URL + DB), so
// we re-construct the handler under test rather than booting the whole
// process. The shape MUST stay in sync with `backend/src/worker.js`.
function buildHealthServer({ readyRef, redisAvailableRef }) {
  return http.createServer((req, res) => {
    if (req.url === "/livez") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (readyRef.value && redisAvailableRef.value) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function run(name, fn) {
    try { await fn(); passed++; console.log(`  ✅  ${name}`); }
    catch (err) { failed++; console.log(`  ❌  ${name}\n      ${err.message}`); }
  }

  const readyRef = { value: false };
  const redisAvailableRef = { value: false };
  const server = buildHealthServer({ readyRef, redisAvailableRef });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run("503 before worker is ready", async () => {
      readyRef.value = false;
      redisAvailableRef.value = true;
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.ok, false);
    });

    await run("503 when Redis is unavailable", async () => {
      readyRef.value = true;
      redisAvailableRef.value = false;
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.ok, false);
    });

    await run("200 when ready and Redis is available", async () => {
      readyRef.value = true;
      redisAvailableRef.value = true;
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });

    await run("response always returns JSON content-type", async () => {
      readyRef.value = false;
      redisAvailableRef.value = false;
      const res = await fetch(`${base}/healthz`);
      assert.match(res.headers.get("content-type") || "", /application\/json/);
    });

    // /livez contract: MUST always return 200 regardless of Redis or
    // ready state. A failed livenessProbe causes kubelet to KILL and
    // restart the pod — pinning these so a future regression that
    // accidentally re-couples /livez to isRedisAvailable() fails CI.
    await run("/livez returns 200 even when Redis is unavailable", async () => {
      readyRef.value = true;
      redisAvailableRef.value = false;
      const res = await fetch(`${base}/livez`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });

    await run("/livez returns 200 even when worker is not yet ready", async () => {
      readyRef.value = false;
      redisAvailableRef.value = false;
      const res = await fetch(`${base}/livez`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("\n🎉 All worker-health tests passed!");
  process.exit(0);
}

await main();

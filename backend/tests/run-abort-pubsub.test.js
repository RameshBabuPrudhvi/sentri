/**
 * @module tests/run-abort-pubsub
 * @description CAP-002 Phase 2 (Prerequisite #5) — Redis pub/sub abort
 * channel coverage. Gated on `REDIS_URL` so CI without a real Redis still
 * passes (mirrors `compat-config-cache.test.js`).
 *
 * Why a real Redis is required: the publisher/subscriber relationship is
 * inherently cross-process. A single-process unit test that imports both
 * sides hits the self-echo guard and never invokes the handler — which is
 * the *correct* behaviour, but it doesn't exercise the cross-replica path
 * that motivated this prerequisite. Spinning up a second ioredis client
 * directly (rather than a second Node process) is the same compromise
 * `compat-config-cache.test.js` uses for its cross-process case.
 *
 * Three assertions:
 *
 *   1. **Cross-replica delivery** — a sibling publisher (different origin)
 *      sends a runId; the local subscriber's onAbort handler fires.
 *   2. **Self-echo suppression** — when this process calls
 *      `publishRunAbort(runId)` directly, the local handler does NOT fire.
 *      The local fast-path in `routes/runs.js` already aborted the
 *      controller; re-firing via the channel would be wasteful.
 *   3. **Malformed payload safety** — a publisher with garbage JSON or a
 *      missing runId must not crash the subscriber.
 */

import test from "node:test";
import assert from "node:assert/strict";

if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "error";

const channel = await import("../src/utils/runAbortChannel.js");
const redisClient = await import("../src/utils/redisClient.js");

async function makePublisher() {
  const { createRequire } = await import("module");
  const _require = createRequire(import.meta.url);
  const IORedis = _require("ioredis");
  const Redis = IORedis.default || IORedis;
  return new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
}

test("cross-replica: a sibling publish with a different origin invokes onAbort", async (t) => {
  if (!process.env.REDIS_URL || !redisClient.isRedisAvailable()) {
    t.skip("REDIS_URL not set — cross-process test requires Redis (run with REDIS_URL=redis://localhost:6379)");
    return;
  }

  channel.__resetForTest();
  const received = [];
  const subscribed = channel.subscribeToRunAborts({
    onAbort: (runId) => received.push(runId),
  });
  assert.equal(subscribed, true, "subscribe must succeed when Redis is available");

  // Subscribing is async under the hood — give the SUBSCRIBE round-trip a
  // moment to complete before publishing. Without this the publish can
  // race ahead of the subscriber being attached to the channel.
  await new Promise((r) => setTimeout(r, 100));

  const publisher = await makePublisher();
  try {
    const runId = `RUN-PUBSUB-${Date.now()}`;
    await publisher.publish(
      channel.RUN_ABORT_CHANNEL,
      JSON.stringify({ runId, origin: "inst_sibling_replica" }),
    );
    // Local round-trip is roughly milliseconds; 200ms is ample on any CI.
    await new Promise((r) => setTimeout(r, 200));

    assert.deepEqual(received, [runId], "sibling-origin publish must invoke onAbort exactly once with the runId");
  } finally {
    await publisher.quit().catch(() => {});
  }
});

test("self-echo: publishRunAbort from this process does NOT invoke local onAbort", async (t) => {
  if (!process.env.REDIS_URL || !redisClient.isRedisAvailable()) {
    t.skip("REDIS_URL not set");
    return;
  }

  channel.__resetForTest();
  const received = [];
  channel.subscribeToRunAborts({ onAbort: (runId) => received.push(runId) });
  await new Promise((r) => setTimeout(r, 100));

  const runId = `RUN-SELFECHO-${Date.now()}`;
  const published = await channel.publishRunAbort(runId);
  assert.equal(published, true, "publish must succeed when Redis is available");
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(received, [], "self-origin publish must not invoke local onAbort (route already did the local fast-path)");
});

test("malformed payload: garbage JSON / missing runId is silently ignored", async (t) => {
  if (!process.env.REDIS_URL || !redisClient.isRedisAvailable()) {
    t.skip("REDIS_URL not set");
    return;
  }

  channel.__resetForTest();
  const received = [];
  channel.subscribeToRunAborts({ onAbort: (runId) => received.push(runId) });
  await new Promise((r) => setTimeout(r, 100));

  const publisher = await makePublisher();
  try {
    // (a) outright garbage — invalid JSON
    await publisher.publish(channel.RUN_ABORT_CHANNEL, "not-json-at-all");
    // (b) valid JSON but missing runId
    await publisher.publish(channel.RUN_ABORT_CHANNEL, JSON.stringify({ origin: "inst_x" }));
    // (c) valid JSON with non-string runId
    await publisher.publish(channel.RUN_ABORT_CHANNEL, JSON.stringify({ runId: 42, origin: "inst_x" }));
    await new Promise((r) => setTimeout(r, 200));

    assert.deepEqual(received, [], "malformed payloads must not invoke onAbort and must not crash the subscriber");

    // Sanity: a *valid* sibling payload after the malformed ones still works —
    // i.e. the subscriber didn't get poisoned by the bad messages.
    const goodRunId = `RUN-AFTER-BAD-${Date.now()}`;
    await publisher.publish(
      channel.RUN_ABORT_CHANNEL,
      JSON.stringify({ runId: goodRunId, origin: "inst_sibling" }),
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(received, [goodRunId], "subscriber must keep working after malformed payloads");
  } finally {
    await publisher.quit().catch(() => {});
  }
});

test("subscribeToRunAborts requires a function handler", () => {
  assert.throws(() => channel.subscribeToRunAborts({ onAbort: "not-a-function" }), /must be a function/);
  assert.throws(() => channel.subscribeToRunAborts({}), /must be a function/);
});

test("publishRunAbort returns false on missing/invalid runId without throwing", async () => {
  // These return false regardless of Redis state — purely input validation.
  assert.equal(await channel.publishRunAbort(""), false);
  assert.equal(await channel.publishRunAbort(null), false);
  assert.equal(await channel.publishRunAbort(undefined), false);
  assert.equal(await channel.publishRunAbort(42), false);
});

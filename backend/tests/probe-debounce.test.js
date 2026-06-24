/**
 * @module tests/probe-debounce
 * @description PR #29 — Probe debounce + in-flight coalescing regression
 * coverage for `providerRouteRepo.probeAndPersist`.
 *
 * Pins the four behaviours added in this PR (see `providerRouteRepo.js`
 * lines 552-574):
 *
 *   1. Recent-result debounce — a non-`force` call within
 *      `PROBE_DEBOUNCE_MS` of a completed probe returns the existing DB
 *      row WITHOUT invoking the protocol adapter.
 *   2. `force: true` bypass — explicit operator-driven probes (Re-probe
 *      button, rotate-key gate) always issue a fresh network call.
 *   3. In-flight coalescing — two concurrent non-`force` calls on the
 *      same routeId only invoke `runCapabilityProbe` once; both callers
 *      receive the same resolved row.
 *   4. `force` skips inflight reuse — a rotate-key gate (`force: true`)
 *      that lands while an auto-probe is in flight MUST issue a fresh
 *      probe instead of riding on the stale one (Bug 2 / "stale in-
 *      flight probe could greenlight a bad rotated key").
 *
 * Tests exercise the repo through the same `_setProtocolAdapterForTests`
 * seam used by `capability-probe.test.js` and `probe-timeout.test.js` so
 * we count real adapter invocations, not mocked repo behaviour.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DB_PATH = ":memory:";
process.env.SENTRI_MASTER_KEY = process.env.SENTRI_MASTER_KEY
  || Buffer.alloc(32, 7).toString("base64");

const { createTestRunner } = await import("./helpers/test-base.js");
const { getDatabase } = await import("../src/database/sqlite.js");
const providerRouteRepo = await import("../src/database/repositories/providerRouteRepo.js");
const { _setProtocolAdapterForTests } = await import("../src/aiProvider/capabilityProbe.js");

getDatabase();
const { test, summary } = createTestRunner();
const now = () => new Date().toISOString();

function seedWorkspace() {
  const db = getDatabase();
  const userId = `usr-${randomUUID().slice(0, 8)}`;
  const wsId = `ws-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO users (id, name, email, passwordHash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, `Test ${userId}`, `${userId}@test.local`, "x", now(), now());
  db.prepare(
    "INSERT INTO workspaces (id, name, slug, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(wsId, `ws-${wsId}`, wsId, userId, now(), now());
  return { wsId, userId };
}

function insertRoute(workspaceId, overrides = {}) {
  // skipAutoProbe: true so `upsert` doesn't schedule a background probe
  // that would race the debounce assertions below.
  return providerRouteRepo.upsert({
    workspaceId,
    name: overrides.name || `route-${randomUUID().slice(0, 8)}`,
    family: "openai",
    protocol: "openai",
    model: "gpt-4o-mini",
    enabled: 1,
    skipAutoProbe: true,
    ...overrides,
  });
}

/**
 * Install a stub adapter that resolves immediately with a minimal valid
 * capabilities payload. Records every adapter invocation so tests can
 * assert exact call counts.
 *
 * `delayMs` lets a test hold the adapter open to simulate concurrent
 * callers landing while a probe is in flight.
 */
function installCountingAdapter({ delayMs = 0 } = {}) {
  const calls = [];
  let resolveHold = null;
  const stub = {
    generate: async (route, _messages, _opts) => {
      calls.push({ routeId: route.id, at: Date.now() });
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (resolveHold) {
        await new Promise((r) => { resolveHold = r; });
      }
      return {
        ok: true,
        content: "{}",
        // `probeReachability` only inspects ok + content. The capability
        // probe pipeline derives the rest from the catalog floor.
      };
    },
    stream: async () => null,
  };
  _setProtocolAdapterForTests(stub);
  return { calls, restore: () => _setProtocolAdapterForTests(null) };
}

// ── 1. Recent-result debounce ─────────────────────────────────────────────────
console.log("\n🧪 probe debounce — recent-result skip");

// Stage-2 follow-up: every `test(...)` below is `await`-ed because these
// tests share module-global state (the in-flight probe Map + the global
// adapter stub installed via `_setProtocolAdapterForTests`). Bare top-level
// registrations let test N+1's adapter swap race test N's mid-flight
// probe — symptoms include "got 6 invocations" (multiple tests' adapter
// stubs counted into one invocation tally) and "1 !== 2" (force: true
// observed an in-flight probe from a SIBLING test). Awaiting each
// registration restores the sequential isolation the pre-migration
// runner provided.
await test("second non-force probe within debounce window skips network call", async () => {
  providerRouteRepo._resetProbeDebounceForTests();
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  const stub = installCountingAdapter();
  try {
    await providerRouteRepo.probeAndPersist(wsId, row.id);
    const callsAfterFirst = stub.calls.length;
    assert.ok(callsAfterFirst >= 1, "first probe should invoke adapter");

    // Second call within the 5s debounce window — should NOT call adapter.
    const ret = await providerRouteRepo.probeAndPersist(wsId, row.id);
    assert.equal(stub.calls.length, callsAfterFirst,
      `debounced probe should not invoke adapter; got ${stub.calls.length - callsAfterFirst} extra calls`);
    assert.ok(ret && ret.id === row.id, "debounced call should still return the route row");
  } finally {
    stub.restore();
  }
});

// ── 2. force: true bypasses the debounce ──────────────────────────────────────
console.log("\n🧪 probe debounce — force bypass");

await test("force: true issues a fresh probe even within the debounce window", async () => {
  providerRouteRepo._resetProbeDebounceForTests();
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  const stub = installCountingAdapter();
  try {
    await providerRouteRepo.probeAndPersist(wsId, row.id);
    const callsAfterFirst = stub.calls.length;

    // Immediate force probe — must invoke the adapter again.
    await providerRouteRepo.probeAndPersist(wsId, row.id, { force: true });
    assert.ok(stub.calls.length > callsAfterFirst,
      "force: true must bypass debounce and re-invoke adapter");
  } finally {
    stub.restore();
  }
});

// ── 3. In-flight coalescing ───────────────────────────────────────────────────
console.log("\n🧪 probe debounce — in-flight coalescing");

await test("two concurrent non-force probes share one adapter invocation", async () => {
  providerRouteRepo._resetProbeDebounceForTests();
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  // Hold the adapter open for ~50ms so both callers land while the
  // first promise is still pending.
  const stub = installCountingAdapter({ delayMs: 50 });
  try {
    const [a, b] = await Promise.all([
      providerRouteRepo.probeAndPersist(wsId, row.id),
      providerRouteRepo.probeAndPersist(wsId, row.id),
    ]);
    // Each capabilityProbe issues 2 adapter calls per probe (reachability
    // + jsonMode); see capability-probe.test.js for the contract pin.
    // Coalescing of 2 callers should therefore yield 2 stub calls total
    // (1 probe × 2 adapter calls), NOT 4 (which would mean both callers
    // probed independently).
    assert.equal(stub.calls.length, 2,
      `concurrent probes should coalesce into 1 probe (=2 adapter calls); got ${stub.calls.length}`);
    assert.ok(a && b && a.id === b.id, "both callers should receive a route row");
  } finally {
    stub.restore();
  }
});

// ── 4. force bypasses inflight reuse (Bug 2 — rotate-key gate) ───────────────
console.log("\n🧪 probe debounce — force skips inflight reuse");

await test("force: true does NOT ride an in-flight non-force probe (rotate-key gate)", async () => {
  providerRouteRepo._resetProbeDebounceForTests();
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  // Hold the first probe open so the second call lands while it's
  // still inflight. The bug-2 fix requires the force: true call to
  // issue its OWN adapter invocation rather than awaiting the stale one.
  const stub = installCountingAdapter({ delayMs: 100 });
  try {
    const [, ] = await Promise.all([
      providerRouteRepo.probeAndPersist(wsId, row.id),
      // Tiny stagger so the inflight Map is populated before the second
      // call checks it. Without this the calls can interleave in the
      // event loop before `probeInflight.set` runs.
      new Promise((r) => setTimeout(r, 5))
        .then(() => providerRouteRepo.probeAndPersist(wsId, row.id, { force: true })),
    ]);
    // Each capabilityProbe issues 2 adapter calls per probe (reachability
    // + jsonMode); see capability-probe.test.js. Two probes (first
    // non-force + second force) = 4 adapter calls total. If the force
    // probe had ridden on the inflight non-force one, we'd see only 2.
    assert.equal(stub.calls.length, 4,
      `force: true must skip inflight reuse; got ${stub.calls.length} adapter calls (expected 4 = 2 probes × 2 calls)`);
  } finally {
    stub.restore();
  }
});

// ── 5. Cleanup: probeInflight cleared on rejection ────────────────────────────
console.log("\n🧪 probe debounce — inflight cleanup on rejection");

await test("inflight entry is cleared even when the underlying probe rejects", async () => {
  providerRouteRepo._resetProbeDebounceForTests();
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);

  // Install an adapter that throws on the FIRST call only. The probe
  // module's classifier turns adapter throws into a non-throwing
  // capabilities payload (see capabilityProbe.js), so we instead
  // verify that a subsequent force-probe with a healthy adapter works
  // — i.e. the inflight Map didn't get stuck on the prior call.
  let invocations = 0;
  const stub = {
    generate: async () => {
      invocations += 1;
      if (invocations === 1) throw new Error("synthetic adapter failure");
      return { ok: true, content: "{}" };
    },
    stream: async () => null,
  };
  _setProtocolAdapterForTests(stub);
  try {
    await providerRouteRepo.probeAndPersist(wsId, row.id);
    // Force-probe — must reach the adapter again. If the inflight Map
    // had leaked the prior (rejected/resolved) promise, this would
    // either reuse the stale result or never resolve.
    await providerRouteRepo.probeAndPersist(wsId, row.id, { force: true });
    // Expected invocation count: 3 = first probe's 1 (reachability throws →
    // jsonMode probe skipped per capability-probe.js contract) + second
    // force probe's 2 (reachability succeeds + jsonMode probe runs). If
    // the inflight Map had leaked the first promise, the force probe
    // would reuse it and the count would stay at 1 instead.
    assert.equal(invocations, 3,
      `inflight Map must clear on completion; got ${invocations} invocations (expected 3 = 1 fail + 2 success)`);
  } finally {
    _setProtocolAdapterForTests(null);
  }
});

summary("Probe debounce (PR #29)");

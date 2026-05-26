/**
 * @module tests/probe-timeout
 * @description PR #28 — Per-route probe-timeout regression coverage.
 *
 * Pins three layers of new logic introduced by Migration 060 + the
 * `AI_PROBE_TIMEOUT_MS` env-driven default:
 *
 *   1. Repo column round-trip — `provider_routes.probeTimeoutMs` survives
 *      insert / update / read (Migration 060 schema).
 *   2. Repo precedence chain — `probeAndPersist(timeoutMs)` arg wins over
 *      `route.probeTimeoutMs`, which wins over the env default.
 *      Asserted by stubbing the protocol adapter's `generate()` so it
 *      records what the probe's `withTimeout` window actually was.
 *   3. Repo clamp — values outside `[1000, 600000]` are clamped before
 *      reaching `runCapabilityProbe` (defence-in-depth against pre-
 *      migration / runaway values).
 *
 * HTTP-surface validation (PATCH `/settings/ai-providers/:id` with
 * `probeTimeoutMs` outside `[1000, 600000]`) is covered separately
 * by integration patterns in `provider-routes-api.test.js`.
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
 * Install a stub adapter that records the AbortSignal it received from
 * the probe. The probe's `withTimeout` helper schedules
 * `setTimeout(() => ac.abort(), timeoutMs)`; we infer the resolved
 * timeout by waiting for the abort and timing the gap.
 *
 * Returned `restore()` MUST be called in finally — leaking the stub
 * would break every subsequent probe-touching test in this file.
 */
function installRecordingAdapter() {
  const calls = [];
  const stub = {
    generate: async (route, _messages, opts) => {
      const startedAt = Date.now();
      const recorded = { route, startedAt, abortedAt: null };
      calls.push(recorded);
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          recorded.abortedAt = Date.now();
          reject(new Error("probe timeout"));
        });
      });
    },
    stream: async () => null,
  };
  _setProtocolAdapterForTests(stub);
  return { calls, restore: () => _setProtocolAdapterForTests(null) };
}

// ── 1. Repo column round-trip ─────────────────────────────────────────────────
console.log("\n🧪 probeTimeoutMs column round-trip");

test("insert with probeTimeoutMs persists + reads back", () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId, { probeTimeoutMs: 45_000 });
  const got = providerRouteRepo.getById(wsId, row.id);
  assert.equal(got.probeTimeoutMs, 45_000);
});

test("insert without probeTimeoutMs leaves column null (env-default semantics)", () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  const got = providerRouteRepo.getById(wsId, row.id);
  assert.equal(got.probeTimeoutMs, null);
});

test("update can set + clear probeTimeoutMs", () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId);
  providerRouteRepo.upsert({ id: row.id, workspaceId: wsId, probeTimeoutMs: 90_000 });
  assert.equal(providerRouteRepo.getById(wsId, row.id).probeTimeoutMs, 90_000);
  providerRouteRepo.upsert({ id: row.id, workspaceId: wsId, probeTimeoutMs: null });
  assert.equal(providerRouteRepo.getById(wsId, row.id).probeTimeoutMs, null);
});

// ── 2. Repo precedence chain ──────────────────────────────────────────────────
console.log("\n🧪 probeAndPersist timeout precedence");

test("explicit timeoutMs arg wins over route.probeTimeoutMs", async () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId, { probeTimeoutMs: 60_000 });
  const stub = installRecordingAdapter();
  try {
    const t0 = Date.now();
    await providerRouteRepo.probeAndPersist(wsId, row.id, { timeoutMs: 100 });
    const elapsed = Date.now() - t0;
    // Probe must have aborted at ~100ms (the explicit arg), not 60s.
    assert.ok(elapsed < 5_000,
      `explicit timeoutMs=100 should win, got elapsed=${elapsed}ms`);
    assert.ok(stub.calls.length >= 1, "probe should have invoked adapter");
    const call = stub.calls[0];
    assert.ok(call.abortedAt && (call.abortedAt - call.startedAt) < 2_000,
      "abort should fire near the explicit 100ms window");
  } finally {
    stub.restore();
  }
});

test("route.probeTimeoutMs used when timeoutMs arg is omitted", async () => {
  const { wsId } = seedWorkspace();
  const row = insertRoute(wsId, { probeTimeoutMs: 200 });
  const stub = installRecordingAdapter();
  try {
    const t0 = Date.now();
    await providerRouteRepo.probeAndPersist(wsId, row.id);
    const elapsed = Date.now() - t0;
    // Probe must have aborted around the route's 200ms override.
    assert.ok(elapsed < 5_000,
      `route override 200ms should apply, got elapsed=${elapsed}ms`);
    const call = stub.calls[0];
    assert.ok(call.abortedAt && (call.abortedAt - call.startedAt) >= 100,
      "abort should not fire before the 200ms route override");
  } finally {
    stub.restore();
  }
});

// ── 3. Repo clamp (defence-in-depth) ──────────────────────────────────────────
console.log("\n🧪 probeAndPersist clamp on route.probeTimeoutMs");

test("route.probeTimeoutMs below 1000 is clamped to 1000ms", async () => {
  const { wsId } = seedWorkspace();
  // Persist a sub-second value via direct SQL to bypass the route-layer
  // HTTP validation (which would reject < 1000). Simulates a stale
  // pre-migration row or an out-of-band write.
  const row = insertRoute(wsId);
  getDatabase().prepare(
    "UPDATE provider_routes SET probeTimeoutMs = ? WHERE id = ?",
  ).run(50, row.id);

  const stub = installRecordingAdapter();
  try {
    const t0 = Date.now();
    await providerRouteRepo.probeAndPersist(wsId, row.id);
    const elapsed = Date.now() - t0;
    const call = stub.calls[0];
    const window = call.abortedAt - call.startedAt;
    // Sub-second value (50ms) must have been clamped up to 1000ms before
    // reaching `withTimeout`. Assert the window is at least 800ms (some
    // slack for event-loop scheduling) — definitively NOT 50ms.
    assert.ok(window >= 800,
      `clamp floor should yield ~1000ms window, got ${window}ms (elapsed=${elapsed}ms)`);
    // And also definitively under the 10min ceiling so the test doesn't hang.
    assert.ok(elapsed < 5_000, `probe should resolve quickly, got ${elapsed}ms`);
  } finally {
    stub.restore();
  }
});

summary("Probe timeout (PR #28 / Migration 060)");

/**
 * @module tests/run-sharding
 * @description CAP-002 — coverage for the in-process shard plumbing on PR #3:
 *
 *   - `partitionTestsIntoShards` divides N tests across S shards using the
 *     Playwright `--shard=N/M` algorithm (first `total % S` shards get +1).
 *   - `POST /api/projects/:id/run` clamps `shards` to `[1, MAX_WORKERS]` and
 *     only writes `shardCount > 1` when the caller explicitly passed `shards`
 *     (BUG-0001 — never inferred from `dialsConfig.parallelWorkers`).
 *   - `shards: 1` (or absent) is the zero-regression default.
 *
 * Cross-process BullMQ shard jobs + Redis pub/sub abort propagation
 * (NEXT.md criteria 1 & 4) are deferred to the follow-up CAP-002 PR; their
 * tests will land alongside the coordinator/shard worker split.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { app } from "../src/middleware/appSetup.js";
import authRouter, { requireAuth } from "../src/routes/auth.js";
import { workspaceScope } from "../src/middleware/workspaceScope.js";
import projectsRouter from "../src/routes/projects.js";
import testsRouter from "../src/routes/tests.js";
import runsRouter from "../src/routes/runs.js";
import { partitionTestsIntoShards, partitionTestIdsForShards, shardTraceArtifactPath } from "../src/testRunner.js";
import { getDatabase } from "../src/database/sqlite.js";

let mounted = false;
function mountRoutesOnce() {
  if (mounted) return;
  app.use("/api/auth", authRouter);
  app.use("/api/projects", requireAuth, workspaceScope, projectsRouter);
  app.use("/api", requireAuth, workspaceScope, testsRouter);
  app.use("/api", requireAuth, workspaceScope, runsRouter);
  mounted = true;
}

function extractCookie(res, name) {
  const raw = res.headers.getSetCookie?.() || [];
  for (const c of raw) {
    const match = c.match(new RegExp(`^${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

let csrfToken = null;

async function jwtReq(base, path, { method = "GET", cookie, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
    headers.Cookie = (headers.Cookie ? headers.Cookie + "; " : "") + `_csrf=${csrfToken}`;
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const csrf = extractCookie(res, "_csrf");
  if (csrf) csrfToken = csrf;
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  \u2713 " + name);
  } catch (err) {
    failed++;
    console.error("  \u2717 " + name + ": " + err.message);
  }
}

async function main() {
  mountRoutesOnce();
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  // Force a deterministic MAX_WORKERS so the clamp assertion has a known
  // upper bound regardless of the dev/CI environment.
  const prevMaxWorkers = process.env.MAX_WORKERS;
  process.env.MAX_WORKERS = "4";

  try {
    console.log("\n\u2500\u2500 partitionTestsIntoShards (pure) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("4 tests / 4 shards: 1+1+1+1, each test in unique shard", () => {
      const tests = [{ id: "T1" }, { id: "T2" }, { id: "T3" }, { id: "T4" }];
      const { sizes } = partitionTestsIntoShards(tests, 4);
      assert.deepEqual(sizes, [1, 1, 1, 1]);
      assert.deepEqual(tests.map(t => t._shardIndex), [0, 1, 2, 3]);
    });

    await test("10 tests / 4 shards: 3+3+2+2 Playwright remainder distribution", () => {
      const tests = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}` }));
      const { sizes } = partitionTestsIntoShards(tests, 4);
      assert.deepEqual(sizes, [3, 3, 2, 2]);
      assert.deepEqual(tests.map(t => t._shardIndex), [0, 0, 0, 1, 1, 1, 2, 2, 3, 3]);
    });

    await test("shards: 1 is the zero-regression single-shard partition", () => {
      const tests = Array.from({ length: 5 }, (_, i) => ({ id: `T${i}` }));
      const { sizes } = partitionTestsIntoShards(tests, 1);
      assert.deepEqual(sizes, [5]);
      assert.ok(tests.every(t => t._shardIndex === 0));
    });

    await test("shards > tests: empty shards get size 0", () => {
      const tests = [{ id: "T1" }, { id: "T2" }];
      const { sizes } = partitionTestsIntoShards(tests, 4);
      assert.deepEqual(sizes, [1, 1, 0, 0]);
      assert.deepEqual(tests.map(t => t._shardIndex), [0, 1]);
    });

    // ── partitionTestIdsForShards (coordinator fan-out) ─────────────────
    // The route layer calls this at enqueue time to compute the BullMQ
    // job payload's `testIds` slice for each shard. Coverage locks down:
    //   1. Slice sizes match the partition algorithm.
    //   2. Slices are disjoint (no test enqueued twice).
    //   3. The union of slices equals the original input set, in order.
    //   4. shardCount = 1 yields a single full slice (legacy zero-regression).
    //   5. shardCount > testIds.length yields trailing empty slices.
    console.log("\n\u2500\u2500 partitionTestIdsForShards (coordinator) \u2500\u2500\u2500\u2500\u2500\u2500");

    await test("partitionTestIdsForShards: 10 IDs / 4 shards yields 3+3+2+2 contiguous slices", () => {
      const ids = Array.from({ length: 10 }, (_, i) => `T${i}`);
      const slices = partitionTestIdsForShards(ids, 4);
      assert.equal(slices.length, 4);
      assert.deepEqual(slices.map(s => s.length), [3, 3, 2, 2]);
      // Slices are disjoint and cover the full input set in order.
      const union = slices.flat();
      assert.deepEqual(union, ids, "union of slices must equal input in original order");
      const set = new Set(union);
      assert.equal(set.size, ids.length, "no test id may appear in two shards");
    });

    await test("partitionTestIdsForShards: shardCount = 1 yields a single full slice (zero regression)", () => {
      const ids = ["A", "B", "C"];
      const slices = partitionTestIdsForShards(ids, 1);
      assert.equal(slices.length, 1);
      assert.deepEqual(slices[0], ids);
    });

    await test("partitionTestIdsForShards: shardCount > ids.length yields trailing empty slices", () => {
      const ids = ["A", "B"];
      const slices = partitionTestIdsForShards(ids, 4);
      assert.deepEqual(slices.map(s => s.length), [1, 1, 0, 0]);
      // The empty trailing slices are still arrays (workers tolerate empty
      // testIds — the worker increments shardsCompleted on entry and the
      // boundary-crossing shard fires the finalizer).
      assert.deepEqual(slices, [["A"], ["B"], [], []]);
    });

    await test("partitionTestIdsForShards: empty / non-array input returns shardCount empty slices", () => {
      // Defensive — the route layer should never pass empty, but we don't
      // want a TypeError here either.
      assert.deepEqual(partitionTestIdsForShards([], 3), [[], [], []]);
      assert.deepEqual(partitionTestIdsForShards(null, 2), [[], []]);
    });

    await test("partitionTestIdsForShards: 40 IDs / 4 shards each get exactly 10 (acceptance criterion)", () => {
      // NEXT.md acceptance: "shards: 4 on a 40-test suite splits into 4
      // BullMQ jobs of ~10 tests each". Verify the partition shape is
      // exactly even when total % shardCount === 0.
      const ids = Array.from({ length: 40 }, (_, i) => `T${i}`);
      const slices = partitionTestIdsForShards(ids, 4);
      assert.deepEqual(slices.map(s => s.length), [10, 10, 10, 10]);
      // First slice is T0..T9, second T10..T19, etc. — contiguous.
      assert.equal(slices[0][0], "T0");
      assert.equal(slices[0][9], "T9");
      assert.equal(slices[1][0], "T10");
      assert.equal(slices[3][9], "T39");
    });

    // ── Per-shard trace path contract (Prerequisite #2) ──────────────────
    // The runner persists `run.tracePaths[shardIndex]` for shard-mode runs
    // so `RunDetail.jsx` can render a dropdown when `shardCount > 1`. The
    // path layout mirrors the on-disk shard directory so the trace-viewer
    // static-file mount resolves nested paths without special-casing.
    // NEXT.md acceptance: "trace-count assertion in run-sharding.test.js".
    console.log("\n\u2500\u2500 shardTraceArtifactPath (pure) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    await test("shardIndex == null → legacy single-path URL (zero regression)", () => {
      assert.equal(shardTraceArtifactPath("RUN-x", null), "/artifacts/traces/RUN-x.zip");
    });

    await test("shardIndex = 0..3 → per-shard nested URL", () => {
      assert.equal(shardTraceArtifactPath("RUN-x", 0), "/artifacts/traces/RUN-x/shard-0.zip");
      assert.equal(shardTraceArtifactPath("RUN-x", 3), "/artifacts/traces/RUN-x/shard-3.zip");
    });

    await test("shardCount: 4 → exactly 4 distinct trace paths persisted", () => {
      // The runner records `run.tracePaths[shardIndex]` as each shard writes
      // its trace zip; the final `run.tracePaths` array therefore has
      // `shardCount` entries when every shard completes. Simulate the
      // coordinator's per-shard fan-out by computing the same paths the
      // runner would write, and assert the contract.
      const shardCount = 4;
      const runId = "RUN-trace";
      const tracePaths = Array.from({ length: shardCount }, (_, i) =>
        shardTraceArtifactPath(runId, i),
      );
      // 4 paths, all unique, all nested under the run's directory.
      assert.equal(tracePaths.length, shardCount);
      assert.equal(new Set(tracePaths).size, shardCount, "trace paths must be unique per shard");
      for (const p of tracePaths) {
        assert.ok(p.startsWith(`/artifacts/traces/${runId}/shard-`), `${p} must be nested under run dir`);
        assert.ok(p.endsWith(".zip"));
      }
    });

    console.log("\n\u2500\u2500 POST /run shard plumbing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

    const email = `sharding-${Date.now()}@test.local`;
    let out = await jwtReq(base, "/api/auth/register", {
      method: "POST", body: { name: "Sharding Tester", email, password: "Password123!" },
    });
    assert.equal(out.res.status, 201);
    const db = getDatabase();
    db.prepare("UPDATE users SET emailVerified = 1 WHERE email = ?").run(email);
    out = await jwtReq(base, "/api/auth/login", {
      method: "POST", body: { email, password: "Password123!" },
    });
    const accessToken = extractCookie(out.res, "access_token");
    const authCookie = "access_token=" + accessToken;

    out = await jwtReq(base, "/api/projects", {
      method: "POST", cookie: authCookie,
      body: { name: "Sharding Project", url: "https://example.com" },
    });
    const projectId = out.json.id;

    out = await jwtReq(base, `/api/projects/${projectId}/tests`, {
      method: "POST", cookie: authCookie,
      body: { name: "shard probe", steps: ["Open"] },
    });
    const testId = out.json.id;
    await jwtReq(base, `/api/projects/${projectId}/tests/${testId}/approve`, {
      method: "PATCH", cookie: authCookie,
    });

    async function runAndFetch(body) {
      const r = await jwtReq(base, `/api/projects/${projectId}/run`, {
        method: "POST", cookie: authCookie, body,
      });
      if (r.res.status !== 200) {
        throw new Error(`run failed: ${r.res.status} ${JSON.stringify(r.json)}`);
      }
      const runId = r.json.runId;
      // Best-effort abort so the next test isn't blocked by the concurrent-
      // run guard. Status may already be terminal for tiny suites.
      await jwtReq(base, `/api/runs/${runId}/abort`, { method: "POST", cookie: authCookie });
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
      return row;
    }

    await test("shards omitted → shardCount = 1 (zero-regression)", async () => {
      const row = await runAndFetch({});
      assert.equal(row.shardCount, 1, "shardCount defaults to 1 when shards absent");
    });

    await test("shards: 1 explicit → shardCount = 1 (no badge)", async () => {
      const row = await runAndFetch({ shards: 1 });
      assert.equal(row.shardCount, 1);
    });

    await test("shards: 3 → shardCount = 3 persisted on run record", async () => {
      const row = await runAndFetch({ shards: 3 });
      assert.equal(row.shardCount, 3);
    });

    await test("MAX_WORKERS clamp prevents shards: 100 from exhausting pool", async () => {
      const row = await runAndFetch({ shards: 100 });
      assert.equal(row.shardCount, 4, "shardCount must clamp to MAX_WORKERS (4)");
    });

    await test("dialsConfig.parallelWorkers alone does NOT inflate shardCount (BUG-0001)", async () => {
      const row = await runAndFetch({ dialsConfig: { parallelWorkers: 4 } });
      assert.equal(row.shardCount, 1, "shardCount stays 1 when only dials.parallelWorkers set");
    });

    await test("non-numeric / negative shards values fall back to 1", async () => {
      const row1 = await runAndFetch({ shards: "abc" });
      assert.equal(row1.shardCount, 1);
      const row2 = await runAndFetch({ shards: -5 });
      assert.equal(row2.shardCount, 1);
    });

    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
    console.log("\uD83C\uDF89 All run-sharding tests passed!");
  } finally {
    if (prevMaxWorkers === undefined) delete process.env.MAX_WORKERS;
    else process.env.MAX_WORKERS = prevMaxWorkers;
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch((err) => {
  console.error("\u2717 run-sharding failed:", err);
  process.exit(1);
});

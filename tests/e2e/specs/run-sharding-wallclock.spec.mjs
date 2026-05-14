import { test, expect } from '../utils/playwright.mjs';
import { isReachable } from '../utils/environment.mjs';
/**
 * Wall-clock E2E coverage for CAP-002 — the headline acceptance criterion:
 * "shards: 4 on a 40-test suite completes in ~1/4 the wall-clock time of a
 * single-shard run". Skipped by default; runs only when the operator opts
 * in with `RUN_E2E_REAL_PLAYWRIGHT=true` AND a real Playwright harness is
 * up. The intent is to exercise the cross-process fan-out end-to-end
 * against real BullMQ workers + real Playwright browsers, not the mocked
 * page.route() pattern used by `run-sharding-ui.spec.mjs`.
 *
 * Why gated: the assertion requires (a) `MAX_WORKERS >= 4` so 4 shards
 * actually run concurrently, (b) Redis + BullMQ wired into the test
 * environment, (c) a Playwright target site that's deterministic-enough
 * for wall-clock timing to be meaningful (no AI calls, no flakey network).
 * None of those are true on the default CI matrix today; the gate keeps
 * this spec from blocking PRs while letting operators opt in once the
 * harness lands.
 *
 * Acceptance criterion (NEXT.md): wall-clock time for `shards: 4` on a
 * 40-test suite is at most 50% of the wall-clock time for `shards: 1` on
 * the same suite. The 50% threshold (rather than the theoretical 25%) is
 * a deliberate slack for browser-launch overhead, BullMQ enqueue latency,
 * and CI machine variance — passing means the cross-process speedup is
 * real, even if not perfectly linear.
 */
test.describe('Run sharding wall-clock (CAP-002)', () => {
  test.skip(
    process.env.RUN_E2E_REAL_PLAYWRIGHT !== 'true',
    'Set RUN_E2E_REAL_PLAYWRIGHT=true (with real BullMQ + Playwright harness up) to run wall-clock coverage.',
  );
  const password = 'Password123!';
  let projectId;
  let email;
  let approvedTestIds = [];
  test.beforeAll(async ({ request, baseURL }) => {
    const ok = await isReachable(`${baseURL}/login`);
    if (!ok) return;
    email = `qa-shards-wallclock-${Date.now()}@example.com`;
    await request.post('/api/auth/register', { data: { name: 'Wallclock QA', email, password } });
    await request.post('/api/auth/login', { data: { email, password } });
    const projectRes = await request.post('/api/v1/projects', {
      data: { name: 'Wallclock Project', url: 'https://example.com' },
    });
    if (!projectRes.ok()) return;
    projectId = (await projectRes.json()).id;
    // Seed 40 approved tests so the partition produces ~10 per shard at
    // shards: 4. Each test is a tiny `page.goto` + `expect(page).toHaveURL`
    // — fast enough that the test suite itself runs in seconds, but real
    // Playwright work that exercises the browser-launch overhead the
    // wall-clock assertion must survive.
    for (let i = 0; i < 40; i++) {
      const testRes = await request.post(`/api/v1/projects/${projectId}/tests`, {
        data: {
          name: `wallclock probe ${i}`,
          description: 'Seeded for CAP-002 wall-clock coverage',
          steps: ['Open'],
          playwrightCode:
            "test('wallclock', async ({ page }) => { await page.goto('https://example.com'); await expect(page).toHaveURL(/example/); });",
          priority: 'medium',
        },
      });
      if (testRes.ok()) {
        const { id } = await testRes.json();
        await request.patch(`/api/v1/projects/${projectId}/tests/${id}/approve`);
        approvedTestIds.push(id);
      }
    }
  });
  async function timedRun(request, body) {
    const t0 = Date.now();
    const res = await request.post(`/api/v1/projects/${projectId}/run`, { data: body });
    if (!res.ok()) throw new Error(`run failed to enqueue: ${res.status()}`);
    const { runId } = await res.json();
    // Poll until terminal. Cap at 5 minutes — anything beyond that points
    // at a real bug or a stuck harness, not a slow test.
    const deadline = t0 + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const statusRes = await request.get(`/api/v1/runs/${runId}`);
      if (statusRes.ok()) {
        const run = await statusRes.json();
        if (['completed', 'failed', 'aborted'].includes(run.status)) {
          return { runId, run, durationMs: Date.now() - t0 };
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`run ${runId} did not reach terminal state within 5min`);
  }
  test('shards: 4 wall-clock is ≤ 50% of shards: 1 on a 40-test suite', async ({ request }) => {
    test.skip(approvedTestIds.length < 40, 'Could not seed 40 approved tests — harness setup incomplete.');
    // Single-shard baseline.
    const single = await timedRun(request, { shards: 1 });
    expect(single.run.status, 'single-shard run must succeed').toBe('completed');
    // 4-shard fan-out.
    const sharded = await timedRun(request, { shards: 4 });
    expect(sharded.run.status, '4-shard run must succeed').toBe('completed');
    expect(sharded.run.shardCount, 'persisted shardCount must reflect the request').toBe(4);
    // Headline assertion — sharded wall-clock is ≤ 50% of single-shard.
    // The 50% threshold (rather than the theoretical 25%) is deliberate
    // slack for browser-launch + BullMQ overhead and CI variance.
    const ratio = sharded.durationMs / single.durationMs;
    console.log(`shards:1 = ${single.durationMs}ms, shards:4 = ${sharded.durationMs}ms (ratio=${ratio.toFixed(2)})`);
    expect(ratio, `shards:4 wall-clock (${sharded.durationMs}ms) must be ≤ 50% of shards:1 (${single.durationMs}ms)`).toBeLessThanOrEqual(0.5);
    // Aggregate stats from the 4-shard fan-out must equal the single-shard
    // baseline — the atomic primitives (incrementRunStats) compose without
    // lost writes even when 4 shards finish near-simultaneously.
    expect(sharded.run.passed + sharded.run.failed, 'sharded run must execute every approved test').toBe(40);
    expect(sharded.run.passed, 'sharded passed count matches single-shard baseline').toBe(single.run.passed);
    expect(sharded.run.failed, 'sharded failed count matches single-shard baseline').toBe(single.run.failed);
  });
  test('shards: 4 emits exactly 4 trace artifacts', async ({ request }) => {
    test.skip(approvedTestIds.length < 40, 'Could not seed 40 approved tests.');
    const sharded = await timedRun(request, { shards: 4 });
    expect(sharded.run.status).toBe('completed');
    // Per-shard trace contract: exactly 4 entries, all distinct, all under
    // the run-id directory. Sparse `null` slots are allowed (a shard that
    // crashed before flushing its trace), but a successful run must populate
    // every slot.
    expect(Array.isArray(sharded.run.tracePaths), 'run.tracePaths must be an array').toBe(true);
    expect(sharded.run.tracePaths.length, 'tracePaths length must equal shardCount').toBe(4);
    const populated = sharded.run.tracePaths.filter((p) => typeof p === 'string' && p.length > 0);
    expect(populated.length, 'every shard must populate its trace slot on a successful run').toBe(4);
    expect(new Set(populated).size, 'trace paths must be distinct per shard').toBe(4);
    for (const p of populated) {
      expect(p, `trace path ${p} must include the run id directory`).toContain(`/${sharded.runId}/shard-`);
    }
  });
});
